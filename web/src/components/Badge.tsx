import type { TaskStatus } from '../types';
import { STATUS_KO } from '../types';

const STYLES: Record<TaskStatus, string> = {
  queued: 'text-dim border border-bright',
  running: 'text-ink bg-claude animate-badge',
  approved: 'text-ink bg-ok',
  stopped: 'text-dim bg-line',
  interrupted: 'text-dim bg-line',
  error: 'text-[#1a0b0c] bg-err',
  max_iterations: 'text-[#1a1305] bg-warn',
};

export function Badge({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`font-disp text-[9.5px] font-semibold tracking-[.1em] px-[7px] py-[2px] rounded-[2px] uppercase ${STYLES[status] ?? 'text-dim bg-line'}`}
    >
      {STATUS_KO[status] ?? status}
    </span>
  );
}
