import { useEffect, useState } from 'react';
import { ApiError, createTask } from '../api';
import type { CodexSandbox, TaskMode } from '../types';
import { FsModal } from './FsModal';
import { loadRecents, mergeRecents, PathInput, saveRecent } from './PathInput';
import { Stepper } from './Stepper';
import { headCls, inputCls, labelCls } from './ui';

interface TaskFormProps {
  onCreated: (id: string) => void;
  /** 작업 목록에서 수집한 cwd들 — 경로 제안에 사용 */
  cwdSuggestions: string[];
}

const CWD_KEY = 'duet-cwd';

export function TaskForm({ onCreated, cwdSuggestions }: TaskFormProps) {
  const [req, setReq] = useState('');
  // 새로고침해도 입력 중이던 경로 유지 — 저장된 값이 없으면 마지막 사용 경로로 시작
  const [cwd, setCwd] = useState(() => {
    try {
      return localStorage.getItem(CWD_KEY) ?? loadRecents()[0] ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(CWD_KEY, cwd);
    } catch {
      /* ignore */
    }
  }, [cwd]);
  const [maxIter, setMaxIter] = useState('8');
  const [mode, setMode] = useState<TaskMode>('single');
  const [codexSandbox, setCodexSandbox] = useState<CodexSandbox>('bypass');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  async function submit() {
    setErr('');
    setBusy(true);
    try {
      const t = await createTask({
        requirement: req.trim(),
        cwd: cwd.trim(),
        maxIterations: Number(maxIter) || 8,
        codexSandbox,
        mode,
      });
      saveRecent(cwd.trim()); // 서버 검증을 통과한 경로만 최근 목록에 저장
      setReq('');
      onCreated(t.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '서버에 연결할 수 없습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-[18px] pb-[14px] border-b border-line bg-raise">
      <h2 className={`${headCls} mb-3`}>새 작업</h2>

      <label className={labelCls}>요구사항</label>
      <textarea
        className={`${inputCls} min-h-24 resize-y leading-[1.55]`}
        placeholder="예: 이 폴더에 할 일 관리 CLI를 파이썬으로 만들어줘. 추가/완료/목록 기능 포함."
        value={req}
        onChange={(e) => setReq(e.target.value)}
      />

      {/* 경로는 전용 행 전체를 사용 — 긴 절대 경로 가독성 확보 */}
      <label className={labelCls}>대상 폴더 (절대 경로)</label>
      <PathInput
        value={cwd}
        onChange={setCwd}
        onBrowse={() => setBrowsing(true)}
        suggestions={cwdSuggestions}
      />

      <div className="grid grid-cols-[96px_1fr_1fr] gap-[10px]">
        <div>
          <label className={labelCls}>최대 반복</label>
          <Stepper value={maxIter} min={1} max={30} onChange={setMaxIter} />
        </div>
        <div>
          <label className={labelCls}>진행 모드</label>
          <select
            className={`${inputCls} cursor-pointer`}
            value={mode}
            onChange={(e) => setMode(e.target.value as TaskMode)}
          >
            <option value="single">single</option>
            <option value="micro">micro</option>
            <option value="review">review</option>
          </select>
        </div>
        <div>
          <label className={labelCls} title="Codex 권한 (리뷰어)">
            CODEX 권한
          </label>
          <select
            className={`${inputCls} cursor-pointer`}
            value={codexSandbox}
            onChange={(e) => setCodexSandbox(e.target.value as CodexSandbox)}
          >
            <option value="bypass">전체 bypass</option>
            <option value="workspace-write">쓰기 허용</option>
            <option value="read-only">읽기 전용</option>
          </select>
        </div>
      </div>

      <button
        className="mt-4 w-full p-[10px] font-disp font-bold text-[13px] tracking-[.18em] text-ink bg-ok border-none rounded-[3px]
          cursor-pointer transition-[filter,transform] duration-150 hover:brightness-112 active:translate-y-px
          disabled:bg-bright disabled:text-dim disabled:cursor-default disabled:brightness-100"
        disabled={busy}
        onClick={submit}
      >
        ▶ 시작
      </button>
      <div className="text-err text-[12.5px] mt-2 min-h-[15px]">{err}</div>

      <FsModal
        open={browsing}
        initialPath={cwd}
        recents={mergeRecents(cwdSuggestions)}
        onClose={() => setBrowsing(false)}
        onPick={(p) => {
          setCwd(p);
          setBrowsing(false);
        }}
      />
    </div>
  );
}
