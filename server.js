#!/usr/bin/env node
/**
 * Duet — Claude(구현) ↔ Codex(리뷰) 자동 페어 프로그래밍 오케스트레이터
 *
 * Claude가 요구사항을 구현하고 Codex가 리뷰합니다.
 * Codex가 "VERDICT: APPROVED"를 낼 때까지(= 추가 요구사항이 없을 때까지) 반복합니다.
 *
 * 이 파일은 HTTP 서버(정적 파일 + REST/SSE API)와 진입점만 담당합니다.
 * 오케스트레이션 로직은 orchestrator.js, 프롬프트 템플릿은 prompts.js에 있습니다.
 *
 * 의존성 없음 — Node 내장 모듈만 사용. `node server.js`로 실행.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const orchestrator = require('./orchestrator');
const {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODE,
  MODES,
  ENGINES,
  CLAUDE,
  CODEX,
  tasks,
  isRunning,
  taskSummary,
  loadEvents,
  enqueueTask,
  stopTask,
  restoreRuns,
} = orchestrator;

const PORT = Number(process.env.PORT || 4646);
const HOST = '127.0.0.1';
const FINISHED_STATUSES = ['approved', 'max_iterations', 'stopped', 'error', 'interrupted'];
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// Vite 빌드 산출물(web/ → public/)을 서빙하기 위한 MIME 매핑
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ─────────────────────── CSRF / 원격지 방어 ─────────────────────── */

// 서버 프로세스 수명 동안 유지되는 세션 CSRF 토큰.
// 프론트엔드가 GET /api/csrf로 받아 모든 POST에 X-Duet-Csrf 헤더로 첨부한다.
// 악성 외부 페이지는 CORS 정책상 이 토큰을 읽을 수도, 커스텀 헤더를 보낼 수도 없다.
const CSRF_TOKEN = crypto.randomBytes(32).toString('hex');

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Host/Origin 헤더 값에서 호스트네임만 추출 — 파싱 불가 시 '' 반환
function hostnameOf(value) {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
}

// 로컬에서 온 요청인지 검증. 통과하지 못하면 응답을 보내고 true 반환.
function rejectCrossOrigin(req, res) {
  // Host가 로컬이 아니면 거부 — DNS rebinding 차단
  if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    json(res, 403, { error: 'forbidden host' });
    return true;
  }
  // Origin이 있으면(브라우저 요청) 로컬이어야 함 — cross-origin 페이지의 요청 차단
  // (Vite 개발 서버 localhost:5173 프록시 경유도 허용)
  if (req.headers.origin && !LOCAL_HOSTNAMES.has(hostnameOf(req.headers.origin))) {
    json(res, 403, { error: 'forbidden origin' });
    return true;
  }
  // 상태 변경 요청은 JSON Content-Type + 세션 CSRF 토큰 필수.
  // 둘 다 cross-origin에서는 preflight 없이 보낼 수 없는 조건이다.
  if (req.method !== 'GET') {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      json(res, 415, { error: 'Content-Type은 application/json이어야 합니다.' });
      return true;
    }
    if (req.headers['x-duet-csrf'] !== CSRF_TOKEN) {
      json(res, 403, { error: 'CSRF 토큰이 유효하지 않습니다. 페이지를 새로고침하세요.' });
      return true;
    }
  }
  return false;
}

/* ──────────────────────────── HTTP 유틸 ──────────────────────────── */

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
  });
}

/* ──────────────────────────── HTTP 서버 ──────────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    if (rejectCrossOrigin(req, res)) return;

    // pathname/searchParams만 쓰므로 base는 상수로 — 비정상 Host 헤더가
    // URL 파싱을 깨뜨려 프로세스를 죽이는 일이 없도록 한다(Host 검증은 위에서 별도 수행).
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // 세션 CSRF 토큰 발급 — same-origin 페이지만 응답을 읽을 수 있다(CORS 헤더 없음)
    if (req.method === 'GET' && p === '/api/csrf') {
      return json(res, 200, { token: CSRF_TOKEN });
    }

    // 정적 파일 — public/ (Vite 빌드 산출물). /api/* 외의 GET 요청을 처리한다.
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const rel = decodeURIComponent(p === '/' ? '/index.html' : p);
      const file = path.join(PUBLIC_DIR, rel);
      // 경로 탈출(../) 차단
      if (path.relative(PUBLIC_DIR, file).startsWith('..')) {
        return json(res, 403, { error: 'forbidden' });
      }
      let data;
      try {
        data = fs.readFileSync(file);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
      return;
    }

    // 파일시스템 탐색: path 없으면 드라이브 목록, 있으면 하위 폴더 목록
    if (req.method === 'GET' && p === '/api/fs') {
      const q = url.searchParams.get('path');
      if (!q) {
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const d = String.fromCharCode(i) + ':\\';
          try { fs.statSync(d); drives.push({ name: d, path: d }); } catch { /* 없는 드라이브 */ }
        }
        return json(res, 200, { path: null, parent: null, dirs: drives });
      }
      const target = path.resolve(q);
      let entries;
      try {
        entries = fs.readdirSync(target, { withFileTypes: true });
      } catch (e) {
        return json(res, 400, { error: `폴더를 열 수 없습니다 (${e.code || e.message})` });
      }
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const parentDir = path.dirname(target);
      // 드라이브 루트면 parent='' → 클라이언트는 드라이브 목록으로 복귀
      return json(res, 200, { path: target, parent: parentDir === target ? '' : parentDir, dirs });
    }

    // 새 폴더 생성
    if (req.method === 'POST' && p === '/api/fs/mkdir') {
      const body = await readBody(req);
      const target = String(body.path || '').trim();
      if (!target || !path.isAbsolute(target)) return json(res, 400, { error: '절대 경로가 필요합니다.' });
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (e) {
        return json(res, 400, { error: `폴더를 만들 수 없습니다 (${e.code || e.message})` });
      }
      return json(res, 201, { path: path.resolve(target) });
    }

    // 작업 목록
    if (req.method === 'GET' && p === '/api/tasks') {
      const list = [...tasks.values()].map(taskSummary)
        .sort((a, b) => b.createdAt - a.createdAt);
      json(res, 200, { tasks: list, running: isRunning() });
      return;
    }

    // 작업 생성
    if (req.method === 'POST' && p === '/api/tasks') {
      const body = await readBody(req);
      const requirement = String(body.requirement || '').trim();
      const cwd = String(body.cwd || '').trim();
      const maxIterations = Math.max(1, Math.min(30, Number(body.maxIterations) || DEFAULT_MAX_ITERATIONS));
      const codexSandbox = ['read-only', 'workspace-write', 'bypass'].includes(body.codexSandbox)
        ? body.codexSandbox : 'bypass';
      const mode = MODES.includes(body.mode) ? body.mode : DEFAULT_MODE;
      // 역할별 엔진 선택 — 기본: Claude 구현 / Codex 리뷰. 동일 엔진 조합 허용.
      const implementer = ENGINES.includes(body.implementer) ? body.implementer : 'claude';
      const reviewer = ENGINES.includes(body.reviewer) ? body.reviewer : 'codex';

      if (!requirement) return json(res, 400, { error: '요구사항(requirement)을 입력하세요.' });
      if (!cwd || !path.isAbsolute(cwd)) return json(res, 400, { error: '대상 경로(cwd)는 절대 경로여야 합니다.' });
      let stat;
      try { stat = fs.statSync(cwd); } catch { /* noop */ }
      if (!stat || !stat.isDirectory()) return json(res, 400, { error: `대상 디렉터리가 존재하지 않습니다: ${cwd}` });

      const t = enqueueTask({ requirement, cwd, maxIterations, codexSandbox, mode, implementer, reviewer });
      json(res, 201, taskSummary(t));
      return;
    }

    // /api/tasks/:id/...
    const m = p.match(/^\/api\/tasks\/([^/]+)(?:\/(events|stop|continue))?$/);
    if (m) {
      const t = tasks.get(m[1]);
      if (!t) return json(res, 404, { error: 'task not found' });

      if (req.method === 'GET' && !m[2]) {
        json(res, 200, taskSummary(t));
        return;
      }

      // SSE 스트림: 과거 이벤트 재생 후 라이브 구독
      if (req.method === 'GET' && m[2] === 'events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const e of loadEvents(t)) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify(taskSummary(t))}\n\n`);
        t.subscribers.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); t.subscribers.delete(res); });
        return;
      }

      if (req.method === 'POST' && m[2] === 'stop') {
        if (FINISHED_STATUSES.includes(t.status)) {
          return json(res, 409, { error: '이미 종료된 작업입니다.' });
        }
        stopTask(t);
        json(res, 200, { ok: true });
        return;
      }

      // 이어가기: 종료된 작업의 cwd·모드·권한·Claude 세션을 상속한 후속 작업 생성
      if (req.method === 'POST' && m[2] === 'continue') {
        if (!FINISHED_STATUSES.includes(t.status)) {
          return json(res, 409, { error: '진행 중인 작업은 이어갈 수 없습니다. 종료 후 시도하세요.' });
        }
        const body = await readBody(req);
        const requirement = String(body.requirement || '').trim();
        if (!requirement) return json(res, 400, { error: '요구사항(requirement)을 입력하세요.' });
        let stat;
        try { stat = fs.statSync(t.cwd); } catch { /* noop */ }
        if (!stat || !stat.isDirectory()) {
          return json(res, 400, { error: `대상 디렉터리가 존재하지 않습니다: ${t.cwd}` });
        }
        const nt = enqueueTask({
          requirement,
          cwd: t.cwd,
          maxIterations: Math.max(1, Math.min(30, Number(body.maxIterations) || t.maxIterations || DEFAULT_MAX_ITERATIONS)),
          codexSandbox: ['read-only', 'workspace-write', 'bypass'].includes(body.codexSandbox)
            ? body.codexSandbox : (t.codexSandbox || 'bypass'),
          mode: MODES.includes(body.mode) ? body.mode : (t.mode || DEFAULT_MODE),
          implementer: ENGINES.includes(body.implementer) ? body.implementer : (t.implementer || 'claude'),
          reviewer: ENGINES.includes(body.reviewer) ? body.reviewer : (t.reviewer || 'codex'),
          parent: t,
        });
        json(res, 201, taskSummary(nt));
        return;
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

restoreRuns();
server.listen(PORT, HOST, () => {
  console.log(`Duet 서버 실행 중 → http://${HOST}:${PORT}`);
  console.log(`  Claude: ${CLAUDE.cmd}`);
  console.log(`  Codex : ${CODEX.baseArgs[0] || CODEX.cmd}`);
});
