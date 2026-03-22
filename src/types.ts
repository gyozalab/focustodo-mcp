/** Focus To-Do API 型別定義 */

export interface LoginResponse {
  status: number;
  acct: string;
  jsessionId: string;
  uid: string;
  pid: string;
  name: string;
  portrait?: string;
  expiredDate?: number;
  avatarTimestamp?: number;
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

export interface Schedule {
  id: string;
  taskId: string;
  subtaskId: string;
  interval: number;
  endDate: number;
  creationDate: number;
  state: number;
}

export interface SyncResponse {
  status: number;
  timestamp: number;
  jsessionId?: string;
  projects: Project[];
  tasks: Task[];
  subtasks: Subtask[];
  pomodoros: Pomodoro[];
  schedules: Schedule[];
}

export interface Credentials {
  cookies: string;
  acct: string;
  name: string;
  pid: string;
  uid: string;
}
