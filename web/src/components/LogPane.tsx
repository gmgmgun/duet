import { useLayoutEffect, useRef, useState } from 'react';
import { ApiError, continueTask } from '../api';
import type { LogEvent, Task, ViewMode } from '../types';
import { FINISHED_STATUSES } from '../types';
import { Badge } from './Badge';
import { LogEntry } from './LogEntry';
import { inputCls } from './ui';

interface LogPaneProps {
  task: Task | null;
  events: LogEvent[];
  view: ViewMode;
  onView: (m: ViewMode) => void;
  onStop: () => void;
  /** 이어가기로 생성된 후속 작업 선택 콜백 */
  onCreated: (id: string) => void;
}

/** 종료된 작업 하단의 이어가기 입력창 — 같은 폴더·세션에서 후속 작업을 시작한다 */
function FollowUpComposer({ task, onCreated }: { task: Task; onCreated: (id: string) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const requirement = text.trim();
    if (!requirement || busy) return;
    setErr('');
    setBusy(true);
    try {
      const nt = await continueTask(task.id, { requirement });
      setText('');
      onCreated(nt.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '서버에 연결할 수 없습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line bg-raise px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          rows={2}
          className={`${inputCls} flex-1 resize-y min-h-[42px] leading-[1.5]`}
          placeholder="이 작업에 이어서 추가 요구사항 입력… (같은 폴더에서 이전 맥락을 이어 진행 · Ctrl+Enter)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <button
          className="font-disp text-[11px] font-bold tracking-[.14em] text-ink bg-ok rounded-[3px] px-4 py-[10px]
            cursor-pointer whitespace-nowrap transition-[filter] duration-150 hover:brightness-112
            disabled:bg-bright disabled:text-dim disabled:cursor-default disabled:brightness-100"
          disabled={busy || !text.trim()}
          onClick={submit}
        >
          ↳ 이어서 시작
        </button>
      </div>
      {err && <div className="text-err text-[12px] mt-[6px]">{err}</div>}
    </div>
  );
}

/** 마이크로 이터레이션 진행: 완료 ✓ / 현재 ● / 대기 ○ */
function StepProgress({ t }: { t: Task }) {
  if (t.steps.length) {
    const done = t.status === 'approved';
    const dots = t.steps
      .map((s, i) => (s.status === 'done' ? '✓' : !done && i === (t.currentStep || 0) ? '●' : '○'))
      .join('');
    const cur = Math.min((t.currentStep || 0) + 1, t.steps.length);
    return (
      <>
        STEP <b className="text-fg">{cur}</b>/{t.steps.length}
        <span className="tracking-[2px] text-ok mx-1">{dots}</span>· ITER{' '}
        <b className="text-fg">{t.iteration}</b>
      </>
    );
  }
  return (
    <>
      ITER <b className="text-fg">{t.iteration}</b>/{t.maxIterations}
    </>
  );
}

// 대화 모드: 도구 호출·원시 진행 로그·부가 정보를 숨기고 두 AI의 메시지만
const CHAT_HIDDEN = new Set(['tool', 'raw', 'info']);

export function LogPane({ task, events, view, onView, onStop, onCreated }: LogPaneProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // 바닥 근처일 때만 자동 스크롤

  const visible = view === 'chat' ? events.filter((e) => !CHAT_HIDDEN.has(e.kind)) : events;

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, view, task?.id]);

  const toggleCls = (on: boolean) =>
    `font-disp text-[10.5px] font-semibold tracking-[.1em] px-[11px] py-[5px] border-none cursor-pointer transition-colors duration-150 ${
      on ? 'bg-bright text-fg' : 'bg-transparent text-dim'
    }`;

  return (
    <section className="flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-[14px] px-5 py-3 border-b border-line bg-raise min-h-[54px]">
        <div
          className="text-[13.5px] text-fg flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis"
          title={task ? `${task.requirement}\n${task.cwd}` : undefined}
        >
          {task ? task.requirement : '—'}
        </div>
        <div className="font-disp text-[11px] tracking-[.12em] text-dim whitespace-nowrap">
          {task && <StepProgress t={task} />}
        </div>
        {task && <Badge status={task.status} />}
        <div className="flex border border-bright rounded-[3px] overflow-hidden">
          <button className={toggleCls(view === 'chat')} onClick={() => onView('chat')}>
            대화
          </button>
          <button
            className={`${toggleCls(view === 'full')} border-l border-bright`}
            onClick={() => onView('full')}
          >
            전체
          </button>
        </div>
        {task && (task.status === 'running' || task.status === 'queued') && (
          <button
            className="font-disp text-[11px] font-semibold tracking-[.14em] text-err bg-transparent border border-err
              rounded-[3px] px-[14px] py-[6px] cursor-pointer transition-colors duration-150 hover:bg-err hover:text-[#1a0b0c]"
            onClick={onStop}
          >
            ■ STOP
          </button>
        )}
      </div>

      <div
        ref={logRef}
        className="flex-1 overflow-y-auto pt-4 pb-[30px]"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {task ? (
          visible.map((e, i) => <LogEntry key={i} event={e} />)
        ) : (
          <div className="flex h-full items-center justify-center flex-col gap-[10px] text-faint text-[13px] tracking-[.06em]">
            <div className="font-disp text-[15px] tracking-[.3em] text-dim">DUET</div>
            <div>좌측에서 작업을 선택하거나 새 작업을 시작하세요</div>
          </div>
        )}
      </div>

      {/* 종료된 작업: 이어가기 입력창 (작업 전환 시 입력 초기화를 위해 key 사용) */}
      {task && FINISHED_STATUSES.has(task.status) && (
        <FollowUpComposer key={task.id} task={task} onCreated={onCreated} />
      )}
    </section>
  );
}
