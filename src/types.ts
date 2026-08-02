/** Focus To-Do API 型別定義 */

export interface LoginResponse {
  status: number;
  acct: string;
  jsessionId: string;
  uid: string;
  pid: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  type: number;
  order: number;
  isDefault: boolean;
  isDeleted: boolean;
  state: number;
  parentId: string;
  creationDate: number;
}

export interface Task {
  id: string;
  name: string;
  projectId: string;
  tags: string;
  priority: number; // 0=none, 1=low, 2=medium, 3=high
  estimatePomoNum: number;
  actualPomoNum: number;
  pomodoroInterval: number; // seconds (default 1500 = 25min)
  deadline: number; // epoch ms, 0 = no deadline
  reminderDate: number;
  creationDate: number;
  finishedDate: number;
  isFinished: boolean;
  isDeleted: boolean;
  hasSubtask: boolean;
  remark: string;
  order: number;
  state: number;
  // Repeat fields
  rCycle: number;
  rFirstDeadline: number;
  rUnit: string;
  rValue: string;
  rId: string;
}

export interface Subtask {
  id: string;
  name: string;
  taskId: string;
  order: number;
  isFinished: boolean;
  isDeleted: boolean;
  finishedDate: number;
  creationDate: number;
  estimatedPomoNum: number;
  state: number;
}

export interface Pomodoro {
  id: string;
  taskId: string;
  subtaskId: string;
  interval: number; // actual seconds focused
  pomodoroInterval: number; // target seconds
  endDate: number; // epoch ms
  creationDate: number;
  state: number;
  isManual: boolean;
}

export interface SyncResponse {
  status: number;
  timestamp: number;
  jsessionId?: string;
  projects: Project[];
  tasks: Task[];
  subtasks: Subtask[];
  pomodoros: Pomodoro[];
  // schedules 一律送 "[]" 也從不讀，故不建模
}

export interface Credentials {
  cookies: string;
  acct: string;
  name: string;
  pid: string;
  uid: string;
}

/** Task enriched with resolved project name and tag names (returned by getTasks) */
export type EnrichedTask = Task & {
  projectName?: string;
  tagNames?: string;
};
