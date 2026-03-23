# 任務：將 focustodo-mcp 從 stdio 模式改為 HTTP/SSE 模式

## 背景

這個 MCP server 目前使用 `StdioServerTransport`，只能在 Claude Code 本機使用。
目標是改成支援 HTTP 模式，讓 Claude.ai 可以透過 URL 連接，並部署到 Zeabur。

---

## 現有架構（不要動）

- `src/api.ts` — FocusToDoAPI class，負責與 Focus To-Do 後端溝通，完全不需要修改
- `src/types.ts` — 型別定義，不需要修改
- `src/probe.ts` — 除錯用工具，不需要修改
- `src/index.ts` — MCP server 主程式，**這是唯一需要修改的檔案**

---

## 需要做的事

### 1. 修改 `src/index.ts`

將 transport 從 stdio 改為支援**兩種模式**：
- 有 `PORT` 環境變數 → 啟動 HTTP server（供 Zeabur 部署用）
- 沒有 `PORT` → 維持原本的 stdio 模式（Claude Code 繼續可用）

HTTP 模式使用 `@modelcontextprotocol/sdk` 內建的 `StreamableHTTPServerTransport`，
搭配 Node.js 原生 `http` 模組（不要加 express，保持零額外依賴）。

需要實作的端點：
- `POST /mcp` — 處理 MCP 請求（StreamableHTTPServerTransport 的標準路徑）
- `GET /health` — 回傳 `{ status: "ok" }` 供 Zeabur 健康檢查用

HTTP server 範例結構：

```typescript
import { createServer } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : null;

if (PORT) {
  // HTTP 模式
  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  httpServer.listen(PORT, () => {
    console.error(`focustodo-mcp HTTP server running on port ${PORT}`);
  });
} else {
  // stdio 模式（原本的）
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

> 注意：`StreamableHTTPServerTransport` 的 import 路徑請先確認 `@modelcontextprotocol/sdk` 版本，
> 目前版本是 `^1.12.1`，路徑可能是 `server/streamableHttp.js` 或 `server/http.js`，
> 請在 `node_modules` 中確認後再 import。

### 2. 新增 `Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install
COPY . .
RUN npm run build
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### 3. 確認 `package.json` 不需要額外依賴

不需要加 express 或任何新套件，`http` 是 Node.js 內建模組。

---

## 驗證方式

改完後，在本機測試 HTTP 模式：

```bash
FOCUSTODO_ACCOUNT=xxx FOCUSTODO_PASSWORD=xxx PORT=8080 npm run dev
# 另一個 terminal：
curl http://localhost:8080/health
# 預期回傳：{"status":"ok"}
```

stdio 模式應維持原本可用：

```bash
npm run dev
# 應正常啟動，等待 stdin 輸入
```

---

## 部署到 Zeabur

完成後，將 repo 連接到 Zeabur 並設定環境變數：
- `FOCUSTODO_ACCOUNT`
- `FOCUSTODO_PASSWORD`
- `PORT`（Zeabur 會自動注入，不需要手動設）

Zeabur 會自動偵測 Dockerfile 並部署。

部署成功後，將 `https://<your-zeabur-url>/mcp` 填入 Claude.ai → Settings → Integrations。

---

## 完成後回報

回到 Claude.ai 告知 HTTP server 的 URL，繼續進行 Claude.ai 的連接設定。
