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

所有寫入操作完成後會用獨立 clientId 跑 delta sync 向 server 驗證，回 ✅ 代表 server 真的持久化了。

## Setup

```bash
npm install
cp .env.example .env    # 填入 FOCUSTODO_ACCOUNT / FOCUSTODO_PASSWORD
npm run build
npm run selftest        # 驗證：純函式斷言 + 對真實 server 的建→改→刪循環
```

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

設 `PORT` 環境變數則改跑 HTTP 模式（`/health` + `/mcp`），供 Zeabur 之類的平台部署後給 Claude.ai 連接。

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
- **Data model**
  - `type=1000` → 一般清單
  - `type=3000` → 標籤（任務的 `tags` 欄位存的是這些清單的 **ID**，不是文字。本 server 自動做名稱↔ID 轉換）
  - `state`：`0` = 正常，`-1` = 已刪除
  - `deadline`：當地時區當天 23:59:59.999。傳 `'2026-08-05'` 會正確轉換
- **快取**：60 秒 TTL，過期自動拉 delta。避免常駐的 MCP process 一直回傳啟動時的舊資料

### 收件匣與孤兒卡

沒指定清單的任務會落在收件匣（magic id `id-task-tasks`），App 看得到。

⚠️ 若 `projectId` 是**空字串**會變成「真孤兒」：server 上存在，但 App 任何視圖（清單、搜尋、收件匣）都不顯示，使用者無法操作。v2.0.0 起 `create_task` 一律 fallback 到收件匣，不會再產生孤兒；`list_tasks` / `search_tasks` 預設濾掉歷史殘留的孤兒卡（`includeOrphans: true` 才看得到）。

### 關於「無法修改既有任務」

v1.2.x 的 README 曾記載 server 對既有任務有 anti-tampering 鎖、MCP 只能讀與新建。**2026-08-02 實測已推翻**：4 種 client/timestamp 組合下的 update、complete、delete 全部寫入並持久化，番茄鐘與清單的建立、刪除同樣生效。

寫入驗證機制（v1.2.0 引入）予以保留 —— 寫入成功與否不該靠猜。

## License

MIT
