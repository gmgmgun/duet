import { useCallback, useEffect, useState } from 'react';
import { getTasks } from '../api';
import type { Task } from '../types';

/** 작업 목록 폴링 (2.5초) + SSE status 이벤트로 받은 요약 병합 */
export function useTasks(intervalMs = 2500) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getTasks();
      setTasks(data.tasks);
      setRunning(data.running);
    } catch {
      /* 서버 일시 단절 — 다음 폴링에서 복구 */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  /** SSE status 이벤트로 받은 최신 작업 요약을 목록에 반영 (없으면 추가) */
  const patchTask = useCallback((t: Task) => {
    setTasks((prev) =>
      prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? t : x)) : [t, ...prev],
    );
  }, []);

  return { tasks, running, refresh, patchTask };
}
