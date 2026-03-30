# Focus To-Do MCP Server

繁體中文 | [English](README.en.md)

為 [Focus To-Do（專注清單）](https://www.focustodo.cn/) 打造的 MCP（Model Context Protocol）伺服器——一款番茄鐘 + 任務管理 App。

透過這個伺服器，AI 助理（Claude Code、Claude Desktop 等）可以用自然語言讀寫你的任務、查詢專注統計，以及管理你的番茄鐘工作流。

> **起心動念：** Focus To-Do 一直沒有開放公開 API，所以我自己逆向工程做了這個 MCP，讓 AI 助理也能串接它。本專案與 Focus To-Do 官方無關，亦未獲其授權。

## 功能列表

| 工具 | 說明 |
|------|------|
| `focustodo_list_projects` | 列出所有專案與標籤清單 |
| `focustodo_list_tasks` | 列出任務（可依專案、標籤、優先度、狀態篩選）|
| `focustodo_search_tasks` | 依關鍵字搜尋任務 |
| `focustodo_get_task_detail` | 查看任務詳情（含子任務與番茄鐘紀錄）|
| `focustodo_create_task` | 建立新任務 |
| `focustodo_update_task` | 更新任務屬性 |
| `focustodo_complete_task` | 將任務標記為完成 |
| `focustodo_delete_task` | 刪除任務 |
| `focustodo_create_subtask` | 新增子任務 |
| `focustodo_get_today_focus` | 取得今日專注時間與番茄鐘次數 |
| `focustodo_get_stats` | 查詢專注統計（可依時段與專案篩選）|

## 安裝步驟

### 1. 安裝依賴套件

```bash
npm install
```

### 2. 設定帳號憑證

```bash
cp .env.example .env
```

編輯 `.env`，填入你的 Focus To-Do 帳號資訊：

```
FOCUSTODO_ACCOUNT=your-email@example.com
FOCUSTODO_PASSWORD=your-password
```

### 3. 建置

```bash
npm run build
```

### 4. 設定 MCP

在 Claude Code 的 `.mcp.json` 或 Claude Desktop 設定檔中加入：

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

## 使用範例

設定完成後，你可以這樣問 AI 助理：

- 「列出我的 Blog 清單任務」
- 「幫我加一個任務到書寫 Output：寫 AI 工具評測文章，3 顆番茄」
- 「這週我花最多時間在哪個清單？」
- 「今天我專注了多久？」

## 技術說明

- **API Base**：`https://app.hk1.focustodo.net/`
- **驗證方式**：Email + 密碼登入 → Cookie-based Session
- **同步機制**：透過 `POST /v64/sync` 進行雙向完整同步
- **資料模型**：
  - `type=1000` → 一般專案／清單
  - `type=3000` → 標籤虛擬清單（任務透過 `tags` 欄位以專案 ID 參照）
- **自動重新登入**：Session 過期時自動重新驗證

## 授權

MIT
