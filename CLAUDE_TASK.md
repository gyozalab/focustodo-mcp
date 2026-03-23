# 任務：將 focustodo-mcp 部署到 Zeabur

## 已完成

- [x] `src/index.ts` — 已改為雙模式（HTTP + stdio），commit `40ca60a`
  - 有 `PORT` 環境變數 → HTTP server（`/health` + `/mcp`）
  - 無 `PORT` → stdio 模式（Claude Code 本機用）
  - import 路徑確認為 `@modelcontextprotocol/sdk/server/streamableHttp.js`
- [x] `Dockerfile` — 已建立（node:22-alpine, port 8080）
- [x] TypeScript 編譯通過
- [x] 本機 HTTP 模式測試通過（`curl /health` → `{"status":"ok"}`）
- [x] 已 push 到 GitHub

## 待完成：部署到 Zeabur

### 問題

Zeabur 已停用 shared cluster，需要先**租用 Server**才能建立專案。

### 下一步

1. 到 [Zeabur Dashboard](https://dash.zeabur.com) 租一台 Server（建議台北 tpe1 區域）
2. 用 Zeabur MCP 或 Dashboard 建立專案（region 填 `server-XXXXXXXX`）
3. 建立 service，上傳 codebase 或連結 GitHub repo
4. 設定環境變數：
   - `FOCUSTODO_ACCOUNT`
   - `FOCUSTODO_PASSWORD`
   - `PORT`（Zeabur 通常自動注入）
5. 部署成功後，將 `https://<your-zeabur-url>/mcp` 填入 Claude.ai → Settings → Integrations
