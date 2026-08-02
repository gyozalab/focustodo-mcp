# Focus To-Do MCP Server

MCP (Model Context Protocol) Server for [Focus To-Do (專注清單)](https://www.focustodo.cn/) — a Pomodoro timer + task management app.

讓 AI 助理（Claude Code、Claude Desktop）用自然語言讀寫你的 Focus To-Do 任務、補記番茄鐘、查專注統計。

> 本專案使用逆向工程取得的 Focus To-Do API，與官方無關聯。

## Tools (v2.0.0)

### 查詢

| Tool | 說明 |
|------|------|
| `focustodo_list_projects` | 列出所有清單與標籤 |
| `focustodo_list_tasks` | 列任務，可依清單/標籤/優先級/完成狀態/到期日篩選 |
| `focustodo_search_tasks` | 關鍵字搜尋名稱、標籤、備註 |
| `focustodo_get_task_detail` | 單一任務詳情（含子任務與番茄鐘記錄） |
| `focustodo_get_today_focus` | 今日總覽：已專注時間 + 今天到期 + 逾期未完成 |
| `focustodo_get_stats` | 專注統計，含清單分佈與每日長條圖 |
| `focustodo_refresh` | 強制重新同步（快取預設 60 秒自動更新） |

### 寫入

| Tool | 說明 |
|------|------|
| `focustodo_create_task` | 建任務，支援 `tasks` 陣列批次建立 |
| `focustodo_update_task` | 改名稱/優先級/到期日/標籤/所屬清單/備註 |
| `focustodo_complete_task` | 標記完成，支援 `taskIds` 批次，`uncomplete` 可反向 |
| `focustodo_delete_task` | 軟刪除，支援 `taskIds` 批次 |
| `focustodo_log_pomodoro` | 補記已完成的專注時段，同步累加任務番茄計數 |
| `focustodo_create_subtask` | 新增子任務（自動標記父任務 `hasSubtask`） |
| `focustodo_update_subtask` | 子任務改名 / 完成 / 刪除 |
| `focustodo_create_project` | 建立新清單或新標籤 |

所有寫入操作完成後會用獨立 clientId 跑 delta sync 向 server 驗證，回 ✅ 代表 server 真的持久化了。沒驗證到的項目**不會**回滾成舊值——「還沒看到」跟「被拒絕」是兩回事（見下方事故記錄），本地快取只標記失效，下次查詢直接向 server 要答案。

批次操作（`tasks` 陣列、`taskIds` 陣列）是一次 sync 推送全部、一次 delta 驗證全部，耗時與筆數幾乎無關（實測 6 筆 1.8 秒）。單筆全部失敗會 throw，部分失敗則逐項回報哪些過、哪些沒過。

## Setup

需要 Node 20.6+（`npm run dev` / `npm run selftest` 用原生 `--env-file` 讀 `.env`，沒有 dotenv 依賴）。

```bash
npm install
cp .env.example .env    # 填入 FOCUSTODO_ACCOUNT / FOCUSTODO_PASSWORD
npm run build
npm run selftest        # 驗證：純函式斷言 + 對真實 server 的建→改→刪循環 + HTTP 模式
```

正式跑 MCP 時帳密走設定檔的 `env` 區塊（見下），不經過 `.env`。

MCP 設定（Claude Code `.mcp.json` 或 Claude Desktop config）：

```json
{
  "mcpServers": {
    "focustodo": {
      "command": "node",
      "args": ["/path/to/focustodo-mcp/dist/index.js"],
      "env": {
        "FOCUSTODO_ACCOUNT": "your-email@example.com",
        "FOCUSTODO_PASSWORD": "your-password"
      }
    }
  }
}
```

### HTTP 模式（遠端部署）

設 `PORT` 環境變數則改跑 HTTP 模式（`/health` + `/mcp`），供 Zeabur 之類的平台部署後給 Claude.ai 連接。

⚠️ HTTP 模式**必須**同時設 `MCP_AUTH_TOKEN`，沒設會拒絕啟動。`/mcp` 能讀寫整個帳號的任務，而部署網址不是秘密（TLS 憑證透明度日誌會登記），沒有這道門等於把任務庫對公網全開。

```bash
node -e "console.log(require('crypto').randomUUID())"   # 產一個 token
```

Client 端需帶 `Authorization: Bearer <token>`。

時區跟著 process 走（`todayBounds()`、`formatDate()`），容器預設是 UTC，所以 Dockerfile 設了 `TZ=Asia/Taipei`。少了這行，台灣早上 8 點前的專注會全被算到前一天。

## Usage Examples

- 「列出我的 Blog 清單任務」
- 「今天做什麼」→ 今日專注 + 到期 + 逾期一次給
- 「這週我花最多時間在哪個清單？」
- 「把這五件事加到書寫 Output」→ 一次呼叫批次建立
- 「剛剛專注了 45 分鐘在寫文章那個任務，幫我補記」

## Technical Notes

- **API Base**: `https://app.hk1.focustodo.net/`
- **Auth**: Email + password → cookie session，過期自動重登
- **Sync**: 雙向全量同步 `POST /v64/sync`；`timestamp` 是 epoch ms，帶入即取該時點後的 delta
  - 寫入**只收完整物件**。送 `{id, name}` 這種 partial task 會被整批拒收（`status=-9`），
    拒絕是原子的、不留半套狀態。所以更新一定是「讀出來 → 改欄位 → 整包送回」，
    寫入前會強制刷新快取把競態視窗壓到一次往返（見 `freshData`）
  - `status`：`0`=成功、`-1`/`-2`=session 失效（自動重登重試）、`-9`=資料被拒收
- **Data model**
  - `type=1000` → 一般清單
  - `type=3000` → 標籤（任務的 `tags` 欄位存的是這些清單的 **ID**，不是文字。本 server 自動做名稱↔ID 轉換）
  - `type=4xxx / 5xxx` → App 內建的**智慧清單**（`PRJ_DEADLINE_OVERDUE`、`PRJ_TOMORROW`、`PRJ_PRIORITY_HIGH` 等），是動態篩選視圖不是容器，實測沒有任何任務歸屬其中。本 server 一律濾掉——留著的話 LLM 會以為可以往裡面建任務，而寫進 `id-priority-high` 的卡在 App 是看不到的
  - `state`：`0` = 正常，`-1` = 已刪除
  - `deadline`：當地時區當天 23:59:59.999。傳 `'2026-08-05'` 會正確轉換
- **快取**：60 秒 TTL，過期自動拉 delta。避免常駐的 MCP process 一直回傳啟動時的舊資料

### 收件匣與孤兒卡

沒指定清單的任務會落在收件匣（magic id `id-task-tasks`），App 看得到。

⚠️ 收件匣**不是**一個真的 project，`/v64/sync` 的 `projects` 陣列裡沒有它。本 server 在 enrich 時特別補上「收件匣」這個名稱，也接受用「收件匣 / 收件箱 / inbox」當 `projectName` 查詢。少了這層處理，落在收件匣的任務（本帳號 183 筆）在任何列表裡都顯示不出歸屬。

⚠️ 若 `projectId` 是**空字串**會變成「真孤兒」：server 上存在，但 App 任何視圖（清單、搜尋、收件匣）都不顯示，使用者無法操作。v2.0.0 起 `create_task` 一律 fallback 到收件匣，不會再產生孤兒；`list_tasks` / `search_tasks` 預設濾掉歷史殘留的孤兒卡（`includeOrphans: true` 才看得到）。

### 關於「anti-tampering 鎖」（已證實不存在）

v1.2.x 的 README 曾記載 server 對既有任務有 anti-tampering 鎖、MCP 只能讀與新建。**這個結論是錯的**，2026-08-02 完整追查後撤銷。

實際的事故鏈：

1. 2026-04-29 server 端寫入的**可見性**暫時延遲
2. v1.2.0 的 verify 推送後只等 1500ms，delta 沒看到就報 `server 沒收到`
3. 從這個錯誤訊息反推出「server 有 anti-tampering 鎖」
4. 佐證用的三個 probe **全部只測同一張卡**，而那張是最異常的樣本（`projectId=""` 的真孤兒）
5. fullSync 明明顯示寫入已生效，卻被「fullSync 只是 echo、不代表持久化」的理論駁回（當年的 probe 甚至印出了「anti-tampering 假設可能不對」的提示，仍被忽略）

追查證據：當年那張測試卡如今在 server 上是 `projectId="id-task-tasks"`、`isDeleted=true`、名稱帶 `[TEST-MARKER]`——**三個被判定為「遭拒絕」的寫入，最後全部落地了**。所謂的鎖從來不存在，只是寫入慢了一拍。

順帶更正另外兩個誤傳的細節：

- **delta sync 不會過濾「自己 push 的變動」**。實測同 client 同 clientId、異 client、新 clientId 四種組合都看得到。
- **fullSync 不是 echo artifact**，它回的就是持久層真實狀態。

現在的 verify 改成退避重試（600ms → 1.8s → 5.4s），且窮盡重試後的措辭是「無法確認」而非「被拒絕」，本地快取也只標記失效、不臆測結果。`npm run selftest` 有一項專門校準寫入可見延遲，server 變慢會被測出來，而不是再次被誤讀成 server 拒絕寫入。

## License

MIT
