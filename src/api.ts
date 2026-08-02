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
    if (this._projects.length === 0) {
      await this.sync();
      return;
    }
    if (Date.now() - this.lastFetchedAt > CACHE_TTL_MS) {
      await this.sync();
    }
  }

  /** 強制重新整理快取（寫入後或使用者明確要求最新狀態時用） */
  async refresh(): Promise<void> {
    this.lastFetchedAt = 0;
    await this.ensureData();
  }

  // ===== 清單／標籤解析 =====

  /** 依名稱模糊找清單（優先完全相符，其次包含） */
  private findProject(name: string): Project | undefined {
    const lc = name.toLowerCase().replace(/^#/, "");
    const alive = this._projects.filter((p) => !p.isDeleted);
    return (
      alive.find((p) => p.name.toLowerCase() === lc) ||
      alive.find((p) => p.name.toLowerCase().includes(lc))
    );
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
      const project = this.findProject(filters.projectName);
      if (project) {
        if (project.type === 3000) {
          // 標籤型清單（Blog、iPAS 等）：tags 欄位存的是 project ID
          tasks = tasks.filter((t) => t.tags.includes(project.id));
        } else {
          tasks = tasks.filter((t) => t.projectId === project.id);
        }
      } else {
        tasks = [];
      }
    }
    if (filters?.tag) {
      const tagProject = this._projects.find(
        (p) =>
          p.type === 3000 &&
          p.name.toLowerCase().includes(filters.tag!.toLowerCase().replace(/^#/, ""))
      );
      tasks = tagProject ? tasks.filter((t) => t.tags.includes(tagProject.id)) : [];
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
    return {
      ...t,
      projectName: this._projects.find((p) => p.id === t.projectId)?.name,
      tagNames,
    };
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
    const built: Task[] = items.map((params) => {
      // 解析清單：找不到就明說，不要靜默落到孤兒
      let projectId = params.projectId;
      if (!projectId && params.projectName) {
        const project = this.findProject(params.projectName);
        if (!project) {
          throw new Error(
            `找不到清單「${params.projectName}」（任務「${params.name}」未建立）。` +
            `先用 list_projects 確認名稱，或省略 projectName 讓它落在收件匣。`
          );
        }
        projectId = project.id;
      }
      // ⚠️ 沒有清單一律落收件匣。留空字串會變成 App 看不到的真孤兒。
      if (!projectId) projectId = INBOX_PROJECT_ID;

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
        order: 0,
        state: STATE_ACTIVE,
        rCycle: 0,
        rFirstDeadline: 0,
        rUnit: "",
        rValue: "",
        rId: "",
      };
    });

    await this.sync({ tasks: built });
    for (const task of built) this.mergeArray(this._tasks, [task]);
    return built;
  }

  async createTask(params: Parameters<FocusToDoAPI["createTasks"]>[0][0]): Promise<Task> {
    const [task] = await this.createTasks([params]);
    return task;
  }

  async updateTask(
    taskId: string,
    updates: Partial<
      Pick<
        Task,
        | "name" | "tags" | "priority" | "estimatePomoNum" | "deadline" | "remark"
        | "projectId" | "isFinished" | "finishedDate" | "isDeleted" | "state"
      >
    > & { projectName?: string }
  ): Promise<Task | null> {
    await this.ensureData();

    const task = this._tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const { projectName, ...fields } = updates;
    const patch: Record<string, unknown> = { ...fields };

    if (projectName !== undefined) {
      const project = this.findProject(projectName);
      if (!project) throw new Error(`找不到清單「${projectName}」`);
      if (project.type === 3000) {
        throw new Error(`「${projectName}」是標籤不是清單，請改用 tags 參數`);
      }
      patch.projectId = project.id;
    }
    if (typeof patch.tags === "string") {
      patch.tags = this.resolveTags(patch.tags as string);
    }

    const updated = { ...task, ...patch } as Task;
    const pushedAt = Date.now();

    await this.sync({ tasks: [updated] });

    const idx = this._tasks.findIndex((t) => t.id === taskId);
    if (idx >= 0) this._tasks[idx] = updated;

    // Server 曾對既有任務的修改 silently reject（回 status=0 卻不持久化）。
    // 2026-08-02 實測已可正常寫入，但保留驗證——寫入成功與否不該靠猜。
    await this.verifyServerApplied(taskId, patch, pushedAt);

    return updated;
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
   * Post-write verification: 確認 server 真的接受了我們的更新。
   *
   * 用獨立 clientId 跑 delta sync（server 會過濾同 clientId 自己 push 的變動），
   * 抓 push 前 5 秒到現在的所有變動，比對指定 taskId 的欄位是否符合 expected。
   * 一定要用 delta 不能用 fullSync — fullSync 會把 client 剛 push 的內容原樣
   * mirror 回來，就算 server 根本沒存也看起來像成功。
   */
  private async verifyServerApplied(
    taskId: string,
    expectedFields: Record<string, unknown>,
    pushedAt: number
  ): Promise<void> {
    const creds = await this.ensureAuth();

    await new Promise((r) => setTimeout(r, 1500));

    const body = new URLSearchParams({
      timestamp: String(pushedAt - 5000),
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

    const data = (await res.json()) as SyncResponse;
    const echoed = data.tasks?.find((t) => t.id === taskId);

    if (!echoed) {
      throw new Error(
        `Server 沒收到此變更（taskId=${taskId.slice(0, 8)}…）。本地快取可能與 server 不一致，` +
        `請重新查詢確認，或改在 FocusTodo App 內操作。`
      );
    }

    const mismatches: string[] = [];
    for (const [key, expected] of Object.entries(expectedFields)) {
      const actual = (echoed as unknown as Record<string, unknown>)[key];
      if (actual !== expected) {
        mismatches.push(`${key}: 期望=${JSON.stringify(expected)} 實際=${JSON.stringify(actual)}`);
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Server 收到變動但欄位不符（taskId=${taskId.slice(0, 8)}…）：${mismatches.join("; ")}`
      );
    }
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
    const parentPatch = parent && !parent.hasSubtask ? [{ ...parent, hasSubtask: true }] : [];

    await this.sync({ subtasks: [subtask], tasks: parentPatch });
    this.mergeArray(this._subtasks, [subtask]);
    if (parentPatch.length) this.mergeArray(this._tasks, parentPatch);

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
    await this.sync({ subtasks: [updated] });
    this.mergeArray(this._subtasks, [updated]);
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
    if (params.minutes <= 0) throw new Error("專注時間必須大於 0 分鐘");

    const now = Date.now();
    const endDate = params.endDate ?? now;
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

    await this.sync({ pomodoros: [pomo], tasks: [taskPatch] });
    this.mergeArray(this._pomodoros, [pomo]);
    this.mergeArray(this._tasks, [taskPatch]);

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

    await this.sync({ projects: [project] });
    this.mergeArray(this._projects, [project]);
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
      const project = this.findProject(filters.projectName);
      if (project) {
        const inProject =
          project.type === 3000
            ? tasks.filter((t) => t.tags.includes(project.id))
            : tasks.filter((t) => t.projectId === project.id);
        const taskIds = new Set(inProject.map((t) => t.id));
        pomos = pomos.filter((p) => taskIds.has(p.taskId));
        tasks = inProject;
      } else {
        pomos = [];
        tasks = [];
      }
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

/** 今天的當地時區起訖時間 */
export function todayBounds(): { start: number; end: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return { start: d.getTime(), end: d.getTime() + 86400000 };
}
