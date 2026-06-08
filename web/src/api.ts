import type { FsListing, NewTaskInput, Task } from './types';

/** API 오류 — 서버가 내려준 한국어 메시지를 그대로 담는다 */
export class ApiError extends Error {}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || '요청 실패');
  return data as T;
}

async function request<T>(url: string): Promise<T> {
  return parse(await fetch(url));
}

/** 세션 CSRF 토큰 — 서버 프로세스 수명 동안 유효, 첫 POST 전에 1회 발급받아 캐시 */
let csrfToken: string | null = null;

async function csrf(): Promise<string> {
  if (!csrfToken) {
    const { token } = await request<{ token: string }>('/api/csrf');
    csrfToken = token;
  }
  return csrfToken;
}

async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const send = async () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Duet-Csrf': await csrf() },
      body: JSON.stringify(body),
    });
  let res = await send();
  // 서버 재시작으로 토큰이 무효화된 경우 1회 재발급 후 재시도
  if (res.status === 403) {
    csrfToken = null;
    res = await send();
  }
  return parse(res);
}

export function getTasks(): Promise<{ tasks: Task[]; running: boolean }> {
  return request('/api/tasks');
}

export function createTask(input: NewTaskInput): Promise<Task> {
  return post('/api/tasks', input);
}

export function stopTask(id: string): Promise<{ ok: boolean }> {
  return post(`/api/tasks/${id}/stop`);
}

/** 종료된 작업을 이어가는 후속 작업 생성 — cwd·모드·권한·Claude 세션을 상속 */
export function continueTask(
  id: string,
  input: { requirement: string; acceptanceCriteria?: string[]; maxIterations?: number; minIterations?: number },
): Promise<Task> {
  return post(`/api/tasks/${id}/continue`, input);
}

export function fsList(path?: string | null): Promise<FsListing> {
  return request('/api/fs' + (path ? `?path=${encodeURIComponent(path)}` : ''));
}

export function fsMkdir(path: string): Promise<{ path: string }> {
  return post('/api/fs/mkdir', { path });
}
