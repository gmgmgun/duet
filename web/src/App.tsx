import { useCallback, useState } from 'react';
import { stopTask } from './api';
import { Header } from './components/Header';
import { LogPane } from './components/LogPane';
import { TaskForm } from './components/TaskForm';
import { TaskList } from './components/TaskList';
import { headCls } from './components/ui';
import { useTaskEvents } from './hooks/useTaskEvents';
import { useTasks } from './hooks/useTasks';
import type { ViewMode } from './types';

function loadView(): ViewMode {
  try {
    return localStorage.getItem('duet-view') === 'full' ? 'full' : 'chat';
  } catch {
    return 'chat'; // 사생활 모드 등
  }
}

export default function App() {
  const { tasks, running, refresh, patchTask } = useTasks();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(loadView);

  const events = useTaskEvents(selected, patchTask);
  const selectedTask = tasks.find((t) => t.id === selected) ?? null;

  const handleView = useCallback((m: ViewMode) => {
    try {
      localStorage.setItem('duet-view', m);
    } catch {
      /* ignore */
    }
    setView(m);
  }, []);

  const handleCreated = useCallback(
    async (id: string) => {
      await refresh();
      setSelected(id);
    },
    [refresh],
  );

  const handleStop = useCallback(async () => {
    if (!selected) return;
    if (!confirm('이 작업을 중단할까요? 실행 중인 AI 프로세스가 종료됩니다.')) return;
    try {
      await stopTask(selected);
    } catch {
      /* 이미 종료된 작업 등 — 목록 갱신으로 수습 */
    }
    refresh();
  }, [selected, refresh]);

  return (
    <div className="h-full flex flex-col">
      <Header running={running} />
      <main className="grid grid-cols-[380px_1fr] flex-1 min-h-0">
        <aside className="border-r border-line flex flex-col min-h-0">
          <TaskForm onCreated={handleCreated} cwdSuggestions={[...new Set(tasks.map((t) => t.cwd))]} />
          <div className={`${headCls} px-[18px] pt-[14px] mb-2`}>작업 목록</div>
          <TaskList tasks={tasks} selected={selected} onSelect={setSelected} />
        </aside>
        <LogPane
          task={selectedTask}
          events={events}
          view={view}
          onView={handleView}
          onStop={handleStop}
          onCreated={handleCreated}
        />
      </main>
    </div>
  );
}
