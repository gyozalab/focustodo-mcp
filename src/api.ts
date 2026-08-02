/**
 * Focus To-Do API Client
 * 逆向自 Chrome 擴充功能 v7.1.1
 */
import { randomUUID } from "crypto";
import type {
  LoginResponse,
  SyncResponse,
  Credentials,
  Project,
  Task,
  Subtask,
  Pomodoro,
  EnrichedTask,
} from "./types.js";

const BASE_URL = "https://app.hk1.focustodo.net";
const CLIENT_NAME = "focustodo-mcp";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SYNC_RETRIES = 3;

/** 收件匣的 magic projectId。任務沒指定清單時落在這裡，App 的收件匣看得到。
 *  ⚠️ 若留空字串會變成「真孤兒」：server 上存在但 App 任何視圖都不顯示。 */
export const INBOX_PROJECT_ID = "id-task-tasks";

/** 本地快取存活時間。超過就重新拉 delta，避免 MCP 常駐後讀到過期資料。 */
const CACHE_TTL_MS = 60_000;

/** state 欄位語義（實測 1338 筆任務歸納）：0=正常、-1=已刪除 */
const STATE_ACTIVE = 0;
const STATE_DELETED = -1;

/** fetch with AbortController timeout */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把 'YYYY-MM-DD' 轉成「當地時區當天 23:59:59.999」——FocusTodo 的 deadline 慣例。
 *  帶時間的 ISO 字串則照原值解析。 */
export function parseDeadline(input: string): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input.trim());
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`無法解析日期：${input}`);
  if (dateOnly) {
    const [y, m, day] = input.trim().split("-").map(Number);
    return new Date(y, m - 1, day, 23, 59, 59, 999).getTime();
  }
  return d.getTime();
}

export class FocusToDoAPI {
  private creds: Credentials | null = null;
  private clientId = randomUUID();
  private syncTimestamp = 0;
  private lastFetchedAt = 0;
  private inFlightSync: Promise<SyncResponse> | null = null;

  // Cached data from last sync
  private _projects: Project[] = [];
  private _tasks: Task[] = [];
  private _subtasks: Subtask[] = [];
  private _pomodoros: Pomodoro[] = [];

  constructor(
    private account: string,
    private password: string
  ) {}

  /** 登入取得 session */
  async login(): Promise<void> {
    const body = new URLSearchParams({
      account: this.account,
      password: this.password,
      client: CLIENT_NAME,
    });

    const res = await fetchWithTimeout(`${BASE_URL}/v63/user/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: body.toString(),
    });

    const data = (await res.json()) as LoginResponse;
    if (data.status !== 0) {
      throw new Error(`Login failed: status=${data.status}`);
    }

    const setCookies = res.headers.getSetCookie?.() || [];
    const cookieStr = setCookies.map((c) => c.split(";")[0]).join("; ");

    this.creds = {
      cookies: cookieStr,
      acct: data.acct,
      name: data.name,
      pid: data.pid,
      uid: data.uid,
    };
  }

  /** 確保已登入，否則自動登入 */
  private async ensureAuth(): Promise<Credentials> {
    if (!this.creds) {
      await this.login();
    }
    return this.creds!;
  }

  /** 完整同步（拉取+推送）*/
  async sync(
    payload?: {
      projects?: Partial<Project>[];
      tasks?: Partial<Task>[];
      subtasks?: Partial<Subtask>[];
      pomodoros?: Partial<Pomodoro>[];
    },
    _retryCount = 0
  ): Promise<SyncResponse> {
    const creds = await this.ensureAuth();

    const body = new URLSearchParams({
      timestamp: String(this.syncTimestamp),
      clientId: this.clientId,
      client: CLIENT_NAME,
      projects: JSON.stringify(payload?.projects || []),
      tasks: JSON.stringify(payload?.tasks || []),
      subtasks: JSON.stringify(payload?.subtasks || []),
      pomodoros: JSON.stringify(payload?.pomodoros || []),
      schedules: "[]",
      acct: creds.acct,
      name: creds.name,
      pid: creds.pid,
      uid: creds.uid,
    });

    const res = await fetchWithTimeout(`${BASE_URL}/v64/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: creds.cookies,
      },
      body: body.toString(),
    });

    const data = (await res.json()) as SyncResponse;

    if (data.status !== 0) {
      // Session expired — re-login and retry (with limit to prevent infinite loop)
      if ((data.status === -1 || data.status === -2) && _retryCount < MAX_SYNC_RETRIES) {
        this.creds = null;
        const backoffMs = Math.min(1000 * 2 ** _retryCount, 8000) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoffMs));
        return this.sync(payload, _retryCount + 1);
      }
      throw new Error(`Sync failed: status=${data.status} (after ${_retryCount} retries)`);
    }

    // Update session cookie if returned
    if (data.jsessionId) {
      const parts = creds.cookies.split("; ").filter((p) => !p.startsWith("JSESSIONID="));
      parts.push(`JSESSIONID=${data.jsessionId}`);
      creds.cookies = parts.join("; ");
    }

    // Merge data into cache
    this.mergeData(data);
    this.syncTimestamp = data.timestamp;
    this.lastFetchedAt = Date.now();

    return data;
  }

  /** 將 server 回傳的資料合併到本地快取 */
  private mergeData(data: SyncResponse) {
    if (data.projects?.length) {
      this.mergeArray(this._projects, data.projects);
    }
    if (data.tasks?.length) {
      this.mergeArray(this._tasks, data.tasks);
    }
    if (data.subtasks?.length) {
      this.mergeArray(this._subtasks, data.subtasks);
    }
    if (data.pomodoros?.length) {
      this.mergeArray(this._pomodoros, data.pomodoros);
    }
  }

  private mergeArray<T extends { id: string }>(cache: T[], incoming: T[]) {
    for (const item of incoming) {
      const idx = cache.findIndex((c) => c.id === item.id);
      if (idx >= 0) {
        cache[idx] = item;
      } else {
        cache.push(item);
      }
    }
  }

  /**
   * 確保快取新鮮。首次做全量同步，之後每 CACHE_TTL_MS 拉一次 delta。
   * 沒有這層 TTL 的話，常駐的 MCP process 會一直吐第一次啟動時的舊資料
   * ——使用者在 App 改的東西完全看不到。
   */
  private async ensureData(): Promise<void> {
    const stale =
      this._projects.length === 0 || Date.now() - this.lastFetchedAt > CACHE_TTL_MS;
    if (!stale) return;

    // 併發去重：get_today_focus 之類的工具會 Promise.all 併發查詢，
    // 沒有這道閘門的話冷啟動時每個併發呼叫都會各拉一次 2MB 全量同步。
    if (!this.inFlightSync) {
      this.inFlightSync = this.sync().finally(() => {
        this.inFlightSync = null;
      });
    }
    await this.inFlightSync;
  }

  /** 強制重新整理快取（寫入後或使用者明確要求最新狀態時用） */
  async refresh(): Promise<void> {
    this.lastFetchedAt = 0;
    await this.ensureData();
  }

  // ===== 清單／標籤解析 =====

  /** 依名稱模糊找清單（優先完全相符，其次包含）。收件匣不是真 project，特別處理。 */
  private findProject(name: string): Project | undefined {
    const lc = name.toLowerCase().replace(/^#/, "");
    if (["收件匣", "收件箱", "inbox"].includes(lc)) {
      return {
        id: INBOX_PROJECT_ID, name: "收件匣", color: "", type: 1000, order: 0,
        isDefault: true, isDeleted: false, state: STATE_ACTIVE, parentId: "", creationDate: 0,
      };
    }
    const alive = this._projects.filter((p) => !p.isDeleted);
    return (
      alive.find((p) => p.name.toLowerCase() === lc) ||
      alive.find((p) => p.name.toLowerCase().includes(lc))
    );
  }

  /** 同 findProject，但找不到就 throw 並列出可選項 */
  private mustFindProject(name: string): Project {
    const found = this.findProject(name);
    if (found) return found;
    const available = this._projects.filter((p) => !p.isDeleted).map((p) => (p.type === 3000 ? `#${p.name}` : p.name));
    throw new Error(`找不到清單「${name}」。現有清單：收件匣、${available.join("、")}`);
  }

  /**
   * 把使用者給的標籤（名稱或 ID，逗號/空白/# 分隔）轉成 server 要的 project ID 字串。
   * FocusTodo 的 tags 欄位存的是 type=3000 標籤清單的 ID，不是文字。
   */
  private resolveTags(input?: string): string {
    if (!input) return "";
    const parts = input.split(/[,\s]+/).map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const part of parts) {
      const byId = this._projects.find((p) => p.id === part);
      if (byId) {
        ids.push(byId.id);
        continue;
      }
      const tag = this._projects.find(
        (p) => p.type === 3000 && !p.isDeleted && p.name.toLowerCase() === part.toLowerCase()
      ) || this._projects.find(
        (p) => p.type === 3000 && !p.isDeleted && p.name.toLowerCase().includes(part.toLowerCase())
      );
      if (tag) ids.push(tag.id);
      else unknown.push(part);
    }
    if (unknown.length) {
      throw new Error(
        `找不到標籤：${unknown.join("、")}。標籤必須是已存在的標籤清單，` +
        `可先用 list_projects 查看（type=標籤 的那些）。`
      );
    }
    return ids.join(",");
  }

  // ===== 查詢 API =====

  async getProjects(): Promise<Project[]> {
    await this.ensureData();
    return this._projects.filter((p) => !p.isDeleted);
  }

  async getTasks(filters?: {
    projectId?: string;
    projectName?: string;
    tag?: string;
    priority?: number;
    isFinished?: boolean;
    includeDeleted?: boolean;
    /** 到期日篩選：overdue=已逾期未完成、today=今天到期、week=未來七天內到期 */
    due?: "overdue" | "today" | "week";
    /** 預設 false：隱藏 projectId="" 的「真孤兒」（user 在 App 看不到、也刪不掉）。 */
    includeOrphans?: boolean;
  }): Promise<EnrichedTask[]> {
    await this.ensureData();

    let tasks = this._tasks.filter((t) => (!filters?.includeDeleted ? !t.isDeleted : true));

    // ⬇️ 預設過濾真孤兒（projectId=""），保留 Inbox magic 字串 "id-task-tasks"
    if (!filters?.includeOrphans) {
      tasks = tasks.filter((t) => t.projectId !== "");
    }

    if (filters?.projectId) {
      tasks = tasks.filter((t) => t.projectId === filters.projectId);
    }
    if (filters?.projectName) {
      // 找不到要明說。靜默回空陣列會讓使用者以為清單是空的，而不是名字打錯了。
      const project = this.mustFindProject(filters.projectName);
      if (project.type === 3000) {
        // 標籤型清單（Blog、iPAS 等）：tags 欄位存的是 project ID
        tasks = tasks.filter((t) => t.tags.includes(project.id));
      } else if (project.id === INBOX_PROJECT_ID) {
        tasks = tasks.filter((t) => t.projectId === INBOX_PROJECT_ID);
      } else {
        tasks = tasks.filter((t) => t.projectId === project.id);
      }
    }
    if (filters?.tag) {
      const wanted = filters.tag.toLowerCase().replace(/^#/, "");
      const tagProject = this._projects.find(
        (p) => p.type === 3000 && !p.isDeleted && p.name.toLowerCase() === wanted
      ) || this._projects.find(
        (p) => p.type === 3000 && !p.isDeleted && p.name.toLowerCase().includes(wanted)
      );
      if (!tagProject) {
        const available = this._projects.filter((p) => p.type === 3000 && !p.isDeleted).map((p) => p.name);
        throw new Error(`找不到標籤「${filters.tag}」。現有標籤：${available.join("、") || "（無）"}`);
      }
      tasks = tasks.filter((t) => t.tags.includes(tagProject.id));
    }
    if (filters?.priority !== undefined) {
      tasks = tasks.filter((t) => t.priority === filters.priority);
    }
    if (filters?.isFinished !== undefined) {
      tasks = tasks.filter((t) => t.isFinished === filters.isFinished);
    }
    if (filters?.due) {
      const { start, end } = todayBounds();
      tasks = tasks.filter((t) => {
        if (!t.deadline || t.isFinished) return false;
        if (filters.due === "overdue") return t.deadline < start;
        if (filters.due === "today") return t.deadline >= start && t.deadline < end;
        return t.deadline >= start && t.deadline < end + 6 * 86400000;
      });
    }

    return tasks.map((t) => this.enrich(t));
  }

  private enrich(t: Task): EnrichedTask {
    const tagNames = t.tags
      ? t.tags
          .split(",")
          .filter(Boolean)
          .map((id) => {
            const proj = this._projects.find((p) => p.id === id.trim());
            return proj ? `#${proj.name}` : "";
          })
          .filter(Boolean)
          .join(" ")
      : "";
    // 收件匣不是真的 project，server 不會在 projects 裡回傳它。
    // 沒有這行的話，落在收件匣的任務（本帳號有 183 筆）全都顯示不出歸屬。
    const projectName =
      t.projectId === INBOX_PROJECT_ID
        ? "收件匣"
        : this._projects.find((p) => p.id === t.projectId)?.name;
    return { ...t, projectName, tagNames };
  }

  /** 新任務排在最前面。FocusTodo 的 order 越小越前，固定給 0 會插進清單中段。 */
  private nextTaskOrder(): number {
    // reduce 而非 Math.min(...spread)：任務數上萬時 spread 會爆 argument 上限
    return this._tasks.reduce((min, t) => Math.min(min, t.order), 0) - 10000;
  }

  async getTaskById(taskId: string): Promise<EnrichedTask | undefined> {
    await this.ensureData();
    const t = this._tasks.find((x) => x.id === taskId);
    return t ? this.enrich(t) : undefined;
  }

  async getSubtasks(taskId: string): Promise<Subtask[]> {
    await this.ensureData();
    return this._subtasks.filter((s) => s.taskId === taskId && !s.isDeleted);
  }

  async getPomodoros(filters?: {
    taskId?: string;
    startDate?: number;
    endDate?: number;
  }): Promise<Pomodoro[]> {
    await this.ensureData();

    let pomos = this._pomodoros.filter((p) => p.state !== STATE_DELETED);

    if (filters?.taskId) {
      pomos = pomos.filter((p) => p.taskId === filters.taskId);
    }
    if (filters?.startDate) {
      pomos = pomos.filter((p) => p.endDate >= filters.startDate!);
    }
    if (filters?.endDate) {
      pomos = pomos.filter((p) => p.endDate <= filters.endDate!);
    }

    return pomos;
  }

  // ===== 寫入 API =====

  /** 建立多個任務。回傳建立結果，projectName 找不到時整批不送出。 */
  async createTasks(
    items: {
      name: string;
      projectName?: string;
      projectId?: string;
      tags?: string;
      priority?: number;
      estimatePomoNum?: number;
      deadline?: number;
      remark?: string;
    }[]
  ): Promise<Task[]> {
    await this.ensureData();

    const now = Date.now();
    // 同一批任務要遞減編號，否則全擠在同一個 order 值上、App 排序不穩定
    let order = this.nextTaskOrder();
    const built: Task[] = items.map((params) => {
      // 解析清單：找不到就明說，不要靜默落到孤兒
      let projectId = params.projectId;
      if (!projectId && params.projectName) {
        projectId = this.mustFindProject(params.projectName).id;
      }
      // ⚠️ 沒有清單一律落收件匣。留空字串會變成 App 看不到的真孤兒。
      if (!projectId) projectId = INBOX_PROJECT_ID;
      order -= 100;

      return {
        id: randomUUID(),
        name: params.name,
        projectId,
        tags: this.resolveTags(params.tags),
        priority: params.priority ?? 0,
        estimatePomoNum: params.estimatePomoNum ?? 0,
        actualPomoNum: 0,
        pomodoroInterval: 1500,
        deadline: params.deadline ?? 0,
        reminderDate: 0,
        creationDate: now,
        finishedDate: 0,
        isFinished: false,
        isDeleted: false,
        hasSubtask: false,
        remark: params.remark || "",
        order,
        state: STATE_ACTIVE,
        rCycle: 0,
        rFirstDeadline: 0,
        rUnit: "",
        rValue: "",
        rId: "",
      };
    });

    const pushedAt = Date.now();
    await this.sync({ tasks: built });
    for (const task of built) this.mergeArray(this._tasks, [task]);

    const rejected = await this.verifyApplied(
      "tasks",
      built.map((t) => ({ id: t.id, fields: { name: t.name, projectId: t.projectId } })),
      pushedAt
    );
    if (rejected.length) {
      // 沒進 server 的不要留在快取裡假裝存在
      const bad = new Set(rejected.map((r) => r.id));
      this._tasks = this._tasks.filter((t) => !bad.has(t.id));
      throw new Error(
        `${rejected.length}/${built.length} 個任務 server 未確認：` +
        rejected.map((r) => r.reason).join("; ")
      );
    }
    return built;
  }

  async createTask(params: Parameters<FocusToDoAPI["createTasks"]>[0][0]): Promise<Task> {
    const [task] = await this.createTasks([params]);
    return task;
  }

  /** 把使用者給的 patch 正規化成 server 欄位（解析清單名稱、標籤名稱） */
  private normalizePatch(updates: TaskPatch): Record<string, unknown> {
    const { projectName, ...fields } = updates;
    const patch: Record<string, unknown> = { ...fields };
    if (projectName !== undefined) {
      const project = this.mustFindProject(projectName);
      if (project.type === 3000) {
        throw new Error(`「${projectName}」是標籤不是清單，請改用 tags 參數`);
      }
      patch.projectId = project.id;
    }
    if (typeof patch.tags === "string") {
      patch.tags = this.resolveTags(patch.tags);
    }
    return patch;
  }

  /**
   * 批次更新任務：一次 sync 推送全部，一次 delta 驗證全部。
   *
   * 不要退回「逐筆呼叫 updateTask」——每筆內含 1.5 秒等待加兩趟 HTTP，
   * 20 筆就會撞上 MCP 的逾時上限。
   */
  async updateTasks(
    taskIds: string[],
    updates: TaskPatch | ((task: Task) => TaskPatch)
  ): Promise<{ updated: Task[]; failed: { id: string; reason: string }[] }> {
    await this.ensureData();

    const failed: { id: string; reason: string }[] = [];
    const staged: { task: Task; patch: Record<string, unknown> }[] = [];

    for (const id of taskIds) {
      const task = this._tasks.find((t) => t.id === id);
      if (!task) {
        failed.push({ id, reason: "找不到此任務" });
        continue;
      }
      try {
        const patch = this.normalizePatch(
          typeof updates === "function" ? updates(task) : updates
        );
        staged.push({ task, patch });
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    if (!staged.length) return { updated: [], failed };

    const pushed = staged.map(({ task, patch }) => ({ ...task, ...patch }) as Task);
    const pushedAt = Date.now();
    await this.sync({ tasks: pushed });
    for (const t of pushed) this.mergeArray(this._tasks, [t]);

    // Server 曾對既有任務的修改 silently reject（回 status=0 卻不持久化）。
    // 2026-08-02 實測已可正常寫入，但保留驗證——寫入成功與否不該靠猜。
    const rejected = await this.verifyApplied(
      "tasks",
      staged.map(({ task, patch }) => ({ id: task.id, fields: patch })),
      pushedAt
    );

    // Server 拒收的要把快取還原成原值，否則後續查詢會回報一個從未生效的狀態
    const rejectedIds = new Set(rejected.map((r) => r.id));
    for (const { task } of staged) {
      if (rejectedIds.has(task.id)) this.mergeArray(this._tasks, [task]);
    }

    return {
      updated: pushed.filter((t) => !rejectedIds.has(t.id)),
      failed: [...failed, ...rejected],
    };
  }

  /** 單筆更新。server 沒接受就 throw，維持「回傳值代表已生效」的語義。 */
  async updateTask(taskId: string, updates: TaskPatch): Promise<Task | null> {
    const { updated, failed } = await this.updateTasks([taskId], updates);
    if (updated.length) return updated[0];
    const reason = failed[0]?.reason ?? "未知原因";
    if (reason === "找不到此任務") return null;
    throw new Error(reason);
  }

  async completeTasks(taskIds: string[]) {
    return this.updateTasks(taskIds, { isFinished: true, finishedDate: Date.now() });
  }

  async uncompleteTasks(taskIds: string[]) {
    return this.updateTasks(taskIds, { isFinished: false, finishedDate: 0 });
  }

  async deleteTasks(taskIds: string[]) {
    return this.updateTasks(taskIds, { isDeleted: true, state: STATE_DELETED });
  }

  async completeTask(taskId: string): Promise<Task | null> {
    return this.updateTask(taskId, { isFinished: true, finishedDate: Date.now() });
  }

  async uncompleteTask(taskId: string): Promise<Task | null> {
    return this.updateTask(taskId, { isFinished: false, finishedDate: 0 });
  }

  async deleteTask(taskId: string): Promise<Task | null> {
    return this.updateTask(taskId, { isDeleted: true, state: STATE_DELETED });
  }

  /**
   * 用獨立 clientId 拉 delta，讀 server 的真實持久層狀態。
   *
   * ⚠️ 一定要用 delta 不能用 fullSync — fullSync 會把 client 剛 push 的內容
   * 原樣 mirror 回來，就算 server 根本沒存也看起來像成功。
   * clientId 也必須是新的，否則 server 會過濾掉「自己 push 的變動」。
   */
  private async fetchDelta(sinceMs: number): Promise<SyncResponse> {
    const creds = await this.ensureAuth();
    const body = new URLSearchParams({
      timestamp: String(sinceMs),
      clientId: randomUUID(),
      client: CLIENT_NAME,
      projects: "[]",
      tasks: "[]",
      subtasks: "[]",
      pomodoros: "[]",
      schedules: "[]",
      acct: creds.acct,
      name: creds.name,
      pid: creds.pid,
      uid: creds.uid,
    });
    const res = await fetchWithTimeout(`${BASE_URL}/v64/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: creds.cookies,
      },
      body: body.toString(),
    });
    return (await res.json()) as SyncResponse;
  }

  /**
   * Post-write verification：確認變更真的落到 server。
   * 回傳沒通過的項目（不 throw），讓呼叫端決定怎麼報告部分失敗。
   */
  private async verifyApplied(
    kind: "tasks" | "subtasks" | "pomodoros" | "projects",
    expectations: { id: string; fields: Record<string, unknown> }[],
    pushedAt: number
  ): Promise<{ id: string; reason: string }[]> {
    if (!expectations.length) return [];

    await new Promise((r) => setTimeout(r, 1500));
    const data = await this.fetchDelta(pushedAt - 5000);
    const rows = (data[kind] || []) as { id: string }[];

    const rejected: { id: string; reason: string }[] = [];
    for (const { id, fields } of expectations) {
      const echoed = rows.find((r) => r.id === id);
      if (!echoed) {
        rejected.push({
          id,
          reason: `Server 沒收到此變更。本地與 server 可能不一致，請重新查詢或改在 App 內操作。`,
        });
        continue;
      }
      const mismatches: string[] = [];
      for (const [key, expected] of Object.entries(fields)) {
        const actual = (echoed as unknown as Record<string, unknown>)[key];
        if (actual !== expected) {
          mismatches.push(`${key}: 期望=${JSON.stringify(expected)} 實際=${JSON.stringify(actual)}`);
        }
      }
      if (mismatches.length) {
        rejected.push({ id, reason: `Server 收到變動但欄位不符：${mismatches.join("; ")}` });
      }
    }
    return rejected;
  }

  /** 驗證單筆寫入，沒過就 throw */
  private async verifyOneOrThrow(
    kind: "tasks" | "subtasks" | "pomodoros" | "projects",
    id: string,
    fields: Record<string, unknown>,
    pushedAt: number
  ): Promise<void> {
    const [rejected] = await this.verifyApplied(kind, [{ id, fields }], pushedAt);
    if (rejected) throw new Error(rejected.reason);
  }

  // ===== 子任務 =====

  async createSubtask(params: {
    taskId: string;
    name: string;
    estimatedPomoNum?: number;
  }): Promise<Subtask> {
    await this.ensureData();

    const now = Date.now();
    const subtask: Subtask = {
      id: randomUUID(),
      name: params.name,
      taskId: params.taskId,
      order: 10000,
      isFinished: false,
      isDeleted: false,
      finishedDate: 0,
      creationDate: now,
      estimatedPomoNum: params.estimatedPomoNum ?? 0,
      state: STATE_ACTIVE,
    };

    // 父任務要標記 hasSubtask，否則 App 不展開子任務區塊
    const parent = this._tasks.find((t) => t.id === params.taskId);
    if (!parent) throw new Error(`找不到父任務 ${params.taskId}`);
    const parentPatch = !parent.hasSubtask ? [{ ...parent, hasSubtask: true }] : [];

    const pushedAt = Date.now();
    await this.sync({ subtasks: [subtask], tasks: parentPatch });
    this.mergeArray(this._subtasks, [subtask]);
    if (parentPatch.length) this.mergeArray(this._tasks, parentPatch);

    await this.verifyOneOrThrow("subtasks", subtask.id, { name: subtask.name }, pushedAt);
    return subtask;
  }

  async updateSubtask(
    subtaskId: string,
    updates: Partial<Pick<Subtask, "name" | "isFinished" | "isDeleted" | "estimatedPomoNum">>
  ): Promise<Subtask | null> {
    await this.ensureData();
    const sub = this._subtasks.find((s) => s.id === subtaskId);
    if (!sub) return null;

    const patch: Partial<Subtask> = { ...updates };
    if (updates.isFinished !== undefined) {
      patch.finishedDate = updates.isFinished ? Date.now() : 0;
    }
    if (updates.isDeleted) patch.state = STATE_DELETED;

    const updated = { ...sub, ...patch };
    const pushedAt = Date.now();
    await this.sync({ subtasks: [updated] });
    this.mergeArray(this._subtasks, [updated]);

    await this.verifyOneOrThrow("subtasks", subtaskId, patch as Record<string, unknown>, pushedAt);
    return updated;
  }

  // ===== 番茄鐘 =====

  /**
   * 補記一段專注時間。FocusTodo 沒有「正在計時」的 server 端狀態——
   * 番茄鐘是結束後才寫入一筆記錄，所以這裡記的是「已經完成的專注」。
   * 同時累加父任務的 actualPomoNum，否則 App 上任務的番茄計數不會動。
   */
  async logPomodoro(params: {
    taskId: string;
    minutes: number;
    endDate?: number;
    subtaskId?: string;
  }): Promise<Pomodoro> {
    await this.ensureData();

    const task = this._tasks.find((t) => t.id === params.taskId);
    if (!task) throw new Error(`找不到任務 ${params.taskId}`);
    if (task.isDeleted) throw new Error(`任務「${task.name}」已刪除，無法補記專注時間`);
    if (params.minutes <= 0) throw new Error("專注時間必須大於 0 分鐘");

    const now = Date.now();
    const endDate = params.endDate ?? now;
    // 未來時間會污染「今日專注」和統計，擋掉
    if (endDate > now + 60_000) throw new Error("專注的結束時間不能在未來");
    const seconds = Math.round(params.minutes * 60);

    const pomo: Pomodoro = {
      id: randomUUID(),
      taskId: params.taskId,
      subtaskId: params.subtaskId || "",
      interval: seconds,
      pomodoroInterval: task.pomodoroInterval || 1500,
      endDate,
      creationDate: now,
      state: STATE_ACTIVE,
      isManual: true,
    };

    const taskPatch = { ...task, actualPomoNum: task.actualPomoNum + 1 };

    const pushedAt = Date.now();
    await this.sync({ pomodoros: [pomo], tasks: [taskPatch] });
    this.mergeArray(this._pomodoros, [pomo]);
    this.mergeArray(this._tasks, [taskPatch]);

    await this.verifyOneOrThrow("pomodoros", pomo.id, { interval: pomo.interval }, pushedAt);
    return pomo;
  }

  // ===== 清單 =====

  async createProject(params: {
    name: string;
    color?: string;
    isTag?: boolean;
  }): Promise<Project> {
    await this.ensureData();

    if (this.findProject(params.name)?.name.toLowerCase() === params.name.toLowerCase()) {
      throw new Error(`清單「${params.name}」已存在`);
    }

    const project: Project = {
      id: randomUUID(),
      name: params.name,
      color: params.color || "#4A90D9",
      type: params.isTag ? 3000 : 1000,
      order: Math.min(0, ...this._projects.map((p) => p.order)) - 1000,
      isDefault: false,
      isDeleted: false,
      state: STATE_ACTIVE,
      parentId: "",
      creationDate: Date.now(),
    };

    const pushedAt = Date.now();
    await this.sync({ projects: [project] });
    this.mergeArray(this._projects, [project]);

    await this.verifyOneOrThrow("projects", project.id, { name: project.name }, pushedAt);
    return project;
  }

  // ===== 統計 API =====

  async getStats(filters?: {
    startDate?: number;
    endDate?: number;
    projectName?: string;
  }): Promise<{
    totalFocusTime: number;
    totalPomodoros: number;
    completedTasks: number;
    pendingTasks: number;
    projectBreakdown: { name: string; focusTime: number; pomodoros: number }[];
    dailyBreakdown: { date: string; focusTime: number; pomodoros: number }[];
  }> {
    await this.ensureData();

    let pomos = this._pomodoros.filter((p) => p.state !== STATE_DELETED);
    let tasks = this._tasks.filter((t) => !t.isDeleted);

    if (filters?.startDate) pomos = pomos.filter((p) => p.endDate >= filters.startDate!);
    if (filters?.endDate) pomos = pomos.filter((p) => p.endDate <= filters.endDate!);

    if (filters?.projectName) {
      const project = this.mustFindProject(filters.projectName);
      const inProject =
        project.type === 3000
          ? tasks.filter((t) => t.tags.includes(project.id))
          : tasks.filter((t) => t.projectId === project.id);
      const taskIds = new Set(inProject.map((t) => t.id));
      pomos = pomos.filter((p) => taskIds.has(p.taskId));
      tasks = inProject;
    }

    // 完成數只算範圍內完成的，否則 "本週統計" 會混進歷史累計
    const completedTasks = filters?.startDate
      ? tasks.filter((t) => t.isFinished && t.finishedDate >= filters.startDate!).length
      : tasks.filter((t) => t.isFinished).length;

    const projectMap = new Map<string, { focusTime: number; pomodoros: number }>();
    const dailyMap = new Map<string, { focusTime: number; pomodoros: number }>();
    for (const p of pomos) {
      const task = this._tasks.find((t) => t.id === p.taskId);
      const projId = task?.projectId || "unknown";
      const pe = projectMap.get(projId) || { focusTime: 0, pomodoros: 0 };
      pe.focusTime += p.interval;
      pe.pomodoros += 1;
      projectMap.set(projId, pe);

      const day = new Date(p.endDate).toLocaleDateString("sv-SE"); // YYYY-MM-DD 當地時區
      const de = dailyMap.get(day) || { focusTime: 0, pomodoros: 0 };
      de.focusTime += p.interval;
      de.pomodoros += 1;
      dailyMap.set(day, de);
    }

    return {
      totalFocusTime: pomos.reduce((sum, p) => sum + p.interval, 0),
      totalPomodoros: pomos.length,
      completedTasks,
      pendingTasks: tasks.filter((t) => !t.isFinished).length,
      projectBreakdown: Array.from(projectMap.entries())
        .map(([projId, s]) => ({
          name: this._projects.find((p) => p.id === projId)?.name || "未分類",
          ...s,
        }))
        .sort((a, b) => b.focusTime - a.focusTime),
      dailyBreakdown: Array.from(dailyMap.entries())
        .map(([date, s]) => ({ date, ...s }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  async getTodayFocus(): Promise<{
    focusTime: number;
    pomodoros: number;
    tasks: { name: string; focusTime: number; pomodoros: number }[];
  }> {
    await this.ensureData();

    const { start, end } = todayBounds();
    const pomos = this._pomodoros.filter(
      (p) => p.state !== STATE_DELETED && p.endDate >= start && p.endDate < end
    );

    const taskMap = new Map<string, { focusTime: number; pomodoros: number }>();
    for (const p of pomos) {
      const e = taskMap.get(p.taskId) || { focusTime: 0, pomodoros: 0 };
      e.focusTime += p.interval;
      e.pomodoros += 1;
      taskMap.set(p.taskId, e);
    }

    return {
      focusTime: pomos.reduce((sum, p) => sum + p.interval, 0),
      pomodoros: pomos.length,
      tasks: Array.from(taskMap.entries())
        .map(([taskId, s]) => ({
          name: this._tasks.find((t) => t.id === taskId)?.name || "未知任務",
          ...s,
        }))
        .sort((a, b) => b.focusTime - a.focusTime),
    };
  }
}

/** 任務可更新的欄位。projectName 是便利參數，會解析成 projectId。 */
export type TaskPatch = Partial<
  Pick<
    Task,
    | "name" | "tags" | "priority" | "estimatePomoNum" | "deadline" | "remark"
    | "projectId" | "isFinished" | "finishedDate" | "isDeleted" | "state"
  >
> & { projectName?: string };

/** 今天的當地時區起訖時間 */
export function todayBounds(): { start: number; end: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return { start: d.getTime(), end: d.getTime() + 86400000 };
}
