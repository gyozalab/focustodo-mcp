# Focus To-Do MCP Server

**繁體中文** | [English](README.en.md)

MCP (Model Context Protocol) Server for [Focus To-Do (專注清單)](https://www.focustodo.cn/) — a Pomodoro timer + task management app.

This server enables AI assistants (Claude Code, Claude Desktop, etc.) to read and write your Focus To-Do tasks, query focus statistics, and manage your Pomodoro workflow via natural language.

> **Note:** This project uses reverse-engineered APIs from Focus To-Do. It is not affiliated with or endorsed by Focus To-Do.

## Features

| Tool | Description |
|------|-------------|
| `focustodo_list_projects` | List all projects and tag-based lists |
| `focustodo_list_tasks` | List tasks with filters (project, tag, priority, status) |
| `focustodo_search_tasks` | Search tasks by keyword |
| `focustodo_get_task_detail` | View task details including subtasks and pomodoro history |
| `focustodo_create_task` | Create a new task |
| `focustodo_update_task` | Update task properties |
| `focustodo_complete_task` | Mark a task as completed |
| `focustodo_delete_task` | Delete a task |
| `focustodo_create_subtask` | Add a subtask |
| `focustodo_get_today_focus` | Get today's focus time and sessions |
| `focustodo_get_stats` | Get focus statistics (by period and project) |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` with your Focus To-Do account credentials:

```
FOCUSTODO_ACCOUNT=your-email@example.com
FOCUSTODO_PASSWORD=your-password
```

### 3. Build

```bash
npm run build
```

### 4. Configure MCP

Add to your Claude Code `.mcp.json` or Claude Desktop config:

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

## Usage Examples

Once configured, you can ask your AI assistant:

- "列出我的 Blog 清單任務"
- "幫我加一個任務到書寫 Output：寫 AI 工具評測文章，3 顆番茄"
- "這週我花最多時間在哪個清單？"
- "今天我專注了多久？"

## Technical Notes

- **API Base**: `https://app.hk1.focustodo.net/`
- **Auth**: Email + password login → cookie-based session
- **Sync**: Full bidirectional sync via `POST /v64/sync`
- **Data Model**:
  - `type=1000` → Regular project/list
  - `type=3000` → Tag-based virtual list (tasks reference these via the `tags` field using project IDs)
- **Auto re-login**: Session expiry triggers automatic re-authentication

## License

MIT
