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

/** state 欄位語義（實測歸納）：0=正常、-1=已刪除 */
const STATE_ACTIVE = 0;
const STATE_DELETED = -1;

/** project.type：1000=一般清單、3000=標籤 */
const TYPE_LIST = 1000;
export const TYPE_TAG = 3000;

/**
 * 其餘 type（實測有 4001 PRJ_TOMORROW、4004 PRJ_DEADLINE_LAST7DAYS、
 * 4006 PRJ_DEADLINE_OVERDUE、5003 PRJ_PRIORITY_HIGH）是 App 內建的智慧清單
 * ——動態篩選視圖，不是容器。實測沒有任何任務歸屬其中。
 *
 * 一定要濾掉：留著的話 list_projects 會把它們當成可用清單報給 LLM，
 * 而 mustFindProject 一旦模糊命中，任務就會被建到 id-priority-high 之類的
 * 假清單裡，變成 App 看不到的另一種孤兒。
 */
function isRealProject(p: Project): boolean {
  return p.type === TYPE_LIST || p.type === TYPE_TAG;
}

/** 寫入後多久去確認。實測 server 的可見延遲約 400ms，600ms 起跳留了裕度。 */
const VERIFY_BASE_DELAY_MS = 600;
/** 看不到就退避重試（600ms → 1.8s → 5.4s，累計約 7.8 秒才放棄）。 */
const VERIFY_ATTEMPTS = 3;
const VERIFY_TOTAL_WAIT_LABEL = "約 8 秒";

/**
 * 已知邊界（Codex review 2026-08-02 指出）：一次寫入最多含 5 趟 HTTP
 * （freshData 1 + sync 1 + verify 3）加 7.8 秒退避，而每趟允許 FETCH_TIMEOUT_MS。
 * 所以總時間沒有收斂在 MCP client 預設的 60 秒逾時內——server 若持續慢到
 * 每趟 11 秒以上，client 會先逾時，而寫入其實還在背景進行並可能成功。
 *
 * 刻意不修：要壓進 60 秒得砍重試輪數或退避，而那個裕度有 2026-04-29 的事故
 * 撐腰（見 verifyApplied）。正常路徑實測約 1 秒，離上限很遠；真的變慢會先被
 * selftest 的「寫入可見延遲」校準項（3 秒門檻）抓到。要真正收斂得把單一
 * deadline 一路傳進每趟 fetch，等有實例再做。
 */

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
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`連線逾時（${timeoutMs / 1000} 秒）：${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 讀 JSON 並先檢查 HTTP 狀態。少了這層，server 回 502 HTML 時
 *  錯誤訊息會是看不懂的 `Unexpected token '<'`。 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} 失敗：HTTP ${res.status} ${res.statusText}`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${what} 回應不是合法 JSON（HTTP ${res.status}）`);
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

    const data = await readJson<LoginResponse>(res, "登入");
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

  /** POST /v64/sync 的共用管線。sync 與 fetchDelta 只差 timestamp/clientId 和要不要帶 payload。 */
  private async postSync(
    opts: {
      timestamp: number;
      clientId: string;
      payload?: {
        projects?: Partial<Project>[];
        tasks?: Partial<Task>[];
        subtasks?: Partial<Subtask>[];
        pomodoros?: Partial<Pomodoro>[];
      };
    },
    what: string
  ): Promise<SyncResponse> {
    const creds = await this.ensureAuth();
    const p = opts.payload;
    const body = new URLSearchParams({
      timestamp: String(opts.timestamp),
      clientId: opts.clientId,
      client: CLIENT_NAME,
      projects: JSON.stringify(p?.projects || []),
      tasks: JSON.stringify(p?.tasks || []),
      subtasks: JSON.stringify(p?.subtasks || []),
      pomodoros: JSON.stringify(p?.pomodoros || []),
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
    const data = await readJson<SyncResponse>(res, what);

    // Session cookie 輪替。放這裡而非 sync()，否則 fetchDelta 收到新 jsessionId
    // 也不會採用，下一輪驗證還在用舊 cookie。
    if (data.jsessionId && this.creds) {
      const parts = this.creds.cookies.split("; ").filter((c) => !c.startsWith("JSESSIONID="));
      parts.push(`JSESSIONID=${data.jsessionId}`);
      this.creds.cookies = parts.join("; ");
    }
    return data;
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
    const data = await this.postSync(
      { timestamp: this.syncTimestamp, clientId: this.clientId, payload },
      "同步"
    );

    if (data.status !== 0) {
      // Session expired — re-login and retry (with limit to prevent infinite loop)
      if ((data.status === -1 || data.status === -2) && _retryCount < MAX_SYNC_RETRIES) {
        this.creds = null;
        const backoffMs = Math.min(1000 * 2 ** _retryCount, 8000) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoffMs));
        return this.sync(payload, _retryCount + 1);
      }
      // status 語義（實測）：-1/-2=session 失效（上面已重試）、-9=送出的資料被拒收
      const hint = data.status === -9 ? "（-9：資料格式被 server 拒收，例如送了不完整的物件）" : "";
      throw new Error(`Sync failed: status=${data.status}${hint} (after ${_retryCount} retries)`);
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

  /**
   * 讀-改-寫路徑專用：先把快取拉到最新再動手。
   *
   * server 的 sync 只收完整物件，所以 `{...task, ...patch}` 會把快取裡每一個
   * 欄位都寫回去。用最多 60 秒舊的快取當底，等於把使用者這段期間在 App 改的
   * remark／deadline 全部回捲。多一次 delta 換掉這個資料遺失。
   *
   * 2026-08-02 實測過「只送變更欄位」這條路：送 `{id, name}` 的 partial task，
   * server 回 `status=-9` 整批拒收（好消息是拒絕為原子的，不留半套狀態）。
   * 所以整物件覆蓋是 server 強制的，不是這裡偷懶——freshData 只能把競態視窗
   * 從 60 秒縮到一次往返，消不掉。真要消除得靠 server 端的樂觀鎖，而它沒有。
   */
  private async freshData(): Promise<void> {
    await this.refresh();
  }

  /** projectId → 顯示名稱。收件匣不是真 project，server 的 projects 裡查不到。 */
  private projectNameOf(projectId: string): string | undefined {
    if (projectId === INBOX_PROJECT_ID) return "收件匣";
    return this._projects.find((p) => p.id === projectId)?.name;
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
    const alive = this._projects.filter((p) => !p.isDeleted && isRealProject(p));
    return (
      alive.find((p) => p.name.toLowerCase() === lc) ||
      alive.find((p) => p.name.toLowerCase().includes(lc))
    );
  }

  /** 同 findProject，但找不到就 throw 並列出可選項 */
  private mustFindProject(name: string): Project {
    const found = this.findProject(name);
    if (found) return found;
    const available = this._projects
      .filter((p) => !p.isDeleted && isRealProject(p))
      .map((p) => (p.type === TYPE_TAG ? `#${p.name}` : p.name));
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
      // 只認標籤的 ID。傳一般清單的 ID 會寫進去一個 App 解讀不了的 tags 值
      const byId = this._projects.find((p) => p.id === part && p.type === TYPE_TAG);
      if (byId) {
        ids.push(byId.id);
        continue;
      }
      const tag = this._projects.find(
        (p) => p.type === TYPE_TAG && !p.isDeleted && p.name.toLowerCase() === part.toLowerCase()
      ) || this._projects.find(
        (p) => p.type === TYPE_TAG && !p.isDeleted && p.name.toLowerCase().includes(part.toLowerCase())
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
    return this._projects.filter((p) => !p.isDeleted && isRealProject(p));
  }

  async getTasks(filters?: {
    projectId?: string;
    projectName?: string;
    tag?: string;
    priority?: number;
    isFinished?: boolean;
    /** 到期日篩選：overdue=已逾期未完成、today=今天到期、week=未來七天內到期 */
    due?: "overdue" | "today" | "week";
    /** 預設 false：隱藏 projectId="" 的「真孤兒」（user 在 App 看不到、也刪不掉）。 */
    includeOrphans?: boolean;
  }): Promise<EnrichedTask[]> {
    await this.ensureData();

    let tasks = this._tasks.filter((t) => !t.isDeleted);

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
      if (project.type === TYPE_TAG) {
        // 標籤型清單：tags 欄位存的是 project ID
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
        (p) => p.type === TYPE_TAG && !p.isDeleted && p.name.toLowerCase() === wanted
      ) || this._projects.find(
        (p) => p.type === TYPE_TAG && !p.isDeleted && p.name.toLowerCase().includes(wanted)
      );
      if (!tagProject) {
        const available = this._projects.filter((p) => p.type === TYPE_TAG && !p.isDeleted).map((p) => p.name);
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
    return { ...t, projectName: this.projectNameOf(t.projectId), tagNames };
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

  async getPomodoros(filters?: { taskId?: string }): Promise<Pomodoro[]> {
    await this.ensureData();
    const pomos = this._pomodoros.filter((p) => p.state !== STATE_DELETED);
    return filters?.taskId ? pomos.filter((p) => p.taskId === filters.taskId) : pomos;
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
      reminderDate?: number;
      pomodoroInterval?: number;
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
        pomodoroInterval: params.pomodoroInterval ?? 1500,
        deadline: params.deadline ?? 0,
        reminderDate: params.reminderDate ?? 0,
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
      this.lastFetchedAt = 0; // 結果未知，下次查詢重新向 server 確認
      throw new Error(
        `${rejected.length}/${built.length} 個任務無法確認：` +
        rejected.map((r) => r.reason).join("; ")
      );
    }
    return built;
  }

  /** 把使用者給的 patch 正規化成 server 欄位（解析清單名稱、標籤名稱） */
  private normalizePatch(updates: TaskPatch): Record<string, unknown> {
    const { projectName, ...fields } = updates;
    const patch: Record<string, unknown> = { ...fields };
    if (projectName !== undefined) {
      const project = this.mustFindProject(projectName);
      if (project.type === TYPE_TAG) {
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
    await this.freshData();

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

    // 沒確認到的不能假裝知道結果。回滾成舊值等於斷定「寫入失敗」，但真相未知
    // （很可能只是 server 還沒可見）。讓快取失效，下次查詢直接向 server 要答案。
    const rejectedIds = new Set(rejected.map((r) => r.id));
    if (rejectedIds.size) this.lastFetchedAt = 0;

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

  /**
   * 拉 delta，讀 server 的真實持久層狀態。
   *
   * 用 delta 而非 fullSync：帳號用久了 fullSync 回應可達數 MB，
   * 拿來驗證單筆寫入太重。
   *
   * 註：舊版註解聲稱「clientId 必須是新的，否則 server 會過濾掉自己 push 的
   * 變動」，2026-08-02 實測為誤——同 client 同 clientId、異 client、新 clientId
   * 四種組合都看得到自己剛 push 的變動，server 不做這層過濾。這裡仍用新
   * clientId，因為沒有理由讓驗證讀取去動到 this.clientId 的同步游標。
   */
  private async fetchDelta(sinceMs: number, _retry = true): Promise<SyncResponse> {
    const data = await this.postSync({ timestamp: sinceMs, clientId: randomUUID() }, "驗證同步");
    if (data.status === 0) return data;

    // ⚠️ 不檢查 status 的話會重演 2026-04-29：session 過期時 server 回
    // status=-1 且不帶 tasks，呼叫端的 `data[kind] || []` 把它讀成「空的 delta」，
    // 於是「還沒看到」被當成「寫入沒生效」——而寫入其實已經持久化了。
    if ((data.status === -1 || data.status === -2) && _retry) {
      this.creds = null; // 重登後再讀一次
      return this.fetchDelta(sinceMs, false);
    }
    // 讀不到就要說「讀不到」，不能讓它偽裝成一份空的 delta 往下流
    throw new Error(
      `驗證讀取失敗（status=${data.status}）。寫入很可能已生效，只是無法確認——請重新查詢，不要重複送出。`
    );
  }

  /**
   * Post-write verification：確認變更真的落到 server。
   * 回傳沒通過的項目（不 throw），讓呼叫端決定怎麼報告部分失敗。
   *
   * ⚠️ 會重試，不要改回「等一次就判死刑」。
   *
   * 2026-04-29 的事故就是這樣來的：server 那天寫入可見性延遲，verify 等
   * 1500ms 沒看到就報 `server reject`，於是從錯誤訊息反推出「FocusTodo 有
   * anti-tampering 鎖、MCP 只能讀與新建」的結論，寫進 README 和 memory 流傳
   * 三個月。事後查證，那些「被拒絕」的寫入全部都持久化了。
   *
   * 「還沒看到」不等於「被拒絕」。看不到就退避重試，重試完仍看不到也只能
   * 說「無法確認」，不能宣稱 server 拒絕。
   *
   * 同理，「看到舊值」也不等於「被拒絕」——delta 窗口撈到的可能是這筆記錄
   * 寫入前的版本。所以欄位不符也要重試，只有最後一輪仍不符才定讞。
   */
  private async verifyApplied(
    kind: "tasks" | "subtasks" | "pomodoros" | "projects",
    expectations: { id: string; fields: Record<string, unknown> }[],
    pushedAt: number
  ): Promise<{ id: string; reason: string }[]> {
    if (!expectations.length) return [];

    let pending = expectations;
    const mismatched = new Map<string, string>();

    for (let attempt = 0; attempt < VERIFY_ATTEMPTS && pending.length; attempt++) {
      await new Promise((r) => setTimeout(r, VERIFY_BASE_DELAY_MS * 3 ** attempt));

      const data = await this.fetchDelta(pushedAt - 5000);
      const rows = (data[kind] || []) as { id: string }[];
      const stillPending: typeof pending = [];
      // 只有最後一輪的比對結果算數：前幾輪的不符很可能是還沒寫完的舊值
      mismatched.clear();

      for (const item of pending) {
        const echoed = rows.find((r) => r.id === item.id);
        if (!echoed) {
          stillPending.push(item); // 還沒可見，下一輪再看
          continue;
        }
        const mismatches: string[] = [];
        for (const [key, expected] of Object.entries(item.fields)) {
          const actual = (echoed as unknown as Record<string, unknown>)[key];
          if (actual !== expected) {
            mismatches.push(`${key}: 期望=${JSON.stringify(expected)} 實際=${JSON.stringify(actual)}`);
          }
        }
        if (mismatches.length) {
          mismatched.set(item.id, mismatches.join("; "));
          stillPending.push(item); // 可能只是舊值，下一輪再確認
        }
      }
      pending = stillPending;
    }

    return pending.map((p) => {
      const reason = mismatched.get(p.id);
      return {
        id: p.id,
        reason: reason
          ? `Server 存的值與送出的不符（重試 ${VERIFY_ATTEMPTS} 次後仍不符）：${reason}`
          : `無法確認 server 是否已套用（等待 ${VERIFY_TOTAL_WAIT_LABEL} 仍未在同步資料中出現）。` +
            `這通常是 server 寫入延遲，不代表被拒絕——變更很可能稍後就會生效。` +
            `請重新查詢確認，不要重複送出。`,
      };
    });
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
    await this.freshData(); // 會連帶推送父任務的 hasSubtask，整物件覆蓋

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
    await this.freshData();
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
    await this.freshData(); // actualPomoNum 是讀-改-寫，用舊快取會吃掉 App 端的計數

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

  /**
   * 刪除番茄鐘記錄，並把父任務的 actualPomoNum 扣回去。
   *
   * ⚠️ 刪任務不會連帶刪它的番茄鐘——那些記錄會繼續留在統計裡，
   * 「今日專注」還會顯示已刪任務的名稱。要真正移除得走這裡。
   */
  async deletePomodoros(pomodoroIds: string[]): Promise<{ deleted: number; focusSeconds: number }> {
    await this.freshData();

    const targets = this._pomodoros.filter(
      (p) => pomodoroIds.includes(p.id) && p.state !== STATE_DELETED
    );
    if (!targets.length) return { deleted: 0, focusSeconds: 0 };

    // 父任務的計數要跟著減，否則 App 上的 🍅 數字會虛高
    const decrement = new Map<string, number>();
    for (const p of targets) decrement.set(p.taskId, (decrement.get(p.taskId) ?? 0) + 1);
    const taskPatches: Task[] = [];
    for (const [taskId, n] of decrement) {
      const task = this._tasks.find((t) => t.id === taskId);
      if (task) taskPatches.push({ ...task, actualPomoNum: Math.max(0, task.actualPomoNum - n) });
    }

    const removed = targets.map((p) => ({ ...p, state: STATE_DELETED }));
    const pushedAt = Date.now();
    await this.sync({ pomodoros: removed, tasks: taskPatches });
    this.mergeArray(this._pomodoros, removed);
    if (taskPatches.length) this.mergeArray(this._tasks, taskPatches);

    const rejected = await this.verifyApplied(
      "pomodoros",
      removed.map((p) => ({ id: p.id, fields: { state: STATE_DELETED } })),
      pushedAt
    );
    if (rejected.length) {
      this.lastFetchedAt = 0;
      throw new Error(
        `${rejected.length}/${removed.length} 筆番茄鐘無法確認刪除：` +
        rejected.map((r) => r.reason).join("; ")
      );
    }

    return {
      deleted: removed.length,
      focusSeconds: targets.reduce((s, p) => s + p.interval, 0),
    };
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
      type: params.isTag ? TYPE_TAG : TYPE_LIST,
      // reduce 而非 spread，理由同 nextTaskOrder
      order: this._projects.reduce((min, p) => Math.min(min, p.order), 0) - 1000,
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

  /** 清單改名／改色。收件匣是 magic 不是真 project，改不了。 */
  async updateProject(
    nameOrId: string,
    updates: { name?: string; color?: string }
  ): Promise<Project> {
    await this.freshData();

    const target = this.resolveProject(nameOrId);
    if (updates.name && updates.name !== target.name) {
      const clash = this._projects.find(
        (p) =>
          p.id !== target.id &&
          !p.isDeleted &&
          isRealProject(p) &&
          p.name.toLowerCase() === updates.name!.toLowerCase()
      );
      if (clash) throw new Error(`已經有一個叫「${updates.name}」的${clash.type === TYPE_TAG ? "標籤" : "清單"}了`);
    }

    // ⚠️ 一定要濾掉 undefined。`{...target, color: undefined}` 會把原本的顏色蓋掉，
    // JSON.stringify 再把該欄位整個省略，server 收到不完整物件就回 status=-9。
    // 呼叫端傳「沒有要改的欄位＝undefined」是很自然的寫法，防在這裡而非要求每個呼叫端自律。
    const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    const updated: Project = { ...target, ...clean };
    const pushedAt = Date.now();
    await this.sync({ projects: [updated] });
    this.mergeArray(this._projects, [updated]);

    await this.verifyOneOrThrow("projects", updated.id, { name: updated.name }, pushedAt);
    return updated;
  }

  /**
   * 刪除清單。
   *
   * ⚠️ 實測：server 刪清單時不會動裡面的任務——它們的 projectId 會繼續指向
   * 一個已刪除的清單，在 App 任何視圖都看不到，也救不回來。所以這裡不允許
   * 靜默留下孤兒：清單裡還有活著的任務時，呼叫端一定要指定去處。
   */
  async deleteProject(
    nameOrId: string,
    opts?: { moveTasksTo?: string }
  ): Promise<{ project: Project; movedTasks: number; movedTo?: string }> {
    await this.freshData();

    const target = this.resolveProject(nameOrId);
    const isTag = target.type === TYPE_TAG;

    // 標籤沒有 projectId 歸屬問題，任務只是 tags 欄位引用它
    const inside = isTag
      ? []
      : this._tasks.filter((t) => t.projectId === target.id && !t.isDeleted);

    let movedTo: Project | undefined;
    if (inside.length) {
      if (!opts?.moveTasksTo) {
        throw new Error(
          `「${target.name}」裡還有 ${inside.length} 個未刪除的任務。` +
          `直接刪清單會讓它們變成 App 看不到的孤兒，所以請先指定 moveTasksTo` +
          `（要搬去的清單名稱，可用「收件匣」），或先自行刪掉那些任務。`
        );
      }
      // 用 mustFindProject 而非 resolveProject：後者擋的是「不能被改動的目標」，
      // 而收件匣雖然改不了名也刪不掉，卻正是最常見的搬移去處。
      movedTo = this.mustFindProject(opts.moveTasksTo);
      if (movedTo.id === target.id) throw new Error("不能把任務搬到正在刪除的清單");
      if (movedTo.type === TYPE_TAG) throw new Error(`「${movedTo.name}」是標籤不是清單，不能當任務的去處`);

      const moved = await this.updateTasks(
        inside.map((t) => t.id),
        { projectId: movedTo.id }
      );
      if (moved.failed.length) {
        throw new Error(
          `搬移任務時有 ${moved.failed.length} 個失敗，清單未刪除（避免製造孤兒）：` +
          moved.failed.map((f) => f.reason).join("; ")
        );
      }
    }

    const deleted: Project = { ...target, isDeleted: true, state: STATE_DELETED };
    const pushedAt = Date.now();
    await this.sync({ projects: [deleted] });
    this.mergeArray(this._projects, [deleted]);

    await this.verifyOneOrThrow("projects", deleted.id, { isDeleted: true }, pushedAt);
    return { project: deleted, movedTasks: inside.length, movedTo: movedTo?.name };
  }

  /** 依名稱或 ID 找清單／標籤，並擋掉不能被改動的目標 */
  private resolveProject(nameOrId: string): Project {
    const byId = this._projects.find((p) => p.id === nameOrId && isRealProject(p));
    const found = byId ?? this.findProject(nameOrId);
    if (!found) return this.mustFindProject(nameOrId); // 借用它的錯誤訊息（會列出可選項）
    if (found.id === INBOX_PROJECT_ID) {
      throw new Error("收件匣是系統內建的，不能改名或刪除");
    }
    if (found.isDefault) throw new Error(`「${found.name}」是預設清單，不能改名或刪除`);
    return found;
  }

  // ===== 統計 API =====

  async getStats(filters?: {
    startDate?: number;
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

    if (filters?.projectName) {
      const project = this.mustFindProject(filters.projectName);
      const inProject =
        project.type === TYPE_TAG
          ? tasks.filter((t) => t.tags.includes(project.id))
          : tasks.filter((t) => t.projectId === project.id);
      const taskIds = new Set(inProject.map((t) => t.id));
      pomos = pomos.filter((p) => taskIds.has(p.taskId));
      tasks = inProject;
    }

    // 完成數只算範圍內完成的，否則 "本週統計" 會混進歷史累計
    const completedTasks = tasks.filter(
      (t) => t.isFinished && (!filters?.startDate || t.finishedDate >= filters.startDate)
    ).length;

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
        .map(([projId, s]) => ({ name: this.projectNameOf(projId) || "未分類", ...s }))
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
    | "reminderDate" | "pomodoroInterval"
  >
> & { projectName?: string };

/** 今天的當地時區起訖時間 */
export function todayBounds(): { start: number; end: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return { start: d.getTime(), end: d.getTime() + 86400000 };
}
