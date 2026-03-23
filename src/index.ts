#!/usr/bin/env node
/**
 * Focus To-Do MCP Server
 * 讓 AI Agent 操控「專注清單」的任務和番茄鐘
 */
import "dotenv/config";
import { createServer } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FocusToDoAPI } from "./api.js";

const account = process.env.FOCUSTODO_ACCOUNT;
const password = process.env.FOCUSTODO_PASSWORD;

if (!account || !password) {
  console.error("Missing FOCUSTODO_ACCOUNT or FOCUSTODO_PASSWORD in .env");
  process.exit(1);
}

const api = new FocusToDoAPI(account, password);

const server = new McpServer({
  name: "focustodo",
  version: "1.0.0",
});

// ===== Helper =====

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}小時${m}分鐘`;
  return `${m}分鐘`;
}

function formatDate(epochMs: number): string {
  if (!epochMs) return "無";
  return new Date(epochMs).toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

const priorityLabels: Record<number, string> = {
  0: "無",
  1: "低",
  2: "中",
  3: "高",
};

// ===== Tools =====

server.tool(
  "focustodo_list_projects",
  "列出所有清單（如：工作 Work、書寫 Output、Blog 等）",
  {},
  async () => {
    const projects = await api.getProjects();
    const lines = projects
      .sort((a, b) => a.order - b.order)
      .map((p) => {
        const typeLabel = p.type === 3000 ? "標籤" : "清單";
        return `- [${typeLabel}] ${p.name} (id: ${p.id})`;
      });
    return { content: [{ type: "text", text: `找到 ${projects.length} 個清單：\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "focustodo_list_tasks",
  "列出某個清單或標籤下的所有任務。這是查詢任務的主要工具 — 當使用者說「列出 Blog 任務」「書寫 Output 有什麼」等，請用此工具並傳入 projectName",
  {
    projectName: z.string().optional().describe("清單名稱（模糊匹配，如 'Blog'、'書寫'）"),
    tag: z.string().optional().describe("標籤（如 '#Blog'、'#iPAS AI 中級'）"),
    priority: z.number().min(0).max(3).optional().describe("優先級：0=無, 1=低, 2=中, 3=高"),
    isFinished: z.boolean().optional().describe("true=已完成, false=未完成"),
    limit: z.number().optional().default(20).describe("最多顯示幾筆（預設 20）"),
  },
  async (params) => {
    const tasks = await api.getTasks({
      projectName: params.projectName,
      tag: params.tag,
      priority: params.priority,
      isFinished: params.isFinished,
    });

    const sorted = tasks.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.creationDate - a.creationDate;
    });

    const limited = sorted.slice(0, params.limit);

    const lines = limited.map((t) => {
      const status = t.isFinished ? "✅" : "⬜";
      const prio = t.priority > 0 ? ` [${priorityLabels[t.priority]}]` : "";
      const deadline = t.deadline ? ` 📅${formatDate(t.deadline)}` : "";
      const pomo = t.estimatePomoNum > 0 ? ` 🍅${t.actualPomoNum}/${t.estimatePomoNum}` : "";
      const tags = (t as any).tagNames ? ` ${(t as any).tagNames}` : "";
      const proj = t.projectName ? ` | ${t.projectName}` : "";
      return `${status} ${t.name}${prio}${pomo}${deadline}${tags}${proj}\n   id: ${t.id}`;
    });

    return {
      content: [{
        type: "text",
        text: `找到 ${tasks.length} 個任務（顯示前 ${limited.length} 個）：\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

server.tool(
  "focustodo_get_task_detail",
  "查看單一任務的完整詳情（含子任務和番茄鐘記錄）",
  {
    taskId: z.string().describe("任務 ID"),
  },
  async ({ taskId }) => {
    const tasks = await api.getTasks({ includeDeleted: false });
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      return { content: [{ type: "text", text: `找不到任務 ${taskId}` }] };
    }

    const subtasks = await api.getSubtasks(taskId);
    const pomodoros = await api.getPomodoros({ taskId });

    const totalFocus = pomodoros.reduce((sum, p) => sum + p.interval, 0);

    let text = `📋 ${task.name}\n`;
    text += `狀態: ${task.isFinished ? "已完成" : "進行中"}\n`;
    text += `清單: ${task.projectName || "未分類"}\n`;
    text += `優先級: ${priorityLabels[task.priority]}\n`;
    text += `番茄: ${task.actualPomoNum}/${task.estimatePomoNum} (每個 ${task.pomodoroInterval / 60} 分鐘)\n`;
    text += `已專注: ${formatSeconds(totalFocus)}\n`;
    text += `到期日: ${formatDate(task.deadline)}\n`;
    text += `標籤: ${task.tags || "無"}\n`;
    text += `建立日期: ${formatDate(task.creationDate)}\n`;

    if (task.remark) {
      text += `\n備註:\n${task.remark}\n`;
    }

    if (subtasks.length > 0) {
      text += `\n子任務 (${subtasks.length}):\n`;
      for (const s of subtasks.sort((a, b) => a.order - b.order)) {
        text += `  ${s.isFinished ? "✅" : "⬜"} ${s.name}\n`;
      }
    }

    if (pomodoros.length > 0) {
      text += `\n最近 5 個番茄鐘:\n`;
      const recent = pomodoros.sort((a, b) => b.endDate - a.endDate).slice(0, 5);
      for (const p of recent) {
        text += `  🍅 ${formatDate(p.endDate)} - ${formatSeconds(p.interval)}\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "focustodo_create_task",
  "新增一個任務到指定清單",
  {
    name: z.string().describe("任務名稱"),
    projectName: z.string().optional().describe("清單名稱（如 'Blog'、'書寫 Output'）"),
    tags: z.string().optional().describe("標籤（如 '#Blog #iPAS'）"),
    priority: z.number().min(0).max(3).optional().describe("優先級：0=無, 1=低, 2=中, 3=高"),
    estimatePomoNum: z.number().optional().describe("預估番茄數"),
    deadline: z.string().optional().describe("到期日（ISO 格式如 '2026-03-29'）"),
    remark: z.string().optional().describe("備註內容"),
  },
  async (params) => {
    const deadline = params.deadline ? new Date(params.deadline).getTime() : undefined;

    const task = await api.createTask({
      name: params.name,
      projectName: params.projectName,
      tags: params.tags,
      priority: params.priority,
      estimatePomoNum: params.estimatePomoNum,
      deadline,
      remark: params.remark,
    });

    return {
      content: [{
        type: "text",
        text: `✅ 已建立任務「${task.name}」\nID: ${task.id}\n清單: ${params.projectName || "預設"}\n優先級: ${priorityLabels[params.priority ?? 0]}\n番茄數: ${params.estimatePomoNum ?? 0}`,
      }],
    };
  }
);

server.tool(
  "focustodo_update_task",
  "修改任務的名稱、優先級、到期日、標籤等",
  {
    taskId: z.string().describe("任務 ID"),
    name: z.string().optional().describe("新名稱"),
    tags: z.string().optional().describe("新標籤"),
    priority: z.number().min(0).max(3).optional().describe("新優先級"),
    estimatePomoNum: z.number().optional().describe("新預估番茄數"),
    deadline: z.string().optional().describe("新到期日（ISO 格式）"),
    remark: z.string().optional().describe("新備註"),
  },
  async (params) => {
    const updates: Record<string, unknown> = {};
    if (params.name !== undefined) updates.name = params.name;
    if (params.tags !== undefined) updates.tags = params.tags;
    if (params.priority !== undefined) updates.priority = params.priority;
    if (params.estimatePomoNum !== undefined) updates.estimatePomoNum = params.estimatePomoNum;
    if (params.deadline !== undefined) updates.deadline = new Date(params.deadline).getTime();
    if (params.remark !== undefined) updates.remark = params.remark;

    const task = await api.updateTask(params.taskId, updates);
    if (!task) {
      return { content: [{ type: "text", text: `找不到任務 ${params.taskId}` }] };
    }

    return {
      content: [{
        type: "text",
        text: `✅ 已更新任務「${task.name}」\n更新欄位: ${Object.keys(updates).join(", ")}`,
      }],
    };
  }
);

server.tool(
  "focustodo_complete_task",
  "將任務標記為已完成",
  {
    taskId: z.string().describe("任務 ID"),
  },
  async ({ taskId }) => {
    const task = await api.completeTask(taskId);
    if (!task) {
      return { content: [{ type: "text", text: `找不到任務 ${taskId}` }] };
    }
    return { content: [{ type: "text", text: `✅ 已完成任務「${task.name}」` }] };
  }
);

server.tool(
  "focustodo_delete_task",
  "刪除任務",
  {
    taskId: z.string().describe("任務 ID"),
  },
  async ({ taskId }) => {
    const task = await api.deleteTask(taskId);
    if (!task) {
      return { content: [{ type: "text", text: `找不到任務 ${taskId}` }] };
    }
    return { content: [{ type: "text", text: `🗑️ 已刪除任務「${task.name}」` }] };
  }
);

server.tool(
  "focustodo_create_subtask",
  "為任務新增子任務",
  {
    taskId: z.string().describe("父任務 ID"),
    name: z.string().describe("子任務名稱"),
    estimatedPomoNum: z.number().optional().describe("預估番茄數"),
  },
  async (params) => {
    const subtask = await api.createSubtask(params);
    return {
      content: [{
        type: "text",
        text: `✅ 已建立子任務「${subtask.name}」\nID: ${subtask.id}`,
      }],
    };
  }
);

server.tool(
  "focustodo_get_today_focus",
  "查詢今日的專注時間和番茄鐘記錄",
  {},
  async () => {
    const data = await api.getTodayFocus();
    let text = `📊 今日專注記錄\n\n`;
    text += `總專注時間: ${formatSeconds(data.focusTime)}\n`;
    text += `完成番茄鐘: ${data.pomodoros} 個\n\n`;

    if (data.tasks.length > 0) {
      text += `任務明細:\n`;
      for (const t of data.tasks) {
        text += `  🍅 ${t.name} - ${formatSeconds(t.focusTime)} (${t.pomodoros} 個番茄)\n`;
      }
    } else {
      text += `今天還沒有專注記錄。`;
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "focustodo_get_stats",
  "查詢專注統計（可按時間範圍和清單篩選）",
  {
    period: z.enum(["today", "this_week", "this_month", "all"]).optional().default("all").describe("時間範圍"),
    projectName: z.string().optional().describe("清單名稱（如 'Blog'）"),
  },
  async (params) => {
    let startDate: number | undefined;
    const now = new Date();

    switch (params.period) {
      case "today": {
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        startDate = today.getTime();
        break;
      }
      case "this_week": {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        weekStart.setHours(0, 0, 0, 0);
        startDate = weekStart.getTime();
        break;
      }
      case "this_month": {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        startDate = monthStart.getTime();
        break;
      }
    }

    const stats = await api.getStats({
      startDate,
      projectName: params.projectName,
    });

    let text = `📊 專注統計\n\n`;
    text += `總專注時間: ${formatSeconds(stats.totalFocusTime)}\n`;
    text += `番茄鐘數: ${stats.totalPomodoros} 個\n`;
    text += `已完成任務: ${stats.completedTasks} 個\n`;
    text += `待完成任務: ${stats.pendingTasks} 個\n`;

    if (stats.projectBreakdown.length > 0) {
      text += `\n📁 清單時間分佈:\n`;
      for (const p of stats.projectBreakdown.slice(0, 10)) {
        text += `  ${p.name}: ${formatSeconds(p.focusTime)} (${p.pomodoros} 個番茄)\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "focustodo_search_tasks",
  "用關鍵字搜尋任務名稱和備註。注意：如果要列出某個清單或標籤的所有任務，請改用 focustodo_list_tasks",
  {
    query: z.string().describe("搜尋關鍵字"),
    limit: z.number().optional().default(10).describe("最多顯示幾筆"),
  },
  async ({ query, limit }) => {
    const tasks = await api.getTasks();
    const queryLC = query.toLowerCase();
    const matched = tasks
      .filter((t) =>
        t.name.toLowerCase().includes(queryLC) ||
        (t as any).tagNames?.toLowerCase().includes(queryLC) ||
        t.remark?.toLowerCase().includes(queryLC)
      )
      .slice(0, limit);

    const lines = matched.map((t) => {
      const status = t.isFinished ? "✅" : "⬜";
      const proj = t.projectName ? ` | ${t.projectName}` : "";
      return `${status} ${t.name}${proj}\n   id: ${t.id}`;
    });

    return {
      content: [{
        type: "text",
        text: `搜尋「${query}」找到 ${matched.length} 個任務：\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// ===== 啟動 =====

const PORT = process.env.PORT ? parseInt(process.env.PORT) : null;

if (PORT) {
  // HTTP 模式（供 Zeabur 部署，Claude.ai 透過 URL 連接）
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
  // stdio 模式（Claude Code 本機使用）
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
