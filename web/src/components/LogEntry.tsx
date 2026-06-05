import { memo } from 'react';
import { renderMarkdown } from '../markdown';
import type { LogEvent } from '../types';

const WHO: Record<string, string> = { claude: 'CLAUDE', codex: 'CODEX' };
const WHO_COLOR: Record<string, string> = {
  claude: 'text-claude',
  codex: 'text-codex',
  system: 'text-faint',
};

const bodyBase = 'whitespace-pre-wrap break-words leading-[1.65] text-[13.5px]';

// AI 발화(text) 강조 박스 — 역할 색의 보더 + 옅은 배경
const textBox: Record<string, string> = {
  claude: `${bodyBase} text-fg border-l-2 border-claude pl-3 py-[6px] bg-claude-dim rounded-r-[3px]`,
  codex: `${bodyBase} text-fg border-l-2 border-codex pl-3 py-[6px] bg-codex-dim rounded-r-[3px]`,
};

function bodyCls(e: LogEvent): string {
  switch (e.kind) {
    case 'text':
      return textBox[e.role] ?? bodyBase;
    case 'tool':
    case 'raw':
      return `${bodyBase} text-dim text-[12.5px]`;
    case 'info':
      return `${bodyBase} text-dim italic`;
    case 'error':
      return `${bodyBase} text-err`;
    case 'plan':
      return `${bodyBase} text-fg border-l-2 border-warn pl-3 py-[7px] bg-[rgba(255,209,115,.07)] rounded-r-[3px] text-xs`;
    case 'phase':
      return 'font-disp text-[11px] font-semibold tracking-[.2em] uppercase text-warn border-t border-dashed border-bright pt-[10px] whitespace-pre-wrap break-words';
    default:
      return bodyBase;
  }
}

export const LogEntry = memo(function LogEntry({ event: e }: { event: LogEvent }) {
  const isMd = e.kind === 'text' && (e.role === 'claude' || e.role === 'codex');
  return (
    <div
      className={`grid grid-cols-[86px_1fr] gap-[14px] px-5 py-[5px] animate-fade ${e.kind === 'phase' ? 'mt-[14px] mb-[6px]' : ''}`}
    >
      <div
        className={`font-disp text-[10.5px] font-semibold tracking-[.14em] text-right pt-[3px] select-none ${WHO_COLOR[e.role] ?? 'text-faint'}`}
      >
        {WHO[e.role] ?? 'SYS'}
      </div>
      {isMd ? (
        // AI 메시지는 마크다운 렌더링 — renderMarkdown()이 입력을 전부 이스케이프한다
        <div
          className={`${bodyCls(e)} md`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(e.text) }}
        />
      ) : (
        <div className={bodyCls(e)}>
          {e.kind === 'tool' && <span className="text-faint">▸ </span>}
          {e.text}
        </div>
      )}
    </div>
  );
});
