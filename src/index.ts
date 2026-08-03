#!/usr/bin/env node
/**
 * Focus To-Do MCP Server
 * 讓 AI Agent 操控「專注清單」的任務和番茄鐘
 */
import { createServer } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FocusToDoAPI, parseDeadline, todayBounds, TYPE_TAG } from "./api.js";
import type { EnrichedTask } from "./types.js";

const account = process.env.FOCUSTODO_ACCOUNT;
const password = process.env.FOCUSTODO_PASSWORD;

if (!account || !password) {
  console.error(
    "缺少 FOCUSTODO_ACCOUNT / FOCUSTODO_PASSWORD。\n" +
    "MCP 設定請用 env 區塊傳入；本機開發用 npm run dev（會讀 .env）。"
  );
  process.exit(1);
}

/** API client 是跨連線共用的單例——快取（含 60 秒 TTL）要共享，
 *  否則每個 HTTP 請求都會各自拉一次 2MB 全量同步。 */
const api = new FocusToDoAPI(account, password);

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

const priorityLabels: Record<number, string> = { 0: "無", 1: "低", 2: "中", 3: "高" };

/** 任務單行摘要 */
function taskLine(t: EnrichedTask, withId = true): string {
  const status = t.isFinished ? "✅" : "⬜";
  const prio = t.priority > 0 ? ` [${priorityLabels[t.priority]}]` : "";
  const deadline = t.deadline ? ` 📅${formatDate(t.deadline)}` : "";
  const pomo = t.estimatePomoNum > 0 ? ` 🍅${t.actualPomoNum}/${t.estimatePomoNum}` : "";
  const tags = t.tagNames ? ` ${t.tagNames}` : "";
  const proj = t.projectName ? ` | ${t.projectName}` : "";
  return `${status} ${t.name}${prio}${pomo}${deadline}${tags}${proj}${withId ? `\n   id: ${t.id}` : ""}`;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** 錯誤結果。帶 isError 讓 client 分得出成功與失敗，而不是去 parse 訊息裡的 ❌。 */
function fail(t: string) {
  return { ...text(t), isError: true as const };
}

function failWith(error: unknown) {
  return fail(`❌ FocusTodo 錯誤：${error instanceof Error ? error.message : String(error)}`);
}

/**
 * tool 層的友善欄位 → server 欄位。
 * 只輸出有指定的欄位，所以 create（沒給就用預設）與 update（沒給就不改）共用同一份。
 * 傳空字串代表清除（deadline/reminderAt → 0）。
 */
function toServerFields(i: {
  deadline?: string;
  reminderAt?: string;
  pomodoroMinutes?: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (i.deadline !== undefined) out.deadline = i.deadline ? parseDeadline(i.deadline) : 0;
  if (i.reminderAt !== undefined) out.reminderDate = i.reminderAt ? parseDeadline(i.reminderAt) : 0;
  if (i.pomodoroMinutes !== undefined) out.pomodoroInterval = Math.round(i.pomodoroMinutes * 60);
  return out;
}

/** 批次寫入的回報。部分成功要講清楚哪些過、哪些沒過。 */
function batchReport(
  verb: string,
  r: { updated: { name: string }[]; failed: { id: string; reason: string }[] }
): string {
  const parts: string[] = [];
  if (r.updated.length) {
    parts.push(
      `✅ 已${verb} ${r.updated.length} 個（server 已確認）：\n` +
      r.updated.map((t) => "  · " + t.name).join("\n")
    );
  }
  if (r.failed.length) {
    parts.push(
      `❌ 失敗 ${r.failed.length} 個：\n` +
      r.failed.map((f) => `  · ${f.id.slice(0, 8)}… ${f.reason}`).join("\n")
    );
  }
  return parts.join("\n\n") || "沒有任何項目被處理";
}

/**
 * 每次呼叫產生一個獨立的 McpServer。
 *
 * 不能共用單例：SDK 的 `Protocol.connect` 一個實例只接受一個 transport，
 * 而 stateless 的 StreamableHTTPServerTransport 也拒絕跨請求重用
 * （"Stateless transport cannot be reused across requests"）。
 * HTTP 模式因此每個請求都要一組全新的 server + transport；
 * 共用的只有上面那個持有快取的 `api`。
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "focustodo", version: "2.0.0" });

  // ===== 查詢工具 =====

  server.tool(
    "focustodo_list_projects",
    "列出所有清單與標籤。建任務前若不確定清單名稱，先呼叫這個。",
    {},
    async () => {
      try {
        const projects = await api.getProjects();
        const lists = projects.filter((p) => p.type !== TYPE_TAG).sort((a, b) => a.order - b.order);
        const tags = projects.filter((p) => p.type === TYPE_TAG).sort((a, b) => a.order - b.order);
        let out = `📁 清單 (${lists.length})：\n`;
        out += lists.map((p) => `- ${p.name}  (id: ${p.id})`).join("\n");
        out += `\n\n🏷️ 標籤 (${tags.length})：\n`;
        out += tags.map((p) => `- #${p.name}  (id: ${p.id})`).join("\n");
        return text(out);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_list_tasks",
    "列出任務，可依清單、標籤、優先級、完成狀態、到期日篩選。查詢任務的主要工具 —— 使用者說「列出某某清單的任務」「某某清單有什麼」時用這個並傳 projectName。⚠️ 預設過濾「真孤兒」殭屍卡（projectId 為空、App 看不到），除錯才開 includeOrphans。",
    {
      projectName: z.string().optional().describe("清單或標籤名稱（模糊匹配，可只給部分文字）"),
      tag: z.string().optional().describe("只篩標籤"),
      priority: z.number().min(0).max(3).optional().describe("優先級：0=無, 1=低, 2=中, 3=高"),
      isFinished: z.boolean().optional().describe("true=已完成, false=未完成"),
      due: z.enum(["overdue", "today", "week"]).optional()
        .describe("到期日篩選：overdue=已逾期未完成、today=今天到期、week=未來七天內到期"),
      limit: z.number().optional().default(20).describe("最多顯示幾筆（預設 20）"),
      includeOrphans: z.boolean().optional().default(false)
        .describe("包含真孤兒殭屍卡（projectId 空字串、App 看不到）。除錯用。"),
    },
    async (params) => {
      try {
        const tasks = await api.getTasks(params);
        // 未完成優先。少了這道，長年累積的已完成任務會把待辦擠出前 20 名
        // ——長年使用的清單裡已完成往往佔絕大多數，未完成的剩個位數。
        const sorted = tasks.sort((a, b) => {
          if (a.isFinished !== b.isFinished) return a.isFinished ? 1 : -1;
          if (a.priority !== b.priority) return b.priority - a.priority;
          return b.creationDate - a.creationDate;
        });
        const limited = sorted.slice(0, params.limit);
        if (!limited.length) return text("沒有符合條件的任務。");
        return text(
          `找到 ${tasks.length} 個任務（顯示前 ${limited.length} 個）：\n\n` +
          limited.map((t) => taskLine(t)).join("\n\n")
        );
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_search_tasks",
    "用關鍵字搜尋任務名稱、標籤和備註。要列出整個清單的任務請改用 focustodo_list_tasks。",
    {
      query: z.string().describe("搜尋關鍵字"),
      includeFinished: z.boolean().optional().default(true).describe("是否包含已完成任務"),
      limit: z.number().optional().default(10).describe("最多顯示幾筆"),
    },
    async ({ query, includeFinished, limit }) => {
      try {
        const tasks = await api.getTasks(includeFinished ? {} : { isFinished: false });
        const q = query.toLowerCase();
        const matched = tasks
          .filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.tagNames?.toLowerCase().includes(q) ||
              t.remark?.toLowerCase().includes(q)
          )
          .sort((a, b) => b.creationDate - a.creationDate)
          .slice(0, limit);
        if (!matched.length) return text(`搜尋「${query}」沒有找到任務。`);
        return text(
          `搜尋「${query}」找到 ${matched.length} 個：\n\n` + matched.map((t) => taskLine(t)).join("\n\n")
        );
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_get_task_detail",
    "查看單一任務的完整詳情（含子任務和番茄鐘記錄）",
    { taskId: z.string().describe("任務 ID") },
    async ({ taskId }) => {
      try {
        const task = await api.getTaskById(taskId);
        if (!task) return fail(`找不到任務 ${taskId}`);

        const subtasks = await api.getSubtasks(taskId);
        const pomodoros = await api.getPomodoros({ taskId });
        const totalFocus = pomodoros.reduce((sum, p) => sum + p.interval, 0);

        let out = `📋 ${task.name}\n`;
        out += `狀態: ${task.isDeleted ? "已刪除" : task.isFinished ? "已完成" : "進行中"}\n`;
        out += `清單: ${task.projectName || "未分類"}\n`;
        out += `優先級: ${priorityLabels[task.priority]}\n`;
        out += `番茄: ${task.actualPomoNum}/${task.estimatePomoNum} (每個 ${task.pomodoroInterval / 60} 分鐘)\n`;
        out += `已專注: ${formatSeconds(totalFocus)}\n`;
        out += `到期日: ${formatDate(task.deadline)}\n`;
        out += `標籤: ${task.tagNames || "無"}\n`;
        out += `建立日期: ${formatDate(task.creationDate)}\n`;
        if (task.remark) out += `\n備註:\n${task.remark}\n`;

        if (subtasks.length) {
          out += `\n子任務 (${subtasks.length}):\n`;
          for (const s of subtasks.sort((a, b) => a.order - b.order)) {
            out += `  ${s.isFinished ? "✅" : "⬜"} ${s.name}  (id: ${s.id})\n`;
          }
        }
        if (pomodoros.length) {
          out += `\n最近 5 個番茄鐘:\n`;
          for (const p of pomodoros.sort((a, b) => b.endDate - a.endDate).slice(0, 5)) {
            out += `  🍅 ${formatDate(p.endDate)} - ${formatSeconds(p.interval)}${p.isManual ? "（手動補記）" : ""}\n`;
          }
        }
        return text(out);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_get_today_focus",
    "今日總覽：已專注時間、今天到期的任務、逾期未完成的任務。使用者問「今天做什麼」「今天專注多久」「有什麼逾期」時用這個。",
    {},
    async () => {
      try {
        const [focus, dueToday, overdue] = await Promise.all([
          api.getTodayFocus(),
          api.getTasks({ due: "today", isFinished: false }),
          api.getTasks({ due: "overdue", isFinished: false }),
        ]);

        let out = `📊 今日專注：${formatSeconds(focus.focusTime)}　🍅 ${focus.pomodoros} 個番茄\n`;
        if (focus.tasks.length) {
          out += `\n專注明細:\n`;
          for (const t of focus.tasks) {
            out += `  🍅 ${t.name} - ${formatSeconds(t.focusTime)} (${t.pomodoros} 個)\n`;
          }
        } else {
          out += `\n今天還沒有專注記錄。\n`;
        }

        out += `\n📅 今天到期 (${dueToday.length}):\n`;
        out += dueToday.length
          ? dueToday.map((t) => "  " + taskLine(t, false)).join("\n") + "\n"
          : "  無\n";

        out += `\n🔴 已逾期 (${overdue.length}):\n`;
        out += overdue.length
          ? overdue
              .sort((a, b) => a.deadline - b.deadline)
              .slice(0, 10)
              .map((t) => "  " + taskLine(t, false))
              .join("\n") + (overdue.length > 10 ? `\n  …還有 ${overdue.length - 10} 個` : "") + "\n"
          : "  無\n";

        return text(out);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_get_stats",
    "查詢專注統計（可按時間範圍和清單篩選），含每日分佈。",
    {
      period: z.enum(["today", "this_week", "this_month", "last_7_days", "last_30_days", "all"])
        .optional().default("this_week").describe("時間範圍"),
      projectName: z.string().optional().describe("清單或標籤名稱"),
      showDaily: z.boolean().optional().default(true).describe("是否顯示每日分佈"),
    },
    async (params) => {
      try {
        const now = new Date();
        let startDate: number | undefined;
        switch (params.period) {
          case "today":
            startDate = todayBounds().start;
            break;
          case "this_week": {
            const d = new Date(now);
            d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 週一為起點
            d.setHours(0, 0, 0, 0);
            startDate = d.getTime();
            break;
          }
          case "this_month":
            startDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            break;
          case "last_7_days":
            startDate = todayBounds().start - 6 * 86400000;
            break;
          case "last_30_days":
            startDate = todayBounds().start - 29 * 86400000;
            break;
        }

        const stats = await api.getStats({ startDate, projectName: params.projectName });

        let out = `📊 專注統計（${params.period}${params.projectName ? ` · ${params.projectName}` : ""}）\n\n`;
        out += `總專注時間: ${formatSeconds(stats.totalFocusTime)}\n`;
        out += `番茄鐘數: ${stats.totalPomodoros} 個\n`;
        out += `完成任務: ${stats.completedTasks} 個\n`;
        out += `待完成任務: ${stats.pendingTasks} 個\n`;

        if (stats.projectBreakdown.length) {
          out += `\n📁 清單時間分佈:\n`;
          for (const p of stats.projectBreakdown.slice(0, 10)) {
            out += `  ${p.name}: ${formatSeconds(p.focusTime)} (${p.pomodoros} 個番茄)\n`;
          }
        }
        if (params.showDaily && stats.dailyBreakdown.length) {
          const recent = stats.dailyBreakdown.slice(-14);
          const max = Math.max(...recent.map((d) => d.focusTime), 1);
          out += `\n📈 每日分佈（最近 ${recent.length} 天）:\n`;
          for (const d of recent) {
            const bar = "█".repeat(Math.max(1, Math.round((d.focusTime / max) * 20)));
            out += `  ${d.date} ${bar} ${formatSeconds(d.focusTime)}\n`;
          }
        }
        return text(out);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  // ===== 寫入工具 =====

  const taskInput = {
    name: z.string().describe("任務名稱"),
    projectName: z.string().optional()
      .describe("清單名稱。省略則落在收件匣。找不到會報錯，不會靜默丟失。"),
    tags: z.string().optional().describe("標籤名稱，逗號或空白分隔。必須是已存在的標籤。"),
    priority: z.number().min(0).max(3).optional().describe("優先級：0=無, 1=低, 2=中, 3=高"),
    estimatePomoNum: z.number().optional().describe("預估番茄數"),
    deadline: z.string().optional().describe("到期日（'2026-08-05' 會設成當天 23:59:59）"),
    remark: z.string().optional().describe("備註內容"),
    reminderAt: z.string().optional()
      .describe("提醒時間（ISO 格式，如 '2026-08-05T09:00'）。App 會在此時發通知。"),
    pomodoroMinutes: z.number().positive().optional()
      .describe("這個任務每個番茄鐘幾分鐘（預設 25）"),
  };

  server.tool(
    "focustodo_create_task",
    "新增任務。單筆填 name 等欄位；多筆一次建立請用 tasks 陣列（開工排本週時用這個，一次呼叫建完）。清單名稱找不到會直接報錯，不會變成 App 看不到的孤兒卡。",
    {
      ...taskInput,
      name: taskInput.name.optional(),
      tasks: z.array(z.object(taskInput)).optional().describe("批次建立多個任務"),
    },
    async ({ tasks, ...single }) => {
      try {
        const items = tasks?.length ? tasks : single.name ? [{ ...single, name: single.name }] : null;
        if (!items) return fail("❌ 請提供 name（單筆）或 tasks 陣列（批次）");

        const created = await api.createTasks(
          items.map(({ deadline, reminderAt, pomodoroMinutes, ...rest }) => ({
            ...rest,
            ...toServerFields({ deadline, reminderAt, pomodoroMinutes }),
          }))
        );

        const lines = created.map((t, i) => {
          const src = items[i];
          return `  ✅ ${t.name}${src.projectName ? ` → ${src.projectName}` : " → 收件匣"}\n     id: ${t.id}`;
        });
        return text(`已建立 ${created.length} 個任務：\n${lines.join("\n")}`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_update_task",
    "修改任務的名稱、優先級、到期日、提醒時間、標籤、所屬清單、備註、番茄長度。寫入後會向 server 驗證，回 ✅ 才代表真的更新了。",
    {
      taskId: z.string().describe("任務 ID"),
      name: z.string().optional().describe("新名稱"),
      projectName: z.string().optional().describe("搬到哪個清單（清單名稱）"),
      tags: z.string().optional().describe("新標籤（名稱，逗號分隔）。傳空字串清除標籤。"),
      priority: z.number().min(0).max(3).optional().describe("新優先級"),
      estimatePomoNum: z.number().optional().describe("新預估番茄數"),
      deadline: z.string().optional().describe("新到期日（'2026-08-05'，傳空字串清除）"),
      remark: z.string().optional().describe("新備註"),
      reminderAt: z.string().optional()
        .describe("新提醒時間（ISO 格式，如 '2026-08-05T09:00'，傳空字串清除）"),
      pomodoroMinutes: z.number().positive().optional().describe("這個任務每個番茄鐘幾分鐘"),
    },
    async ({ taskId, deadline, reminderAt, pomodoroMinutes, ...fields }) => {
      try {
        const updates: Record<string, unknown> = {
          ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
          ...toServerFields({ deadline, reminderAt, pomodoroMinutes }),
        };
        if (!Object.keys(updates).length) return fail("❌ 沒有指定任何要修改的欄位");

        const task = await api.updateTask(taskId, updates);
        if (!task) return fail(`找不到任務 ${taskId}`);
        return text(`✅ 已更新「${task.name}」（server 已確認）\n修改欄位: ${Object.keys(updates).join(", ")}`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_complete_task",
    "標記任務完成。可一次傳多個 taskIds 批次完成。寫入後向 server 驗證，回 ✅ 才代表真完成。",
    {
      taskId: z.string().optional().describe("任務 ID（單筆）"),
      taskIds: z.array(z.string()).optional().describe("任務 ID 陣列（批次）"),
      uncomplete: z.boolean().optional().default(false).describe("true = 反向操作，把已完成改回未完成"),
    },
    async ({ taskId, taskIds, uncomplete }) => {
      try {
        const ids = taskIds?.length ? taskIds : taskId ? [taskId] : [];
        if (!ids.length) return fail("❌ 請提供 taskId 或 taskIds");
        const r = uncomplete ? await api.uncompleteTasks(ids) : await api.completeTasks(ids);
        return text(batchReport(uncomplete ? "恢復未完成" : "完成", r));
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_delete_task",
    "刪除任務（軟刪除）。可一次傳多個 taskIds 批次刪除。寫入後向 server 驗證，回 ✅ 才代表真的刪了。",
    {
      taskId: z.string().optional().describe("任務 ID（單筆）"),
      taskIds: z.array(z.string()).optional().describe("任務 ID 陣列（批次）"),
    },
    async ({ taskId, taskIds }) => {
      try {
        const ids = taskIds?.length ? taskIds : taskId ? [taskId] : [];
        if (!ids.length) return fail("❌ 請提供 taskId 或 taskIds");
        return text(batchReport("刪除", await api.deleteTasks(ids)));
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_log_pomodoro",
    "補記一段已完成的專注時間到任務上，同時累加該任務的番茄計數。FocusTodo 沒有 server 端的「計時中」狀態，所以只能記錄已結束的專注（例如：忘了開計時器、或在別處專注完想補登）。",
    {
      taskId: z.string().describe("任務 ID"),
      minutes: z.number().positive().describe("專注了幾分鐘"),
      endedAt: z.string().optional().describe("結束時間（ISO 格式，如 '2026-08-02T15:30'）。省略則用現在。"),
      subtaskId: z.string().optional()
        .describe("記到哪個子任務（ID 從 focustodo_get_task_detail 取得）。省略則只記在父任務上。"),
    },
    async ({ taskId, minutes, endedAt, subtaskId }) => {
      try {
        const endDate = endedAt ? new Date(endedAt).getTime() : undefined;
        if (endedAt && Number.isNaN(endDate!)) return fail(`❌ 無法解析時間：${endedAt}`);
        const pomo = await api.logPomodoro({ taskId, minutes, endDate, subtaskId });
        const task = await api.getTaskById(taskId);
        return text(
          `✅ 已補記 ${formatSeconds(pomo.interval)} 專注到「${task?.name}」\n` +
          `結束時間: ${new Date(pomo.endDate).toLocaleString("zh-TW")}\n` +
          `該任務累計番茄: ${task?.actualPomoNum}`
        );
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_create_subtask",
    "為任務新增子任務（會自動把父任務標記為含子任務，否則 App 不顯示）",
    {
      taskId: z.string().describe("父任務 ID"),
      name: z.string().describe("子任務名稱"),
      estimatedPomoNum: z.number().optional().describe("預估番茄數"),
    },
    async (params) => {
      try {
        const subtask = await api.createSubtask(params);
        return text(`✅ 已建立子任務「${subtask.name}」\nid: ${subtask.id}`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_update_subtask",
    "修改子任務：改名、標記完成、刪除。子任務 ID 從 focustodo_get_task_detail 取得。",
    {
      subtaskId: z.string().describe("子任務 ID"),
      name: z.string().optional().describe("新名稱"),
      isFinished: z.boolean().optional().describe("true=完成, false=取消完成"),
      isDeleted: z.boolean().optional().describe("true=刪除"),
      estimatedPomoNum: z.number().optional().describe("新的預估番茄數"),
    },
    async ({ subtaskId, ...updates }) => {
      try {
        const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
        if (!Object.keys(clean).length) return fail("❌ 沒有指定任何要修改的欄位");
        const sub = await api.updateSubtask(subtaskId, clean);
        if (!sub) return fail(`找不到子任務 ${subtaskId}`);
        const what = sub.isDeleted ? "已刪除" : sub.isFinished ? "已完成" : "已更新";
        return text(`✅ 子任務「${sub.name}」${what}`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_create_project",
    "建立新清單或新標籤。建立前請確認使用者真的要新增分類 —— 大部分情況應該用既有清單。",
    {
      name: z.string().describe("清單名稱"),
      isTag: z.boolean().optional().default(false).describe("true = 建立標籤（type 3000），false = 建立一般清單"),
      color: z.string().optional().describe("顏色 hex（如 '#4A90D9'）"),
    },
    async (params) => {
      try {
        const p = await api.createProject(params);
        return text(`✅ 已建立${params.isTag ? "標籤" : "清單"}「${p.name}」\nid: ${p.id}`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_update_project",
    "清單或標籤改名、換顏色。收件匣與預設清單改不了。",
    {
      name: z.string().describe("目前的清單／標籤名稱（或 ID）"),
      newName: z.string().optional().describe("新名稱"),
      color: z.string().optional().describe("新顏色 hex（如 '#4A90D9'）"),
    },
    async ({ name, newName, color }) => {
      try {
        if (!newName && !color) return fail("❌ 請指定 newName 或 color");
        const p = await api.updateProject(name, { name: newName, color });
        return text(`✅ 已更新${p.type === TYPE_TAG ? "標籤" : "清單"}「${p.name}」（server 已確認）`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_delete_project",
    "刪除清單或標籤。⚠️ 清單裡若還有未完成的任務，必須用 moveTasksTo 指定它們要搬去哪 ——" +
    " server 刪清單時不會處理裡面的任務，直接刪會讓它們變成 App 看不到也救不回的孤兒。",
    {
      name: z.string().describe("要刪除的清單／標籤名稱（或 ID）"),
      moveTasksTo: z.string().optional()
        .describe("裡面的任務要搬去哪個清單（如 '收件匣'）。清單非空時必填。"),
    },
    async ({ name, moveTasksTo }) => {
      try {
        const r = await api.deleteProject(name, { moveTasksTo });
        const moved = r.movedTasks
          ? `\n先把 ${r.movedTasks} 個任務搬到「${r.movedTo}」`
          : "";
        return text(`✅ 已刪除「${r.project.name}」（server 已確認）${moved}`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  server.tool(
    "focustodo_refresh",
    "強制重新從 server 拉取最新資料。快取預設 60 秒自動更新，只有在剛用 App 改完東西、要立刻看到結果時才需要手動呼叫。",
    {},
    async () => {
      try {
        await api.refresh();
        const projects = await api.getProjects();
        const tasks = await api.getTasks({ isFinished: false });
        return text(`✅ 已同步：${projects.length} 個清單、${tasks.length} 個未完成任務`);
      } catch (error) {
        return failWith(error);
      }
    }
  );

  return server;
}

// ===== 啟動 =====

const PORT = process.env.PORT ? parseInt(process.env.PORT) : null;

if (PORT) {
  // HTTP 模式（供 Zeabur 部署，Claude.ai 透過 URL 連接）

  // /mcp 能讀寫整個帳號的任務。公開網址不是秘密（TLS 憑證透明度日誌會登記），
  // 所以這裡不給「沒設 token 就全開」的選項——寧可起不來，也不要靜默裸奔。
  const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
  if (!AUTH_TOKEN) {
    console.error(
      "HTTP 模式必須設定 MCP_AUTH_TOKEN（client 需帶 Authorization: Bearer <token>）。\n" +
      "產生方式：node -e \"console.log(require('crypto').randomUUID())\""
    );
    process.exit(1);
  }

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/mcp") {
        if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        // 每請求一組全新的 server + transport（理由見 buildServer）。
        // 兩者都要在回應結束後關掉，否則每個請求都漏一組物件。
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      // handler 裡任何漏接的 throw 都會變成 unhandled rejection 並終止 process
      console.error("請求處理失敗:", e);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    }
  });
  httpServer.listen(PORT, () => {
    console.error(`focustodo-mcp HTTP server running on port ${PORT}`);
  });
} else {
  // stdio 模式（Claude Code 本機使用）
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}
