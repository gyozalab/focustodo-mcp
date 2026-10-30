#!/usr/bin/env bash
# focustodo-mcp → Hermes 自動同步（跑在 Hermes 所在主機的 crontab，每 15 分鐘）
#
# 給「沒有掛 MCP、而是讓技能腳本直接 import 一份 dist/api.js 單檔副本」的 Hermes 用。
# 讓那份副本自動跟著 GitHub main 走：
#   有新 commit → 用一次性 node 容器編譯 → 新檔先在容器裡試載入 → 換檔
#   → 用橋接腳本實際讀一次 → 失敗就換回舊檔。成功或失敗都用 Telegram bot 私訊通知。
#
# 用法：
#   hermes-sync.sh               例行檢查（cron 跑這個）
#   hermes-sync.sh --install     第一次安裝：clone、裝到 ~/bin、登記 crontab、發測試通知
#   hermes-sync.sh --notify-test 只測通知管道
#
# ⚠️ 這個 repo 是公開的：聊天編號、bot 所在的 profile、橋接腳本路徑都不寫在這裡，
# 放在主機本地的 ~/.focustodo-sync/config（KEY=VALUE，由本腳本 source）：
#   CHAT=<Telegram 聊天編號>
#   BOT_ENV=<容器內存 TELEGRAM_BOT_TOKEN 的 .env 路徑>
#   BRIDGE=<容器內的 focus_bridge.mjs 路徑>
#   NOTE_HOOK=<選填：通知送出後再呼叫的主機腳本，參數為「來源 訊息」>
# 第一次跑時若沒有 config，會試著從主機既有的 ~/bin/hermes-watchdog.sh 與容器內容自動產生。
#
# token 只從容器讀、經 stdin 給 curl，不出現在指令列。
# 容器內操作一律 -u hermes：用 root 寫會把檔案擁有者改成 root，Hermes 自己就讀不到了。
set -u
# 狀態目錄、紀錄、暫存編譯目錄都只給執行帳號讀：錯誤紀錄可能夾帶橋接腳本的輸出
umask 077
REPO_URL=https://github.com/gyozalab/focustodo-mcp
REPO="$HOME/focustodo-mcp"
STATE="$HOME/.focustodo-sync"
CONFIG="$STATE/config"
CONTAINER=hermes
TARGET=/opt/data/focustodo/api.js
# 暫存檔一定要 .js 結尾：Node 認副檔名，api.js.next 會被拒絕載入（2026-10-30 第一次同步就卡在這）
NEXT=/opt/data/focustodo/api.next.js
FOCUS_ENV=/opt/data/focustodo/.env
# 固定映像摘要：標籤 node:22-alpine 會被換掉，摘要不會
NODE_IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
# 允許部署的簽章公鑰（ssh-keygen allowed_signers 格式）。只放在主機上，不從 repo 讀
SIGNERS="$STATE/allowed_signers"
mkdir -p "$STATE"
chmod 700 "$STATE"
chmod 600 "$STATE"/*.log 2>/dev/null
ts() { date -u +%FT%TZ; }
log() { echo "$(ts) $*"; }
# hx 不接 stdin，hxi 才接：-i 會把呼叫端的 stdin（終端機、上層腳本）整個吃掉
hx() { docker exec -u hermes "$CONTAINER" sh -c "$1"; }
hxi() { docker exec -i -u hermes "$CONTAINER" sh -c "$1"; }

# 設定值的格式檢查：config 會被 source，值裡混進引號、換行或指令就會被執行
valid_config() {
  [[ "$CHAT" =~ ^-?[0-9]+$ ]] \
    && [[ "$BOT_ENV" =~ ^/opt/data/[A-Za-z0-9._/-]+$ ]] \
    && [[ "$BRIDGE" =~ ^/opt/data/[A-Za-z0-9._/-]+\.mjs$ ]] \
    && { [ -z "$NOTE_HOOK" ] || [[ "$NOTE_HOOK" =~ ^/[A-Za-z0-9._/-]+$ ]]; }
}

if [ ! -f "$CONFIG" ]; then
  wd="$HOME/bin/hermes-watchdog.sh"
  CHAT=$(sed -n 's/^CHAT=//p' "$wd" 2>/dev/null | head -n 1)
  BOT_ENV=$(grep -o '/opt/data/profiles/[^ ]*/\.env' "$wd" 2>/dev/null | head -n 1)
  # 橋接腳本要剛好一份，找到多份就不猜
  bridges=$(hx "find /opt/data/skills -name focus_bridge.mjs -path '*/scripts/*' 2>/dev/null")
  BRIDGE=""
  [ "$(printf '%s\n' "$bridges" | grep -c .)" = 1 ] && BRIDGE=$bridges
  NOTE_HOOK=""
  [ -x "$HOME/bin/ops-to-engineer.sh" ] && NOTE_HOOK="$HOME/bin/ops-to-engineer.sh"
  if valid_config; then
    printf 'CHAT=%s\nBOT_ENV=%s\nBRIDGE=%s\nNOTE_HOOK=%s\n' "$CHAT" "$BOT_ENV" "$BRIDGE" "$NOTE_HOOK" > "$CONFIG"
    chmod 600 "$CONFIG"
    log "已從主機既有設定產生 $CONFIG"
  else
    log "缺少 $CONFIG，也無法自動產生（CHAT=${CHAT:+有} BOT_ENV=${BOT_ENV:+有} BRIDGE=${BRIDGE:+有}），請手動建立"
    exit 1
  fi
fi
CHAT="" BOT_ENV="" BRIDGE="" NOTE_HOOK=""
# 當純文字讀，不 source：source 會先執行檔案內容，事後驗值擋不住已經跑掉的指令
while IFS='=' read -r key value || [ -n "$key" ]; do  # 最後一行沒換行也要讀到
  case "$key" in
    CHAT | BOT_ENV | BRIDGE | NOTE_HOOK) printf -v "$key" '%s' "$value" ;;
  esac
done < "$CONFIG"
valid_config || { log "$CONFIG 的值格式不對（CHAT 要是數字、路徑只能有英數與 ._/-），請檢查"; exit 1; }

# 只接受主機 allowed_signers 裡那把 SSH 金鑰的簽章。回傳 2＝主機沒裝公鑰、1＝沒簽或簽章不符
verify_signed() {
  [ -s "$SIGNERS" ] || return 2
  # 先擋掉非 SSH 簽章：verify-commit 對 PGP／X.509 會改走 gpg，主機上別的金鑰也可能過關
  git cat-file commit "$1" | grep -q '^gpgsig -----BEGIN SSH SIGNATURE-----' || return 1
  git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-commit "$1" >/dev/null 2>&1 || return 1
}

notify() {
  local tok code
  tok=$(docker exec "$CONTAINER" sh -c "grep '^TELEGRAM_BOT_TOKEN=' '$BOT_ENV' | cut -d= -f2-" 2>/dev/null)
  if [ -z "$tok" ]; then log "通知失敗：讀不到 token｜$1"; return; fi
  code=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$tok" \
    | curl -s -K - --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$1" -o /dev/null -w '%{http_code}')
  unset tok
  [ "$code" = "200" ] || log "通知失敗：HTTP $code｜$1"
  if [ -n "$NOTE_HOOK" ]; then "$NOTE_HOOK" note 番茄鐘同步 "$1" >/dev/null 2>&1; fi
  return 0
}

if [ "${1:-}" = "--notify-test" ]; then
  notify "🔧 測試：focustodo-mcp 有新版時，主機會自動更新 Hermes 用的番茄鐘程式，並由這個 bot 通知你。"
  exit 0
fi

if [ "${1:-}" = "--install" ]; then
  # 安裝也要過簽章：裝進 ~/bin 並排進 cron 的，只能是驗過簽章的那一版
  [ -d "$REPO/.git" ] || git clone -q "$REPO_URL" "$REPO" || { echo "clone 失敗"; exit 1; }
  cd "$REPO" || exit 1
  git fetch -q origin main || { echo "fetch 失敗"; exit 1; }
  head=$(git rev-parse origin/main)
  verify_signed "$head"
  case $? in
    0) ;;
    2) echo "缺少簽章公鑰 $SIGNERS，請先裝好再安裝"; exit 1 ;;
    *) echo "GitHub 上的最新版（${head:0:7}）沒有可信的簽章，不安裝"; exit 1 ;;
  esac
  git reset -q --hard "$head" || { echo "切換到 ${head:0:7} 失敗"; exit 1; }
  mkdir -p "$HOME/bin"
  git show "$head:deploy/hermes-sync.sh" > "$HOME/bin/focustodo-sync.sh.new" \
    && chmod 755 "$HOME/bin/focustodo-sync.sh.new" \
    && mv -f "$HOME/bin/focustodo-sync.sh.new" "$HOME/bin/focustodo-sync.sh" || { echo "安裝失敗"; exit 1; }
  rm -f "$STATE/failed_commit"
  line='*/15 * * * * $HOME/bin/focustodo-sync.sh >> $HOME/.focustodo-sync/sync.log 2>&1'
  if ! crontab -l 2>/dev/null | grep -qF 'focustodo-sync.sh'; then
    { crontab -l 2>/dev/null; echo "# focustodo-mcp 有新版就同步到 Hermes（每 15 分鐘，有變動才通知）"; echo "$line"; } | crontab -
  fi
  echo "已安裝：$(crontab -l | grep focustodo-sync.sh)"
  "$HOME/bin/focustodo-sync.sh" --notify-test
  echo "先跑一次例行檢查："
  "$HOME/bin/focustodo-sync.sh" 2>&1 | tee -a "$STATE/sync.log"
  exit 0
fi

# 同時只跑一份：cron 撞上手動執行時，第二份直接退出
exec 9>"$STATE/lock"
flock -n 9 || { log "上一輪還在跑，略過"; exit 0; }
BUILD=""
cleanup() {
  if [ -n "$BUILD" ]; then rm -rf "$BUILD"; fi
  if [ -n "$NOTE_HOOK" ]; then "$NOTE_HOOK" sync focustodo-sync "$STATE/sync.log" >/dev/null 2>&1; fi
}
trap cleanup EXIT

cd "$REPO" || { notify "🚨 番茄鐘同步失敗：找不到 $REPO，請重跑 --install"; exit 1; }
if ! git fetch -q origin main; then log "git fetch 失敗，下一輪再試"; exit 0; fi
remote=$(git rev-parse origin/main)
deployed=$(cat "$STATE/deployed_commit" 2>/dev/null || true)
live_sha=$(hx "sha256sum $TARGET 2>/dev/null" | cut -c1-64)
if [ "$remote" = "$deployed" ] && [ -n "$live_sha" ] && [ "$live_sha" = "$(cat "$STATE/deployed_sha" 2>/dev/null)" ]; then
  exit 0 # 已是最新，安靜結束
fi
# 同一版失敗過就等下一個 commit，不要每 15 分鐘重試一次、通知一次
if [ "$remote" = "$(cat "$STATE/failed_commit" 2>/dev/null)" ]; then
  exit 0
fi
# 失敗收尾：記下這一版、通知一次。修好推上新 commit 就會自動再試
give_up() {
  echo "$remote" > "$STATE/failed_commit"
  notify "$1
（這一版不會再重試；修好推上新版本後，15 分鐘內會自動再試）"
  exit 1
}

# 只部署有你簽章的 commit。這個 repo 是公開的，cron 又會自動執行 main 上的東西：
# 沒有這道門，任何能推 main 的帳號（含被盜的）都能在主機和 Hermes 容器裡跑程式。
# 簽章私鑰只在你的電腦上，偷走 GitHub 帳號也偽造不出來。
verify_signed "$remote"
case $? in
  0) ;;
  2) give_up "🚨 番茄鐘同步缺少簽章公鑰（$SIGNERS），為了安全不部署任何新版。" ;;
  *) give_up "🚨 GitHub 上的最新版（${remote:0:7}）沒有你的簽章，沒有部署，Hermes 繼續用舊版。如果是你自己推的，確認電腦上這個 repo 有開 commit 簽章；如果不是，有人動了你的 repo。" ;;
esac

# 之後每一步都釘在驗過的 $remote：origin/main 在這中間被改也影響不到
git reset -q --hard "$remote" && [ "$(git rev-parse HEAD)" = "$remote" ] \
  || give_up "🚨 番茄鐘同步切換到 ${remote:0:7} 失敗，沒有部署。"
# 腳本自己也跟著 repo 更新，下一輪生效。不管這輪成敗都要換：
# 舊版只在成功時才換，結果有 bug 的那份永遠失敗、也永遠換不掉自己。
# 先寫新檔再 rename：bash 正在讀的是舊檔，rename 不會影響這一輪。
git show "$remote:deploy/hermes-sync.sh" > "$STATE/sync-script.new" && [ -s "$STATE/sync-script.new" ] \
  || give_up "🚨 番茄鐘同步讀不到 ${remote:0:7} 的同步腳本，沒有部署。"
if ! cmp -s "$STATE/sync-script.new" "$HOME/bin/focustodo-sync.sh"; then
  chmod 755 "$STATE/sync-script.new" && mv -f "$STATE/sync-script.new" "$HOME/bin/focustodo-sync.sh" \
    || give_up "🚨 番茄鐘同步更新自己失敗，沒有部署。"
  log "同步腳本本身已更新，下一輪生效"
fi
rm -f "$STATE/sync-script.new"

log "開始編譯 $(git log -1 --format='%h %s')"
# 在乾淨副本裡編譯：git archive 只有版控裡的檔案，主機上任何 .env 之類都不會被掛進去。
# --ignore-scripts：套件的安裝腳本一律不跑，tsc 用不到它們
BUILD=$(mktemp -d "$STATE/build.XXXXXX")
git archive "$remote" | tar -x -C "$BUILD" || give_up "🚨 番茄鐘同步取出 ${remote:0:7} 的原始碼失敗，沒有部署。"
if ! docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
     -v "$BUILD:/app" -w /app "$NODE_IMAGE" sh -c "npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npx tsc" \
     > "$STATE/build.log" 2>&1; then
  log "編譯失敗"; tail -n 20 "$STATE/build.log"
  give_up "🚨 番茄鐘程式有新版（$(git log -1 --format=%h)），但主機上編譯失敗，Hermes 繼續用舊版。要人來看：~/.focustodo-sync/build.log"
fi
new_sha=$(sha256sum "$BUILD/dist/api.js" | cut -c1-64)

if [ "$new_sha" = "$live_sha" ]; then
  echo "$remote" > "$STATE/deployed_commit"; echo "$new_sha" > "$STATE/deployed_sha"
  log "Hermes 已經是這一版（$(git log -1 --format=%h)），只記錄狀態"
  exit 0
fi

# 新檔先放旁邊試載入：橋接腳本用到的方法缺一個就不換。
# 每一步都核對：傳檔或換檔默默失敗的話，煙霧測試讀到的是舊檔，卻會被記成「已部署」
in_box_sha() { hx "sha256sum $1 2>/dev/null" | cut -c1-64; }
hx "rm -f $NEXT"
hxi "cat > $NEXT" < "$BUILD/dist/api.js" && [ "$(in_box_sha "$NEXT")" = "$new_sha" ] \
  || { hx "rm -f $NEXT"; give_up "🚨 番茄鐘程式新版（${remote:0:7}）傳進容器時不完整，沒有換，Hermes 繼續用舊版。"; }
check=$(hx "node -e '
import(\"$NEXT\").then((m) => {
  const need = [\"login\",\"sync\",\"refresh\",\"freshData\",\"getProjects\",\"getTasks\",\"getPomodoros\",
    \"getTaskById\",\"getSubtasks\",\"createTasks\",\"updateTasks\",\"createSubtask\"];
  const miss = need.filter((k) => typeof m.FocusToDoAPI?.prototype[k] !== \"function\");
  console.log(miss.length ? \"缺少：\" + miss.join(\",\") : \"ok\");
}).catch((e) => console.log(\"載入失敗：\" + e.message));
'" 2>&1)
if [ "$check" != "ok" ]; then
  hx "rm -f $NEXT"
  log "新檔試載入沒過：$check"
  give_up "🚨 番茄鐘程式新版（$(git log -1 --format=%h)）跟 Hermes 的橋接腳本對不上（$check），沒有換，Hermes 繼續用舊版。"
fi

# 換回舊版並核對。換回也失敗時不能走 give_up：它會把這版記成「失敗過、不再重試」，
# Hermes 就卡在壞檔上沒人知道。所以直接發緊急通知、不留記錄，下一輪會再試、再喊一次。
rollback() {
  hx "rm -f $NEXT; cp -p $TARGET.prev $TARGET"
  if [ "$(in_box_sha "$TARGET")" = "$live_sha" ]; then
    give_up "$1，已換回舊版，Hermes 繼續用舊版。"
  fi
  log "換回舊版失敗：$1"
  notify "🆘 番茄鐘同步：$1，而且換回舊版也失敗了。Hermes 的番茄鐘功能可能壞了，要人立刻來看（備份在容器的 $TARGET.prev）。"
  exit 1
}

hx "cp -p $TARGET $TARGET.prev" && [ "$(in_box_sha "$TARGET.prev")" = "$live_sha" ] \
  || { hx "rm -f $NEXT"; give_up "🚨 番茄鐘同步備份舊版失敗，沒有換，Hermes 繼續用舊版。"; }
hx "mv $NEXT $TARGET" && [ "$(in_box_sha "$TARGET")" = "$new_sha" ] \
  || rollback "🚨 番茄鐘程式新版（${remote:0:7}）換檔失敗"

# 實際讀一次番茄鐘，走的是 Hermes 平常用的同一條路
start=$(date +%s%N)
since=$(( ($(date +%s) - 86400) * 1000 ))
smoke=$(echo "{\"op\":\"list\",\"since_ms\":$since}" | hxi "cd \$(dirname $BRIDGE) && set -a && . /opt/data/focustodo/.env && set +a && TZ=Asia/Taipei node $BRIDGE" 2>&1 \
  | hxi "node -e 'let s=\"\";process.stdin.on(\"data\",(d)=>s+=d).on(\"end\",()=>{try{const j=JSON.parse(s);console.log(j.ok?\"ok \"+j.tasks.length:\"錯誤 \"+j.error)}catch(e){console.log(\"輸出不是 JSON：\"+s.slice(0,200))}})'")
ms=$(( ($(date +%s%N) - start) / 1000000 ))

if [ "${smoke%% *}" != "ok" ]; then
  log "實測讀取失敗：$smoke"
  rollback "🚨 番茄鐘程式新版（${remote:0:7}）換上後實際讀取失敗（$smoke）"
fi

changes=$(git log --format='• %s' "${deployed:-HEAD~1}..HEAD" 2>/dev/null | head -n 5)
[ -n "$changes" ] || changes=$(git log -1 --format='• %s')
echo "$remote" > "$STATE/deployed_commit"; echo "$new_sha" > "$STATE/deployed_sha"
log "已更新到 $(git log -1 --format=%h)，實測讀到 ${smoke#ok } 張任務（${ms}ms）"
notify "✅ 番茄鐘程式已更新到 $(git log -1 --format=%h)，Hermes 換好了，實測讀取正常（${ms} 毫秒）。
這次的改動：
$changes

電腦上的 Claude Code 要重啟才會用新版（如果改動不是在那台電腦做的，先在 repo 裡跑 npm run update）。"
