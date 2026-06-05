import { useEffect, useMemo, useRef, useState } from 'react';
import { fsList } from '../api';
import { inputCls } from './ui';

/* ───── 최근 사용 폴더 (localStorage) ─────
   제안 목록 = 최근 사용(RECENT) + 작업 목록의 cwd. 작업 cwd는 매번 다시 수집되므로
   "삭제"는 숨김 목록(HIDDEN)에 넣어 다시 떠오르지 않게 한다. 같은 경로를 다시 쓰면 숨김 해제. */

const RECENT_KEY = 'duet-recent-cwds';
const HIDDEN_KEY = 'duet-hidden-cwds';
const RECENT_MAX = 8;
const HIDDEN_MAX = 50;

function loadList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function loadRecents(): string[] {
  return loadList(RECENT_KEY);
}

export function saveRecent(p: string) {
  saveList(RECENT_KEY, [p, ...loadRecents().filter((x) => x !== p)].slice(0, RECENT_MAX));
  saveList(HIDDEN_KEY, loadList(HIDDEN_KEY).filter((x) => x !== p)); // 다시 쓰면 숨김 해제
}

export function removeRecent(p: string) {
  saveList(RECENT_KEY, loadRecents().filter((x) => x !== p));
  saveList(HIDDEN_KEY, [p, ...loadList(HIDDEN_KEY).filter((x) => x !== p)].slice(0, HIDDEN_MAX));
}

export function clearRecents(paths: string[]) {
  saveList(RECENT_KEY, []);
  saveList(HIDDEN_KEY, [...new Set([...paths, ...loadList(HIDDEN_KEY)])].slice(0, HIDDEN_MAX));
}

/** localStorage 최근 목록 + 작업 목록의 cwd를 합치고(중복 제거) 숨긴 항목을 제외 */
export function mergeRecents(suggestions: string[]): string[] {
  const hidden = new Set(loadList(HIDDEN_KEY));
  return [...new Set([...loadRecents(), ...suggestions])].filter((p) => !hidden.has(p));
}

/* ───── 경로 입력 + 자동 완성 + 실시간 검증 ───── */

type Validity = 'idle' | 'checking' | 'ok' | 'bad';

const ABS_RE = /^([A-Za-z]:[\\/]|\\\\|\/)/; // 윈도우 드라이브·UNC·POSIX 절대 경로

interface PathInputProps {
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  /** 작업 목록에서 수집한 cwd들 — localStorage 최근 목록과 합쳐 제안한다 */
  suggestions: string[];
}

export function PathInput({ value, onChange, onBrowse, suggestions }: PathInputProps) {
  const [open, setOpen] = useState(false);
  const [bump, setBump] = useState(0); // 삭제 후 목록 재계산 트리거
  const [validity, setValidity] = useState<Validity>('idle');
  const seqRef = useRef(0); // 늦게 도착한 응답이 최신 상태를 덮지 않도록
  const inputRef = useRef<HTMLInputElement>(null);

  // 포커스가 없을 때는 경로의 꼬리(폴더명) 쪽이 보이도록 끝으로 스크롤
  // (모달/드롭다운에서 경로를 골랐을 때 머리만 보이는 문제 방지)
  useEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  }, [value]);

  // 입력이 멈추면 400ms 후 폴더 존재 여부 확인
  useEffect(() => {
    const p = value.trim();
    if (!p) {
      setValidity('idle');
      return;
    }
    if (!ABS_RE.test(p)) {
      setValidity('bad');
      return;
    }
    setValidity('checking');
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        await fsList(p);
        if (seq === seqRef.current) setValidity('ok');
      } catch {
        if (seq === seqRef.current) setValidity('bad');
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [value]);

  const items = useMemo(() => {
    const all = mergeRecents(suggestions);
    const q = value.trim().toLowerCase();
    return q ? all.filter((p) => p.toLowerCase().includes(q) && p.toLowerCase() !== q) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, value, bump, open]);

  return (
    <div className="relative">
      <div className="flex gap-[6px]">
        <div className="relative flex-1 min-w-0">
          <input
            ref={inputRef}
            className={`${inputCls} ${value ? 'pr-11' : 'pr-7'} ${validity === 'bad' ? 'border-err/50 focus:border-err/70' : ''}`}
            placeholder="C:\Users\GIC\repo\my-project"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={(e) => {
              setOpen(false);
              e.target.scrollLeft = e.target.scrollWidth; // 블러 시 꼬리 표시
            }}
            title={validity === 'bad' ? '폴더를 찾을 수 없습니다' : value || undefined}
          />
          {value && (
            <button
              type="button"
              className="absolute right-[24px] top-1/2 -translate-y-1/2 text-[11px] text-faint hover:text-err cursor-pointer select-none"
              title="경로 지우기"
              // onMouseDown: 입력란 포커스를 유지한 채 비운다 (드롭다운도 열린 상태 유지)
              onMouseDown={(e) => {
                e.preventDefault();
                onChange('');
                inputRef.current?.focus();
              }}
            >
              ✕
            </button>
          )}
          <span
            className={`absolute right-[9px] top-1/2 -translate-y-1/2 text-[11px] pointer-events-none select-none
              ${validity === 'ok' ? 'text-ok' : validity === 'bad' ? 'text-err' : 'text-faint'}`}
          >
            {validity === 'ok' ? '✓' : validity === 'bad' ? '✗' : validity === 'checking' ? '…' : ''}
          </span>
        </div>
        <button
          type="button"
          title="폴더 탐색"
          className="w-9 bg-bg border border-line rounded-[3px] cursor-pointer text-sm transition-colors duration-150 hover:border-bright"
          onClick={onBrowse}
        >
          📁
        </button>
      </div>

      {open && items.length > 0 && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-panel border border-bright rounded-[3px] shadow-[0_10px_30px_rgba(0,0,0,.5)] max-h-[200px] overflow-y-auto">
          <div className="flex items-center justify-between px-[10px] pt-[6px] pb-1">
            <span className="font-disp text-[9.5px] font-semibold tracking-[.18em] text-faint uppercase">
              최근 폴더
            </span>
            <button
              className="text-[10px] text-faint hover:text-err cursor-pointer"
              title="최근 내역 모두 삭제"
              // onMouseDown: blur(드롭다운 닫힘)보다 먼저 실행되도록
              onMouseDown={(e) => {
                e.preventDefault();
                clearRecents(mergeRecents(suggestions));
                setBump((b) => b + 1);
              }}
            >
              모두 지우기
            </button>
          </div>
          {items.map((p) => (
            <div
              key={p}
              className="group flex items-center gap-2 px-[10px] py-[6px] text-[12px] cursor-pointer text-dim hover:text-fg hover:bg-codex-dim"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(p);
                setOpen(false);
              }}
            >
              <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={p}>
                {p}
              </span>
              <button
                className="opacity-0 group-hover:opacity-100 shrink-0 text-[11px] text-faint hover:text-err cursor-pointer"
                title="목록에서 삭제"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeRecent(p);
                  setBump((b) => b + 1);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
