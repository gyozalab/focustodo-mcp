# Focus To-Do MCP Server

[繁體中文](README.md) | **English**

MCP (Model Context Protocol) Server for [Focus To-Do (專注清單)](https://www.focustodo.cn/) — a Pomodoro timer + task management app.

This server enables AI assistants (Claude Code, Claude Desktop, etc.) to read and write your Focus To-Do tasks, query focus statistics, and manage your Pomodoro workflow via natural language.

> **Note:** Focus To-Do has never published a public API, so this MCP server is built on reverse-engineered endpoints. It is not affiliated with or endorsed by Focus To-Do.

---

## Quick Start

Requires Node.js 20.12 or later.

### 1. Clone and install

```bash
git clone https://github.com/gyozalab/focustodo-mcp.git
cd focustodo-mcp
npm install
npm run build
```

### 2. Configure MCP

Add to your Claude Code `.mcp.json` or Claude Desktop config:

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

Restart Claude and you're ready to go.

---

## Usage Examples

Once configured, just ask your AI assistant:

- "List my tasks in the blog project"
- "Add a task to Writing Output: draft the AI tool review, 3 pomodoros"
- "Add these five things to Writing Output at once"
- "Which project did I spend the most time on this week?"
- "How long did I focus today?"
- "I just focused 45 minutes on the writing task — log it for me"

---

## Features

### Read

| Tool | Description |
|------|-------------|
| `focustodo_list_projects` | List all projects and tags |
| `focustodo_list_tasks` | List tasks with filters (project, tag, priority, status, due date) |
| `focustodo_search_tasks` | Search names, tags and notes by keyword |
| `focustodo_get_task_detail` | Task details including subtasks and pomodoro history |
| `focustodo_get_today_focus` | Today's overview: focus time + due today + overdue |
| `focustodo_get_stats` | Focus statistics with per-project breakdown and daily chart |
| `focustodo_refresh` | Force a re-sync (cache refreshes every 60s by default) |

### Write

| Tool | Description |
|------|-------------|
| `focustodo_create_task` | Create tasks; pass a `tasks` array to batch-create |
| `focustodo_update_task` | Update name / priority / due date / reminder / tags / project / note / pomodoro length |
| `focustodo_complete_task` | Mark complete (batch supported; `uncomplete` reverses it) |
| `focustodo_delete_task` | Soft delete (batch supported) |
| `focustodo_log_pomodoro` | Log a finished focus session and bump the task's pomodoro count |
| `focustodo_delete_pomodoro` | Delete pomodoro records (for mistaken logs); the task's count is decremented too |
| `focustodo_create_subtask` | Add a subtask (auto-flags the parent's `hasSubtask`) |
| `focustodo_update_subtask` | Rename / complete / delete a subtask, or change its pomodoro estimate |
| `focustodo_create_project` | Create a project or tag |
| `focustodo_update_project` | Rename a project/tag or change its color |
| `focustodo_delete_project` | Delete a project/tag (with orphan protection, see below) |

Every write is followed by a delta sync using a separate clientId to confirm the server actually persisted it — a ✅ means it really landed. Batch operations push once and verify once, so wall-clock time is largely independent of item count.

---

## Remote Deployment (HTTP mode)

Setting the `PORT` environment variable switches the server to HTTP mode (exposing `/health` and `/mcp`), suitable for platforms like Zeabur so Claude.ai on the web can connect.

⚠️ HTTP mode **requires** `MCP_AUTH_TOKEN`; without it the server refuses to start. `/mcp` can read and write your entire account, and a deployment URL is not a secret (certificate transparency logs record it), so skipping auth would leave your task database open to the internet. Clients must send `Authorization: Bearer <token>`.

```bash
node -e "console.log(require('crypto').randomUUID())"   # generate a token
```

Note that time zone follows the runtime environment (both "today" calculations and date formatting). Containers default to UTC, which is why the `Dockerfile` sets `TZ` — adjust it when deploying to a machine in a different zone.

---

## Technical Notes

- **API Base**: `https://app.hk1.focustodo.net/`
- **Auth**: Email + password login → cookie-based session, re-authenticates automatically on expiry
- **Sync**: Full bidirectional sync via `POST /v64/sync`; `timestamp` is epoch ms — pass one to receive the delta since that moment
  - Writes **only accept complete objects**. Sending a partial like `{id, name}` gets the whole batch rejected (`status=-9`), and the rejection is atomic — no half-applied state. Updates are therefore always "read → modify fields → send the whole object back"
  - `status`: `0`=success, `-1`/`-2`=session expired (auto re-login and retry), `-9`=payload rejected
- **Data Model**:
  - `type=1000` → Regular project/list
  - `type=3000` → Tag (a task's `tags` field stores these projects' **IDs**, not text; this server translates names ↔ IDs for you)
  - `type=4xxx / 5xxx` → The app's built-in smart lists (`PRJ_DEADLINE_OVERDUE`, `PRJ_PRIORITY_HIGH`, etc.) are dynamic filtered views, not containers. This server filters them out — a task created into one becomes invisible in the app
  - `state`: `0`=active, `-1`=deleted
  - `deadline`: 23:59:59.999 local time on that day; passing `'2026-08-05'` converts correctly
- **Cache**: 60s TTL with automatic delta refresh. Read-modify-write operations force a refresh first, so they never overwrite changes you just made in the app

### Inbox and orphaned cards

Tasks with no project land in the Inbox (magic id `id-task-tasks`) and are visible in the app.

⚠️ The Inbox is **not** a real project — it never appears in the `projects` array from `/v64/sync`. This server injects the name during enrichment and accepts "收件匣 / 收件箱 / inbox" as a query target.

⚠️ A task whose `projectId` is an **empty string** becomes a true orphan: it exists on the server but shows up in no view in the app. `create_task` therefore always falls back to the Inbox, and list/search filter out any historical orphans by default.

Note also that **deleting a task does not delete its pomodoro records** — that focus time stays in your statistics, and "today's focus" will even show the deleted task's name. Use `delete_pomodoro` to remove them properly.

For the same reason, **deleting a project does not touch the tasks inside it** — their `projectId` keeps pointing at a deleted project, leaving them invisible and unrecoverable. So `delete_project` requires `moveTasksTo` when the project isn't empty, and only deletes the project after every task has been moved successfully.

### On write verification

An early version concluded that the server "silently rejects" writes because a delta sync 1.5 seconds after pushing didn't show the change, and documented a non-existent "anti-tampering lock" based on that. It turned out every write judged as rejected had in fact persisted — the server's write visibility was simply lagging that day.

Verification now uses exponential backoff (600ms → 1.8s → 5.4s), and after exhausting retries it reports "could not confirm" rather than "rejected"; the local cache is only invalidated, never rolled back on a guess. **"Not seen yet" is not the same as "rejected"** — the most expensive lesson this project has learned.

---

## Development

```bash
npm run dev        # run directly via tsx (reads .env)
npm run selftest   # pure-function assertions + create/update/delete cycle against the real API + HTTP mode regression
```

The self-test creates cards prefixed `[MCP自測]` in your Inbox and removes them when done (a final sweep cleans up after mid-run failures too). It needs `FOCUSTODO_ACCOUNT` and `FOCUSTODO_PASSWORD` in `.env`.

---

## License

MIT
