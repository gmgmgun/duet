/** 서버(orchestrator.js)의 taskSummary()/emit()과 1:1 대응하는 타입들 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'approved'
  | 'stopped'
  | 'error'
  | 'max_iterations'
  | 'interrupted';

export type CodexSandbox = 'bypass' | 'workspace-write' | 'read-only';
export type TaskMode = 'single' | 'micro' | 'review';

export interface TaskStep {
  title: string;
  status: string; // 'done' | 'pending' 등
}

export interface Task {
  id: string;
  requirement: string;
  cwd: string;
  maxIterations: number;
  codexSandbox: CodexSandbox;
  mode: TaskMode;
  status: TaskStatus;
  iteration: number;
  steps: TaskStep[];
  currentStep: number;
  /** 이어가기(후속 작업): 부모 작업 id — 없으면 새 작업 */
  parentId: string | null;
  parentRequirement: string | null;
  claudeSessionId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** 종료 상태 — 이 상태의 작업만 이어가기 가능 */
export const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'approved',
  'max_iterations',
  'stopped',
  'error',
  'interrupted',
]);

export type Role = 'claude' | 'codex' | 'system';
export type EventKind = 'text' | 'tool' | 'raw' | 'info' | 'error' | 'plan' | 'phase';

export interface LogEvent {
  ts: number;
  iter: number;
  role: Role;
  kind: EventKind;
  text: string;
}

export interface FsEntry {
  name: string;
  path: string;
}

export interface FsListing {
  path: string | null; // null = 드라이브 목록
  parent: string | null; // '' = 드라이브 목록으로 복귀, null = 최상위
  dirs: FsEntry[];
}

export interface NewTaskInput {
  requirement: string;
  cwd: string;
  maxIterations: number;
  codexSandbox: CodexSandbox;
  mode: TaskMode;
}

export type ViewMode = 'chat' | 'full';

export const STATUS_KO: Record<string, string> = {
  queued: '대기',
  running: '진행중',
  approved: '승인됨',
  stopped: '중단됨',
  error: '오류',
  max_iterations: '반복초과',
  interrupted: '중단됨(재시작)',
};
