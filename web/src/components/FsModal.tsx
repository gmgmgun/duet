import { Fragment, useEffect, useState } from 'react';
import { ApiError, fsList, fsMkdir } from '../api';
import type { FsListing } from '../types';
import { clearRecents, removeRecent } from './PathInput';
import { inputCls } from './ui';

interface FsModalProps {
  open: boolean;
  initialPath: string;
  /** 최근 사용 폴더 — 드라이브 화면에서 바로가기로 노출 */
  recents: string[];
  onClose: () => void;
  onPick: (path: string) => void;
}

const footBtnCls =
  'font-disp text-[11px] font-semibold tracking-[.1em] px-[13px] py-2 rounded-[3px] cursor-pointer whitespace-nowrap ' +
  'bg-transparent border border-bright text-dim transition-all duration-150 hover:text-fg hover:border-dim';

const rowCls =
  'group flex items-center gap-[9px] px-4 py-[7px] cursor-pointer text-[13.5px] whitespace-nowrap hover:bg-codex-dim';

/** 경로를 클릭 가능한 브레드크럼 조각으로 분해: C:\Users\GIC → [C:, Users, GIC] */
function crumbs(p: string): { label: string; path: string }[] {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = '';
  for (const part of parts) {
    // 드라이브 루트는 'C:\' 형태여야 절대 경로로 해석된다
    acc = acc ? `${acc}\\${part}` : /^[A-Za-z]:$/.test(part) ? `${part}\\` : part;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** 폴더 탐색 모달 — path 없으면 드라이브 목록 + 최근 폴더, 있으면 하위 폴더 목록 */
export function FsModal({ open, initialPath, recents, onClose, onPick }: FsModalProps) {
  const [listing, setListing] = useState<FsListing>({ path: null, parent: null, dirs: [] });
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  // 최근 목록은 모달이 열릴 때 prop에서 스냅샷 — 삭제 시 로컬에서 즉시 반영
  const [recentList, setRecentList] = useState<string[]>([]);

  async function load(p: string | null, fallbackToDrives = false) {
    setErr('');
    try {
      setListing(await fsList(p));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '서버에 연결할 수 없습니다.';
      setErr(msg);
      // 입력된 경로 탐색 실패 시 드라이브 목록으로 복귀 (오류 메시지는 유지)
      if (fallbackToDrives && p) {
        try {
          setListing(await fsList(null));
        } catch {
          /* ignore */
        }
        setErr(msg);
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    setNewName('');
    setRecentList(recents);
    // 입력된 경로가 있으면 거기서 시작(실패 시 드라이브 목록), 없으면 드라이브 목록
    load(initialPath.trim() || null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function mkdir() {
    const name = newName.trim();
    if (!name) {
      setErr('새 폴더 이름을 입력하세요.');
      return;
    }
    if (!listing.path) {
      setErr('드라이브를 먼저 선택하세요.');
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      setErr('폴더 이름에 쓸 수 없는 문자가 있습니다.');
      return;
    }
    try {
      await fsMkdir(listing.path.replace(/[\\/]+$/, '') + '\\' + name);
      setNewName('');
      load(listing.path);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '생성 실패');
    }
  }

  if (!open) return null;

  const atDrives = listing.path === null;
  const segs = listing.path ? crumbs(listing.path) : [];

  /** 폴더 행 — 클릭=진입, 호버 시 '선택' 버튼=즉시 선택, onRemove가 있으면 ✕=내역 삭제 */
  const dirRow = (key: string, icon: string, name: string, path: string, onRemove?: () => void) => (
    <div
      key={key}
      className={`${rowCls} ${onRemove ? 'text-dim' : 'text-fg'}`}
      title={path}
      onClick={() => load(path)}
    >
      <span className="text-warn text-[13px] shrink-0">{icon}</span>
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">{name}</span>
      {onRemove && (
        <button
          className="opacity-0 group-hover:opacity-100 shrink-0 text-[11px] text-faint hover:text-err cursor-pointer
            transition-opacity duration-100"
          title="최근 내역에서 삭제"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      )}
      <button
        className="opacity-0 group-hover:opacity-100 font-disp text-[10px] font-semibold tracking-[.1em] text-ink bg-ok
          rounded-[2px] px-2 py-[2px] cursor-pointer transition-opacity duration-100 hover:brightness-112"
        onClick={(e) => {
          e.stopPropagation();
          onPick(path);
        }}
      >
        선택
      </button>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[560px] max-w-[92vw] max-h-[78vh] flex flex-col bg-panel border border-bright rounded-md shadow-[0_18px_60px_rgba(0,0,0,.6)]">
        <div className="flex items-center justify-between px-4 py-[13px] border-b border-line font-disp text-[11px] font-semibold tracking-[.22em] text-dim uppercase">
          폴더 선택
          <button className="text-dim hover:text-fg cursor-pointer text-sm" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>

        {/* 브레드크럼 — 각 조각 클릭으로 상위 폴더 이동 */}
        <div className="flex items-center gap-[3px] px-4 py-[8px] text-[11.5px] border-b border-line bg-bg overflow-x-auto whitespace-nowrap [scrollbar-width:thin]">
          <button
            className={`cursor-pointer shrink-0 ${atDrives ? 'text-codex' : 'text-dim hover:text-codex'}`}
            onClick={() => load(null)}
          >
            내 PC
          </button>
          {segs.map((s, i) => (
            <Fragment key={s.path}>
              <span className="text-faint shrink-0">›</span>
              <button
                className={`cursor-pointer shrink-0 ${i === segs.length - 1 ? 'text-codex' : 'text-dim hover:text-codex'}`}
                onClick={() => load(s.path)}
              >
                {s.label}
              </button>
            </Fragment>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto min-h-[240px] py-[6px]">
          {/* 드라이브 화면: 최근 사용 폴더 바로가기 */}
          {atDrives && recentList.length > 0 && (
            <>
              <div className="flex items-center justify-between px-4 pt-1 pb-[2px]">
                <span className="font-disp text-[9.5px] font-semibold tracking-[.18em] text-faint uppercase">
                  최근 사용
                </span>
                <button
                  className="text-[10px] text-faint hover:text-err cursor-pointer"
                  title="최근 내역 모두 삭제"
                  onClick={() => {
                    clearRecents(recentList);
                    setRecentList([]);
                  }}
                >
                  모두 지우기
                </button>
              </div>
              {recentList.map((p) =>
                dirRow(`r:${p}`, '🕒', p, p, () => {
                  removeRecent(p);
                  setRecentList((list) => list.filter((x) => x !== p));
                }),
              )}
              <div className="px-4 pt-2 pb-[2px] font-disp text-[9.5px] font-semibold tracking-[.18em] text-faint uppercase">
                드라이브
              </div>
            </>
          )}

          {listing.parent !== null && (
            <div
              className="flex items-center gap-[9px] px-4 py-[7px] cursor-pointer text-[13.5px] text-dim hover:bg-codex-dim"
              onClick={() => load(listing.parent || null)} // parent='' → 드라이브 목록
            >
              <span className="text-warn text-[13px] shrink-0">⬆</span> ..
            </div>
          )}
          {listing.dirs.map((d) => dirRow(d.path, '📁', d.name, d.path))}
          {!listing.dirs.length && !atDrives && (
            <div className="px-4 py-[7px] text-[13.5px] text-dim">(하위 폴더 없음)</div>
          )}
        </div>

        <div className="px-4 py-2 text-err text-[11.5px] min-h-4">{err}</div>
        <div className="flex gap-2 px-4 py-3 border-t border-line items-center">
          <input
            className={`${inputCls} flex-1 min-w-0`}
            placeholder="새 폴더 이름"
            spellCheck={false}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') mkdir();
            }}
          />
          <button className={footBtnCls} onClick={mkdir}>
            ＋ 만들기
          </button>
          <button
            className={`${footBtnCls} bg-ok border-ok text-ink hover:brightness-112 hover:text-ink hover:border-ok
              disabled:bg-bright disabled:border-bright disabled:text-dim disabled:cursor-default disabled:brightness-100`}
            disabled={!listing.path}
            onClick={() => listing.path && onPick(listing.path)}
          >
            이 폴더 선택
          </button>
        </div>
      </div>
    </div>
  );
}
