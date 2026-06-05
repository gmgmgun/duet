import type { FsListing, NewTaskInput, Task } from './types';

/** API 오류 — 서버가 내려준 한국어 메시지를 그대로 담는다 */
export class ApiError extends Error {}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || '요청 실패');
  return data as T;
}

export function getTasks(): Promise<{ tasks: Task[]; running: boolean }> {
  return request('/api/tasks');
}

export function createTask(input: NewTaskInput): Promise<Task> {
  return request('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function stopTask(id: string): Promise<{ ok: boolean }> {
  return request(`/api/tasks/${id}/stop`, { method: 'POST' });
}

/** 종료된 작업을 이어가는 후속 작업 생성 — cwd·모드·권한·Claude 세션을 상속 */
export function continueTask(
  id: string,
  input: { requirement: string; maxIterations?: number },
): Promise<Task> {
  return request(`/api/tasks/${id}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function fsList(path?: string | null): Promise<FsListing> {
  return request('/api/fs' + (path ? `?path=${encodeURIComponent(path)}` : ''));
}

export function fsMkdir(path: string): Promise<{ path: string }> {
  return request('/api/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}
