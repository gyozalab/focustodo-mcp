# 任務：將 focustodo-mcp 部署到 Zeabur

## 已完成

- [x] `src/index.ts` — 已改為雙模式（HTTP + stdio），commit `40ca60a`
  - 有 `PORT` 環境變數 → HTTP server（`/health` + `/mcp`）
  - 無 `PORT` → stdio 模式（Claude Code 本機用）
  - import 路徑確認為 `@modelcontextprotocol/sdk/server/streamableHttp.js`
- [x] `Dockerfile` — 已建立（node:22-alpine, port 8080）
- [x] TypeScript 編譯通過
- [x] ~~本機 HTTP 模式測試通過（`curl /health`）~~ ← **這個「通過」是假的**
- [x] 已 push 到 GitHub

## 部署前修掉的三個阻斷問題（2026-08-02 review）

當時只 curl 了 `/health`，`/mcp` 從沒被測過第二次，所以下面第一項一直沒被發現：

1. **每個 `/mcp` 請求都對同一個 `McpServer` connect 新 transport** → SDK 丟
   `Already connected to a transport`，在 async handler 裡變成 unhandled rejection
   直接殺掉 process。**第一次 tool call 就整站掛掉**，連 `/health` 都沒了。
   已改成每請求一組 server + transport，並在 `res.on("close")` 關掉。
   `npm run selftest` 新增「連續 3 次請求都要活著」守著。
2. **`Dockerfile` 的 `COPY . .` 會把含明文帳密的 `.env` 烤進映像**。已加 `.dockerignore`。
   （順帶：原本的 `npm ci --omit=dev` 會讓 `npm run build` 找不到 tsc，改成裝完整依賴、
   build 完再 `npm prune --omit=dev`。）
3. **`/mcp` 無認證**，公網全開。已改成必填 `MCP_AUTH_TOKEN`，沒設就拒絕啟動。

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
   - `MCP_AUTH_TOKEN`（**必填**，沒設 server 會拒絕啟動；用
     `node -e "console.log(require('crypto').randomUUID())"` 產一個）
   - `PORT`（Zeabur 通常自動注入）
5. 部署成功後，將 `https://<your-zeabur-url>/mcp` 填入 Claude.ai → Settings → Integrations，
   並在 header 帶 `Authorization: Bearer <MCP_AUTH_TOKEN>`
6. 部署後先驗證**兩次以上**的 tool call（只測 `/health` 抓不到任何東西）
