'use strict';
/**
 * ai-pair 오케스트레이션 로직
 *
 * 작업(Task) 상태 관리, CLI 바이너리 탐색, 자식 프로세스 실행,
 * Claude(구현)·Codex(리뷰) 호출, 반복 루프(runTask)와 대기열(queue)을 담당합니다.
 * HTTP 서버(server.js)는 여기서 export한 함수/상태만 사용합니다.
 *
 * 의존성 없음 — Node 내장 모듈만 사용.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const {
  planPrompt, implementStepPrompt, reviseStepPrompt, reviewStepPrompt, // micro 모드
  implementPrompt, revisePrompt, reviewPrompt, // single 모드
} = require('./prompts');

const ROOT = __dirname;
const RUNS_DIR = path.join(ROOT, 'runs');
const STEP_TIMEOUT_MS = Number(process.env.AI_PAIR_STEP_TIMEOUT_MS || 30 * 60 * 1000); // AI 1회 호출 제한
const DEFAULT_MAX_ITERATIONS = 8; // micro: 스텝당 최대 구현-리뷰 횟수 / single: 최대 반복
const MAX_TOTAL_STEPS = 30; // plan 폭주 방지: 전체 스텝 수 상한
const MODES = ['micro', 'single'];
// 벤치 결과(2026-06): single이 수렴 가능한 규모에선 시간·비용 모두 우세 → 기본값 single.
// micro는 single이 수렴 못하는 큰 작업용 보험으로 작업별 선택.
const DEFAULT_MODE = MODES.includes(process.env.AI_PAIR_MODE) ? process.env.AI_PAIR_MODE : 'single';

fs.mkdirSync(RUNS_DIR, { recursive: true });

/* ──────────────────────────── CLI 바이너리 탐색 ──────────────────────────── */

function whereExe(name) {
  try {
    const out = execSync(`where.exe ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hit = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
    return hit || null;
  } catch {
    return null;
  }
}

function resolveClaude() {
  const exe = whereExe('claude');
  return { cmd: exe || 'claude', baseArgs: [] };
}

function resolveCodex() {
  // npm 글로벌 설치본은 .ps1/.cmd 래퍼라 spawn이 안 되므로 node로 launcher를 직접 실행
  const launcher = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(launcher)) return { cmd: process.execPath, baseArgs: [launcher] };
  const exe = whereExe('codex');
  if (exe) return { cmd: exe, baseArgs: [] };
  return { cmd: 'codex', baseArgs: [] };
}

const CLAUDE = resolveClaude();
const CODEX = resolveCodex();

/* ──────────────────────────── 작업(Task) 상태 ──────────────────────────── */

/** @type {Map<string, Task>} */
const tasks = new Map();
const queue = [];
let running = false;

function isRunning() {
  return running;
}

function newId() {
  return `t_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function taskSummary(t) {
  return {
    id: t.id,
    requirement: t.requirement,
    cwd: t.cwd,
    maxIterations: t.maxIterations,
    codexSandbox: t.codexSandbox || 'read-only',
    mode: t.mode || 'single', // mode 도입 전의 옛 작업은 단일 루프로 실행됐음
    status: t.status,
    iteration: t.iteration,
    // 마이크로 이터레이션: 분해된 스텝 진행 상황 (옛 작업은 plan 없음 → 빈 배열)
    steps: Array.isArray(t.plan) ? t.plan.map((s) => ({ title: s.title, status: s.status })) : [],
    currentStep: t.currentStep || 0,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt || null,
  };
}

function saveMeta(t) {
  try {
    fs.writeFileSync(path.join(t.dir, 'meta.json'), JSON.stringify(taskSummary(t), null, 2));
  } catch { /* 디스크 기록 실패는 치명적이지 않음 */ }
}

function emit(t, role, kind, text) {
  const e = { ts: Date.now(), iter: t.iteration, role, kind, text };
  t.events.push(e);
  try {
    fs.appendFileSync(path.join(t.dir, 'log.jsonl'), JSON.stringify(e) + '\n');
  } catch { /* ignore */ }
  const payload = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of t.subscribers) res.write(payload);
}

function setStatus(t, status) {
  t.status = status;
  if (['approved', 'max_iterations', 'stopped', 'error'].includes(status)) {
    t.finishedAt = Date.now();
  }
  saveMeta(t);
  const payload = `event: status\ndata: ${JSON.stringify(taskSummary(t))}\n\n`;
  for (const res of t.subscribers) res.write(payload);
}

/* ──────────────────────────── 프로세스 실행 ──────────────────────────── */

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* ignore */ }
}

/**
 * 자식 프로세스 실행. prompt는 stdin으로 전달(따옴표 이스케이프 문제 회피).
 * onLine(line, stream)으로 stdout/stderr 라인 콜백.
 */
function runProcess(t, { cmd, args, cwd, prompt, onLine }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    t.proc = proc;

    const timer = setTimeout(() => {
      emit(t, 'system', 'error', `시간 초과(${Math.round(STEP_TIMEOUT_MS / 60000)}분) — 프로세스를 종료합니다.`);
      killTree(proc);
    }, STEP_TIMEOUT_MS);

    let stderrTail = '';
    const mkReader = (stream, name) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (name === 'stderr') stderrTail = (stderrTail + line + '\n').slice(-4000);
          if (line.trim()) onLine(line, name);
        }
      });
      stream.on('end', () => {
        const line = buf.replace(/\r$/, '');
        if (line.trim()) onLine(line, name);
      });
    };
    mkReader(proc.stdout, 'stdout');
    mkReader(proc.stderr, 'stderr');

    proc.on('error', (err) => {
      clearTimeout(timer);
      t.proc = null;
      reject(new Error(`프로세스 실행 실패(${cmd}): ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      t.proc = null;
      resolve({ code, stderrTail });
    });

    if (prompt != null) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }
  });
}

/* ──────────────────────────── Claude (구현자) ──────────────────────────── */

function compactToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.file_path || input.path || input.command || input.pattern || input.url ||
    input.description || '';
  const s = String(pick).replace(/\s+/g, ' ');
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

async function runClaude(t, prompt) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (t.claudeSessionId) args.push('--resume', t.claudeSessionId);

  let result = null;
  let isError = false;

  const { code, stderrTail } = await runProcess(t, {
    cmd: CLAUDE.cmd,
    args: [...CLAUDE.baseArgs, ...args],
    cwd: t.cwd,
    prompt,
    onLine: (line, stream) => {
      if (stream === 'stderr') return; // 종료 코드로 판단, stderr는 tail만 보관
      let ev;
      try { ev = JSON.parse(line); } catch { emit(t, 'claude', 'raw', line); return; }

      if (ev.type === 'system' && ev.subtype === 'init') {
        t.claudeSessionId = ev.session_id || t.claudeSessionId;
      } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            emit(t, 'claude', 'text', block.text.trim());
          } else if (block.type === 'tool_use') {
            emit(t, 'claude', 'tool', `${block.name} ${compactToolInput(block.name, block.input)}`.trim());
          }
        }
      } else if (ev.type === 'result') {
        isError = !!ev.is_error;
        result = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
        if (typeof ev.total_cost_usd === 'number') {
          emit(t, 'system', 'info', `Claude 턴 종료 — turns: ${ev.num_turns ?? '?'}, cost: $${ev.total_cost_usd.toFixed(4)}`);
        }
      }
    },
  });

  if (t.stopRequested) return null;
  if (result == null || isError || code !== 0) {
    throw new Error(`Claude 실행 실패 (exit ${code})${result ? `: ${result.slice(0, 500)}` : ''}${stderrTail ? `\nstderr: ${stderrTail.slice(-500)}` : ''}`);
  }
  return result;
}

/* ──────────────────────────── Codex (리뷰어) ──────────────────────────── */

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CODEX_SECTION_RE = /^(codex|thinking|exec|tool|user|tokens used)$/;

async function runCodex(t, prompt, iteration) {
  const outFile = path.join(t.dir, `review-${iteration}.md`);
  // 권한 모드: read-only(기본) | workspace-write | bypass(샌드박스·승인 전부 해제)
  const sandboxArgs = t.codexSandbox === 'bypass'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', t.codexSandbox === 'workspace-write' ? 'workspace-write' : 'read-only'];
  const args = [
    'exec',
    '--cd', t.cwd,
    ...sandboxArgs,
    '--skip-git-repo-check',
    '--color', 'never',
    '--output-last-message', outFile,
    '-', // 프롬프트는 stdin으로
  ];

  // codex exec stdout 노이즈 필터: 프롬프트 에코(user 섹션)와
  // 'tokens used' 이후의 최종 메시지 중복 출력은 건너뜀
  let skipUserEcho = false;
  let afterTokens = false;

  const { code, stderrTail } = await runProcess(t, {
    cmd: CODEX.cmd,
    args: [...CODEX.baseArgs, ...args],
    cwd: t.cwd,
    prompt,
    onLine: (line) => {
      const cleaned = line
        .replace(ANSI_RE, '')
        .replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*/, '')
        .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s+/, '');
      const trimmed = cleaned.trim();

      if (afterTokens) {
        // 토큰 수 한 줄만 보여주고 그 뒤(최종 메시지 중복)는 버림
        if (/^[\d,]+$/.test(trimmed)) emit(t, 'system', 'info', `Codex tokens used: ${trimmed}`);
        return;
      }
      if (CODEX_SECTION_RE.test(trimmed)) {
        skipUserEcho = trimmed === 'user';
        afterTokens = trimmed === 'tokens used';
        return; // 섹션 마커 자체는 표시하지 않음
      }
      if (skipUserEcho) return;
      emit(t, 'codex', 'raw', cleaned);
    },
  });

  if (t.stopRequested) return null;
  if (code !== 0 || !fs.existsSync(outFile)) {
    throw new Error(`Codex 실행 실패 (exit ${code})${stderrTail ? `\nstderr: ${stderrTail.slice(-500)}` : ''}`);
  }
  const review = fs.readFileSync(outFile, 'utf8').trim();
  emit(t, 'codex', 'text', review);
  return review;
}

/* ──────────────────────────── Plan 파싱 / 재계획 ──────────────────────────── */

/** 마커 뒤의 JSON 배열을 추출해 [{title, status}] 로 정규화. 실패 시 null. */
function extractStepArray(text, marker) {
  if (typeof text !== 'string') return null;
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = text.slice(idx + marker.length);
  const start = rest.indexOf('[');
  const end = rest.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  let arr;
  try { arr = JSON.parse(rest.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const steps = arr
    .map((s) => {
      const title = typeof s === 'string' ? s : (s && typeof s.title === 'string' ? s.title : '');
      return title.trim();
    })
    .filter(Boolean)
    .map((title) => ({ title, status: 'pending' }));
  return steps.length ? steps : null;
}

/**
 * Claude의 plan 출력에서 스텝 배열을 파싱.
 * 실패하면 요구사항 전체를 단일 스텝으로 폴백(= 기존 한 덩어리 동작과 동일).
 */
function parsePlan(text, t) {
  const steps = extractStepArray(text, 'PLAN_JSON:');
  if (steps) return steps.slice(0, MAX_TOTAL_STEPS);
  return [{ title: t.requirement, status: 'pending' }];
}

/**
 * 구현 보고서에 PLAN_UPDATE 마커가 있으면 현재 스텝 이후를 새 배열로 교체(하이브리드 재계획).
 * 이미 완료된 스텝과 현재 스텝은 보존하고, 총 스텝 수 상한을 적용한다.
 */
function applyPlanUpdate(t, report, stepIndex) {
  const newRemaining = extractStepArray(report, 'PLAN_UPDATE:');
  if (!newRemaining) return;
  const kept = t.plan.slice(0, stepIndex + 1); // 완료분 + 현재 스텝
  const room = Math.max(0, MAX_TOTAL_STEPS - kept.length);
  t.plan = kept.concat(newRemaining.slice(0, room));
  saveMeta(t);
  emit(t, 'system', 'plan', `Claude가 남은 계획을 갱신했습니다 (총 ${t.plan.length}단계).`);
}

/* ──────────────────────────── 오케스트레이션 루프 ──────────────────────────── */

/** 모드에 따라 적절한 러너로 위임한다. */
async function runTask(t) {
  if (t.mode === 'single') return runTaskSingle(t);
  return runTaskMicro(t);
}

/* ── micro 모드: 마이크로 이터레이션(분해 → 스텝별 구현-리뷰) ── */
async function runTaskMicro(t) {
  setStatus(t, 'running');
  emit(t, 'system', 'info', `작업 시작 [micro] — 대상 디렉터리: ${t.cwd} (스텝당 최대 ${t.maxIterations}회 반복)`);

  try {
    // ── [1] PLAN: 요구사항을 스텝으로 분해 ──────────────────────────────
    emit(t, 'system', 'phase', '계획 수립 — Claude가 요구사항을 분해 중');
    const planText = await runClaude(t, planPrompt(t));
    if (t.stopRequested) { finishStopped(t); return; }
    t.plan = parsePlan(planText, t);
    t.currentStep = 0;
    saveMeta(t);
    emit(t, 'system', 'plan',
      `계획 ${t.plan.length}단계:\n` + t.plan.map((s, i) => `  ${i + 1}. ${s.title}`).join('\n'));

    // ── [2] STEP LOOP: 스텝마다 구현-리뷰 ──────────────────────────────
    for (let s = 0; s < t.plan.length; s++) {
      if (t.stopRequested) break;
      t.currentStep = s;
      const step = t.plan[s];
      step.status = 'in_progress';
      saveMeta(t);

      const total = t.plan.length;
      let feedback = null;
      let approved = false;

      for (let i = 1; i <= t.maxIterations; i++) {
        if (t.stopRequested) break;
        t.iteration = i;
        saveMeta(t);

        emit(t, 'system', 'phase', `단계 ${s + 1}/${total} · 반복 ${i}/${t.maxIterations} — Claude 구현 중`);
        const report = await runClaude(
          t,
          i === 1
            ? implementStepPrompt(t, step, t.plan, s, total)
            : reviseStepPrompt(t, step, feedback, s, total, t.plan),
        );
        if (t.stopRequested) break;
        applyPlanUpdate(t, report, s); // 하이브리드: 남은 계획 갱신

        emit(t, 'system', 'phase', `단계 ${s + 1}/${total} · 반복 ${i}/${t.maxIterations} — Codex 리뷰 중`);
        const review = await runCodex(t, reviewStepPrompt(t, step, report, t.plan, s, total, i), `${s + 1}-${i}`);
        if (t.stopRequested) break;

        if (/^\s*VERDICT:\s*APPROVED/im.test(review)) {
          approved = true;
          break;
        }
        feedback = review;
        emit(t, 'system', 'info', `Codex가 단계 ${s + 1} 수정을 요청했습니다 → 다음 반복으로 진행`);
      }

      if (t.stopRequested) break;
      if (!approved) {
        emit(t, 'system', 'error',
          `단계 ${s + 1}/${t.plan.length}("${step.title}")가 ${t.maxIterations}회 내에 승인되지 않았습니다. 마지막 리뷰를 확인하세요.`);
        setStatus(t, 'max_iterations');
        return;
      }
      step.status = 'done';
      saveMeta(t);
      emit(t, 'system', 'info', `✓ 단계 ${s + 1}/${t.plan.length} 승인 — "${step.title}"`);
    }

    if (t.stopRequested) {
      finishStopped(t);
    } else {
      emit(t, 'system', 'info', `✓ 전체 ${t.plan.length}단계 완료 — Codex가 모두 승인했습니다.`);
      setStatus(t, 'approved');
    }
  } catch (err) {
    if (t.stopRequested) {
      finishStopped(t);
    } else {
      emit(t, 'system', 'error', `오류: ${err.message}`);
      setStatus(t, 'error');
    }
  }
}

function finishStopped(t) {
  emit(t, 'system', 'info', '사용자 요청으로 중단되었습니다.');
  setStatus(t, 'stopped');
}

/* ── single 모드: 기존 단일 루프(요구사항 전체를 한 덩어리로 구현-리뷰) ── */
async function runTaskSingle(t) {
  setStatus(t, 'running');
  emit(t, 'system', 'info', `작업 시작 [single] — 대상 디렉터리: ${t.cwd} (최대 ${t.maxIterations}회 반복)`);

  try {
    let feedback = null;

    for (let i = 1; i <= t.maxIterations; i++) {
      if (t.stopRequested) break;
      t.iteration = i;
      saveMeta(t);

      emit(t, 'system', 'phase', `반복 ${i}/${t.maxIterations} — Claude 구현 중`);
      const report = await runClaude(t, i === 1 ? implementPrompt(t) : revisePrompt(t, feedback));
      if (t.stopRequested) break;

      emit(t, 'system', 'phase', `반복 ${i}/${t.maxIterations} — Codex 리뷰 중`);
      const review = await runCodex(t, reviewPrompt(t, report, i), i);
      if (t.stopRequested) break;

      if (/^\s*VERDICT:\s*APPROVED/im.test(review)) {
        emit(t, 'system', 'info', `✓ Codex 승인 — 추가 요구사항 없음. ${i}회 반복 만에 완료.`);
        setStatus(t, 'approved');
        return;
      }
      feedback = review;
      emit(t, 'system', 'info', 'Codex가 수정을 요청했습니다 → 다음 반복으로 진행');
    }

    if (t.stopRequested) {
      finishStopped(t);
    } else {
      emit(t, 'system', 'error', `최대 반복 횟수(${t.maxIterations})에 도달했지만 승인되지 않았습니다. 마지막 리뷰를 확인하세요.`);
      setStatus(t, 'max_iterations');
    }
  } catch (err) {
    if (t.stopRequested) {
      finishStopped(t);
    } else {
      emit(t, 'system', 'error', `오류: ${err.message}`);
      setStatus(t, 'error');
    }
  }
}

function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  runTask(next).finally(() => {
    running = false;
    pump();
  });
}

/**
 * 새 작업을 생성해 대기열에 넣고 펌프를 가동한다.
 * 입력값 검증은 호출자(HTTP 서버)가 담당한다.
 */
function enqueueTask({ requirement, cwd, maxIterations, codexSandbox, mode }) {
  const id = newId();
  const t = {
    id, requirement, cwd, maxIterations, // maxIterations = 스텝당 최대 구현-리뷰 횟수
    codexSandbox: codexSandbox || 'bypass',
    mode: MODES.includes(mode) ? mode : DEFAULT_MODE,
    status: 'queued', iteration: 0,
    plan: [], currentStep: 0, // 마이크로 이터레이션 상태
    createdAt: Date.now(), finishedAt: null,
    dir: path.join(RUNS_DIR, id),
    events: [], subscribers: new Set(),
    proc: null, stopRequested: false, claudeSessionId: null,
  };
  fs.mkdirSync(t.dir, { recursive: true });
  saveMeta(t);
  tasks.set(id, t);
  queue.push(t);
  pump();
  return t;
}

/** 진행 중/대기 중인 작업을 중단한다. 상태 가드는 호출자가 담당한다. */
function stopTask(t) {
  t.stopRequested = true;
  const qi = queue.indexOf(t);
  if (qi !== -1) {
    queue.splice(qi, 1);
    emit(t, 'system', 'info', '대기열에서 제거되었습니다.');
    setStatus(t, 'stopped');
  } else if (t.proc) {
    killTree(t.proc);
  }
}

/* ──────────────────────────── 과거 실행 복원 ──────────────────────────── */

function restoreRuns() {
  let dirs = [];
  try { dirs = fs.readdirSync(RUNS_DIR); } catch { return; }
  for (const d of dirs) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, d, 'meta.json'), 'utf8'));
      if (tasks.has(meta.id)) continue;
      if (meta.status === 'running' || meta.status === 'queued') meta.status = 'interrupted';
      tasks.set(meta.id, {
        ...meta,
        dir: path.join(RUNS_DIR, d),
        events: null, // 필요할 때 log.jsonl에서 읽음
        subscribers: new Set(),
        proc: null,
        stopRequested: false,
        restored: true,
      });
    } catch { /* 손상된 run은 건너뜀 */ }
  }
}

function loadEvents(t) {
  if (t.events) return t.events;
  try {
    t.events = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    t.events = [];
  }
  return t.events;
}

module.exports = {
  // 설정
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODE,
  MODES,
  CLAUDE,
  CODEX,
  // 상태
  tasks,
  isRunning,
  taskSummary,
  loadEvents,
  // 동작
  enqueueTask,
  stopTask,
  restoreRuns,
};
