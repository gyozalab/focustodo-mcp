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
} from "./types.js";

const BASE_URL = "https://app.hk1.focustodo.net";
const CLIENT_NAME = "focustodo-mcp";

export class FocusToDoAPI {
  private creds: Credentials | null = null;
  private clientId = randomUUID();
  private syncTimestamp = 0;

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

    const res = await fetch(`${BASE_URL}/v63/user/login`, {
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
  async sync(payload?: {
    projects?: Partial<Project>[];
    tasks?: Partial<Task>[];
    subtasks?: Partial<Subtask>[];
  }): Promise<SyncResponse> {
    const creds = await this.ensureAuth();

    const body = new URLSearchParams({
      timestamp: String(this.syncTimestamp),
      clientId: this.clientId,
      client: CLIENT_NAME,
      projects: JSON.stringify(payload?.projects || []),
      tasks: JSON.stringify(payload?.tasks || []),
      subtasks: JSON.stringify(payload?.subtasks || []),
      pomodoros: "[]",
      schedules: "[]",
      acct: creds.acct,
      name: creds.name,
      pid: creds.pid,
      uid: creds.uid,
    });

    const res = await fetch(`${BASE_URL}/v64/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: creds.cookies,
      },
      body: body.toString(),
    });

    const data = (await res.json()) as SyncResponse;

    if (data.status !== 0) {
      // Session expired — re-login and retry
      if (data.status === -1 || data.status === -2) {
        this.creds = null;
        return this.sync(payload);
      }
      throw new Error(`Sync failed: status=${data.status}`);
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

  /** 確保有資料（首次會做全量同步） */
  private async ensureData(): Promise<void> {
    if (this._projects.length === 0) {
      await this.sync();
    }
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
  }): Promise<(Task & { projectName?: string })[]> {
    await this.ensureData();

    let tasks = this._tasks.filter((t) => !filters?.includeDeleted ? !t.isDeleted : true);

    if (filters?.projectId) {
      tasks = tasks.filter((t) => t.projectId === filters.projectId);
    }
    if (filters?.projectName) {
      const nameLC = filters.projectName.toLowerCase();
      const project = this._projects.find(
        (p) => p.name.toLowerCase().includes(nameLC)
      );
      if (project) {
        if (project.type === 3000) {
          // 標籤型清單（Blog、iPAS 等）：tags 欄位存的是 project ID
          tasks = tasks.filter((t) => t.tags.includes(project.id));
        } else {
          // 一般清單：直接比對 projectId
          tasks = tasks.filter((t) => t.projectId === project.id);
        }
      }
    }
    if (filters?.tag) {
      // tags 存的是 project ID，先找對應的 tag project
      const tagProject = this._projects.find(
        (p) => p.type === 3000 && p.name.toLowerCase().includes(filters.tag!.toLowerCase())
      );
      if (tagProject) {
        tasks = tasks.filter((t) => t.tags.includes(tagProject.id));
      }
    }
    if (filters?.priority !== undefined) {
      tasks = tasks.filter((t) => t.priority === filters.priority);
    }
    if (filters?.isFinished !== undefined) {
      tasks = tasks.filter((t) => t.isFinished === filters.isFinished);
    }

    // Enrich with project name and resolve tag IDs to names
    return tasks.map((t) => {
      const tagNames = t.tags
        ? t.tags.split(",").filter(Boolean).map((id) => {
            const proj = this._projects.find((p) => p.id === id.trim());
            return proj ? `#${proj.name}` : "";
          }).filter(Boolean).join(" ")
        : "";
      return {
        ...t,
        projectName: this._projects.find((p) => p.id === t.projectId)?.name,
        tagNames,
      };
    });
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

    let pomos = this._pomodoros;

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

  async createTask(params: {
    name: string;
    projectName?: string;
    projectId?: string;
    tags?: string;
    priority?: number;
    estimatePomoNum?: number;
    deadline?: number;
    remark?: string;
  }): Promise<Task> {
    await this.ensureData();

    // Resolve project
    let projectId = params.projectId || "";
    if (!projectId && params.projectName) {
      const project = this._projects.find((p) =>
        p.name.toLowerCase().includes(params.projectName!.toLowerCase())
      );
      if (project) {
        projectId = project.id;
      }
    }

    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      name: params.name,
      projectId,
      tags: params.tags || "",
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
      state: 0,
      rCycle: 0,
      rFirstDeadline: 0,
      rUnit: "",
      rValue: "",
      rId: "",
    };

    await this.sync({ tasks: [task] });
    return task;
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<Task, "name" | "tags" | "priority" | "estimatePomoNum" | "deadline" | "remark" | "projectId" | "isFinished" | "finishedDate">>
  ): Promise<Task | null> {
    await this.ensureData();

    const task = this._tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const updated = { ...task, ...updates };
    await this.sync({ tasks: [updated] });
    return updated;
  }

  async completeTask(taskId: string): Promise<Task | null> {
    return this.updateTask(taskId, {
      isFinished: true,
      finishedDate: Date.now(),
    });
  }

  async deleteTask(taskId: string): Promise<Task | null> {
    return this.updateTask(taskId, {
      isDeleted: true,
    } as any);
  }

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
      state: 0,
    };

    await this.sync({ subtasks: [subtask] });
    return subtask;
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
  }> {
    await this.ensureData();

    let pomos = this._pomodoros;
    let tasks = this._tasks.filter((t) => !t.isDeleted);

    if (filters?.startDate) {
      pomos = pomos.filter((p) => p.endDate >= filters.startDate!);
    }
    if (filters?.endDate) {
      pomos = pomos.filter((p) => p.endDate <= filters.endDate!);
    }
    if (filters?.projectName) {
      const project = this._projects.find((p) =>
        p.name.toLowerCase().includes(filters.projectName!.toLowerCase())
      );
      if (project) {
        const taskIds = new Set(tasks.filter((t) => t.projectId === project.id).map((t) => t.id));
        pomos = pomos.filter((p) => taskIds.has(p.taskId));
        tasks = tasks.filter((t) => t.projectId === project.id);
      }
    }

    const totalFocusTime = pomos.reduce((sum, p) => sum + p.interval, 0);

    // Project breakdown
    const projectMap = new Map<string, { focusTime: number; pomodoros: number }>();
    for (const p of pomos) {
      const task = this._tasks.find((t) => t.id === p.taskId);
      const projId = task?.projectId || "unknown";
      const existing = projectMap.get(projId) || { focusTime: 0, pomodoros: 0 };
      existing.focusTime += p.interval;
      existing.pomodoros += 1;
      projectMap.set(projId, existing);
    }

    const projectBreakdown = Array.from(projectMap.entries())
      .map(([projId, stats]) => ({
        name: this._projects.find((p) => p.id === projId)?.name || "未分類",
        ...stats,
      }))
      .sort((a, b) => b.focusTime - a.focusTime);

    return {
      totalFocusTime,
      totalPomodoros: pomos.length,
      completedTasks: tasks.filter((t) => t.isFinished).length,
      pendingTasks: tasks.filter((t) => !t.isFinished).length,
      projectBreakdown,
    };
  }

  async getTodayFocus(): Promise<{
    focusTime: number;
    pomodoros: number;
    tasks: { name: string; focusTime: number; pomodoros: number }[];
  }> {
    await this.ensureData();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfDay = today.getTime();
    const endOfDay = startOfDay + 86400000;

    const pomos = this._pomodoros.filter(
      (p) => p.endDate >= startOfDay && p.endDate < endOfDay
    );

    const taskMap = new Map<string, { focusTime: number; pomodoros: number }>();
    for (const p of pomos) {
      const existing = taskMap.get(p.taskId) || { focusTime: 0, pomodoros: 0 };
      existing.focusTime += p.interval;
      existing.pomodoros += 1;
      taskMap.set(p.taskId, existing);
    }

    const tasks = Array.from(taskMap.entries())
      .map(([taskId, stats]) => ({
        name: this._tasks.find((t) => t.id === taskId)?.name || "未知任務",
        ...stats,
      }))
      .sort((a, b) => b.focusTime - a.focusTime);

    return {
      focusTime: pomos.reduce((sum, p) => sum + p.interval, 0),
      pomodoros: pomos.length,
      tasks,
    };
  }
}
