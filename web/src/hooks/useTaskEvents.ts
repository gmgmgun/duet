import { useEffect, useRef, useState } from 'react';
import type { LogEvent, Task } from '../types';

/**
 * 선택된 작업의 SSE 스트림 구독.
 * 서버가 과거 이벤트를 재생한 뒤 라이브 이벤트를 이어 보낸다.
 * `status` 이벤트(작업 요약 갱신)는 콜백으로 전달한다.
 */
export function useTaskEvents(taskId: string | null, onStatus: (t: Task) => void) {
  const [events, setEvents] = useState<LogEvent[]>([]);

  // 콜백을 ref로 보관해 콜백이 바뀌어도 EventSource를 재연결하지 않는다
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    setEvents([]);
    if (!taskId) return;

    const es = new EventSource(`/api/tasks/${taskId}/events`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as LogEvent;
      setEvents((prev) => [...prev, e]);
    };
    es.addEventListener('status', (ev) => {
      statusRef.current(JSON.parse((ev as MessageEvent).data) as Task);
    });
    return () => es.close();
  }, [taskId]);

  return events;
}
