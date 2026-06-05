import type { Task } from '../types';
import { Badge } from './Badge';

interface TaskListProps {
  tasks: Task[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, selected, onSelect }: TaskListProps) {
  if (!tasks.length) {
    return (
      <div className="flex-1 overflow-y-auto px-[10px] pb-[14px]">
        <div className="text-center text-dim px-5 py-10 text-[13px] leading-[1.8]">
          아직 작업이 없습니다.
          <br />
          요구사항을 입력하고 시작하세요.
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-[10px] pb-[14px]">
      {tasks.map((t) => (
        <div
          key={t.id}
          className={`px-3 py-[11px] mx-2 my-[6px] border rounded cursor-pointer transition-colors duration-150
            ${t.id === selected ? 'border-codex bg-codex-dim' : 'border-line hover:border-bright'}`}
          onClick={() => onSelect(t.id)}
        >
          <div className="text-[13px] leading-normal text-fg line-clamp-2">
            {t.parentId && (
              <span className="text-codex mr-1" title="이전 작업에서 이어진 후속 작업">
                ↳
              </span>
            )}
            {t.requirement}
          </div>
          <div className="flex gap-[10px] mt-[7px] text-[11.5px] text-dim items-center">
            <Badge status={t.status} />
            <span>{t.mode || 'single'}</span>
            <span>
              iter {t.iteration}/{t.maxIterations}
            </span>
            <span>
              {new Date(t.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
