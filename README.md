# Focus To-Do MCP Server

繁體中文 | [English](README.en.md)

為 [Focus To-Do（專注清單）](https://www.focustodo.cn/) 打造的 MCP（Model Context Protocol）伺服器，讓 AI 助理（Claude Code、Claude Desktop 等）可以用自然語言操作你的番茄鐘任務。

> **起心動念：** Focus To-Do 一直沒有開放公開 API，所以我自己逆向工程做了這個 MCP，讓 AI 助理也能串接它。本專案與 Focus To-Do 官方無關，亦未獲其授權。

---

## ⚡ 快速設定

需要 Node.js 20.12 以上。

### 步驟一：Clone 並安裝

```bash
git clone https://github.com/gyozalab/focustodo-mcp.git
cd focustodo-mcp
npm install
npm run build
```

### 步驟二：加入 MCP 設定檔

將以下內容加入 Claude Code 的 `.mcp.json` 或 Claude Desktop 的設定檔：

```json
{
  "mcpServers": {
    "focustodo": {
      "command": "node",
      "args": ["/your/path/to/focustodo-mcp/dist/index.js"],
      "env": {
        "FOCUSTODO_ACCOUNT": "your-email@example.com",
        "FOCUSTODO_PASSWORD": "your-password"
      }
    }
  }
}
```

> 將 `/your/path/to/focustodo-mcp` 換成你實際的路徑，帳密填入你的 Focus To-Do 登入資訊。

完成後重啟 Claude，就可以開始用了。

---

## 使用範例

設定完成後，直接這樣問 AI：

- 「列出我的 Blog 清單任務」
- 「幫我加一個任務到書寫 Output：寫 AI 工具評測文章，3 顆番茄」
- 「把這五件事一次加到書寫 Output」
- 「這週我花最多時間在哪個清單？」
- 「今天我專注了多久？」
- 「剛剛專注了 45 分鐘在寫文章那個任務，幫我補記」

---

## 功能列表

### 查詢

| 工具 | 說明 |
|------|------|
| `focustodo_list_projects` | 列出所有清單與標籤 |
| `focustodo_list_tasks` | 列出任務（可依清單、標籤、優先度、狀態、到期日篩選）|
| `focustodo_search_tasks` | 依關鍵字搜尋名稱、標籤、備註 |
| `focustodo_get_task_detail` | 查看任務詳情（含子任務與番茄鐘紀錄）|
| `focustodo_get_today_focus` | 今日總覽：已專注時間 + 今天到期 + 逾期未完成 |
| `focustodo_get_stats` | 專注統計，含清單分佈與每日長條圖 |
| `focustodo_refresh` | 強制重新同步（快取預設 60 秒自動更新）|

### 寫入

| 工具 | 說明 |
|------|------|
| `focustodo_create_task` | 建立任務，支援 `tasks` 陣列批次建立 |
| `focustodo_update_task` | 改名稱／優先級／到期日／提醒／標籤／所屬清單／備註／番茄長度 |
| `focustodo_complete_task` | 標記完成，支援批次，`uncomplete` 可反向 |
| `focustodo_delete_task` | 軟刪除，支援批次 |
| `focustodo_log_pomodoro` | 補記已完成的專注時段，同步累加任務番茄計數 |
| `focustodo_create_subtask` | 新增子任務（自動標記父任務 `hasSubtask`）|
| `focustodo_update_subtask` | 子任務改名／完成／刪除／改預估番茄數 |
| `focustodo_create_project` | 建立新清單或標籤 |
| `focustodo_update_project` | 清單／標籤改名、換顏色 |
| `focustodo_delete_project` | 刪除清單／標籤（內含孤兒防護，見下）|

所有寫入完成後會用獨立 clientId 跑一次 delta sync 向 server 確認，回 ✅ 才代表真的持久化了。批次操作是一次推送、一次驗證，耗時與筆數幾乎無關。

---

## 遠端部署（HTTP 模式）

設定 `PORT` 環境變數就會改跑 HTTP 模式（提供 `/health` 與 `/mcp`），可部署到 Zeabur 之類的平台，供 Claude.ai 網頁版連接。

⚠️ HTTP 模式**必須**同時設定 `MCP_AUTH_TOKEN`，否則會拒絕啟動。`/mcp` 能讀寫整個帳號的任務，而部署網址並非秘密（TLS 憑證透明度日誌會登記），沒有這道門等於把任務庫對公網全開。Client 端需帶 `Authorization: Bearer <token>`。

```bash
node -e "console.log(require('crypto').randomUUID())"   # 產一個 token
```

另外，時區跟著執行環境走（「今天」的判定與日期顯示都是），容器預設為 UTC，所以 `Dockerfile` 設了 `TZ`。部署到其他時區的機器時記得跟著調整。

---

## 技術說明

- **API Base**：`https://app.hk1.focustodo.net/`
- **驗證方式**：Email + 密碼登入 → Cookie-based Session，過期自動重登
- **同步機制**：`POST /v64/sync` 雙向全量同步；`timestamp` 是 epoch ms，帶入即取該時點後的 delta
  - 寫入**只收完整物件**。送 `{id, name}` 這種 partial 會被整批拒收（`status=-9`），且拒絕是原子的、不留半套狀態。所以更新一律是「讀出來 → 改欄位 → 整包送回」
  - `status`：`0`=成功、`-1`/`-2`=session 失效（自動重登重試）、`-9`=資料被拒收
- **資料模型**：
  - `type=1000` → 一般清單
  - `type=3000` → 標籤（任務的 `tags` 欄位存的是這些清單的 **ID**，不是文字；本 server 自動做名稱↔ID 轉換）
  - `type=4xxx / 5xxx` → App 內建的智慧清單（`PRJ_DEADLINE_OVERDUE`、`PRJ_PRIORITY_HIGH` 等），是動態篩選視圖不是容器，本 server 一律濾掉——把任務建進去會變成 App 看不到的卡片
  - `state`：`0`=正常、`-1`=已刪除
  - `deadline`：當地時區當天 23:59:59.999，傳 `'2026-08-05'` 會正確轉換
- **快取**：60 秒 TTL，過期自動拉 delta。讀-改-寫的操作會先強制刷新，避免用舊值蓋掉你剛在 App 改的內容

### 收件匣與孤兒卡

沒指定清單的任務會落在收件匣（magic id `id-task-tasks`），App 看得到。

⚠️ 收件匣**不是**一個真的 project，`/v64/sync` 的 `projects` 陣列裡沒有它。本 server 在 enrich 時特別補上名稱，也接受用「收件匣 / 收件箱 / inbox」查詢。

⚠️ 若 `projectId` 是**空字串**會變成「真孤兒」：server 上存在，但 App 任何視圖都不顯示。因此 `create_task` 一律 fallback 到收件匣，列表與搜尋也預設濾掉歷史殘留的孤兒卡。

同樣的道理，**刪除清單時 server 不會處理裡面的任務**——它們的 `projectId` 會繼續指向已刪清單，變成看不到也救不回的孤兒。所以 `delete_project` 在清單非空時會要求用 `moveTasksTo` 指定任務去處，搬移全部成功才會刪清單。

### 關於寫入驗證

早期版本曾因為「推送後等 1.5 秒沒在 delta 看到」就判定 server 拒絕寫入，據此在文件裡寫下並不存在的「anti-tampering 鎖」。事後查證，那些被判定為遭拒的寫入其實全部都成功持久化了，只是 server 當時的寫入可見性延遲比較長。

現在的驗證改成退避重試（600ms → 1.8s → 5.4s），窮盡重試後的措辭是「無法確認」而非「被拒絕」，本地快取也只標記失效、不臆測結果。**「還沒看到」不等於「被拒絕」**，這是這個專案學到最貴的一課。

---

## 開發

```bash
npm run dev        # 用 tsx 直接跑（讀 .env）
npm run selftest   # 純函式斷言 + 對真實帳號的建→改→刪循環 + HTTP 模式迴歸
```

自測會在收件匣建立 `[MCP自測]` 開頭的卡片，跑完自動刪除（中途失敗也會在收尾統一清理）。需要在 `.env` 填入 `FOCUSTODO_ACCOUNT` 與 `FOCUSTODO_PASSWORD`。

---

## 授權

MIT
