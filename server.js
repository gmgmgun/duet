#!/usr/bin/env node
/**
 * ai-pair — Claude(구현) ↔ Codex(리뷰) 자동 페어 프로그래밍 오케스트레이터
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

const http = require('http');
const fs = require('fs');
const path = require('path');

const orchestrator = require('./orchestrator');
const {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODE,
  MODES,
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
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // 정적 파일
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
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

      if (!requirement) return json(res, 400, { error: '요구사항(requirement)을 입력하세요.' });
      if (!cwd || !path.isAbsolute(cwd)) return json(res, 400, { error: '대상 경로(cwd)는 절대 경로여야 합니다.' });
      let stat;
      try { stat = fs.statSync(cwd); } catch { /* noop */ }
      if (!stat || !stat.isDirectory()) return json(res, 400, { error: `대상 디렉터리가 존재하지 않습니다: ${cwd}` });

      const t = enqueueTask({ requirement, cwd, maxIterations, codexSandbox, mode });
      json(res, 201, taskSummary(t));
      return;
    }

    // /api/tasks/:id/...
    const m = p.match(/^\/api\/tasks\/([^/]+)(?:\/(events|stop))?$/);
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
        if (['approved', 'max_iterations', 'stopped', 'error', 'interrupted'].includes(t.status)) {
          return json(res, 409, { error: '이미 종료된 작업입니다.' });
        }
        stopTask(t);
        json(res, 200, { ok: true });
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
  console.log(`ai-pair 서버 실행 중 → http://${HOST}:${PORT}`);
  console.log(`  Claude: ${CLAUDE.cmd}`);
  console.log(`  Codex : ${CODEX.baseArgs[0] || CODEX.cmd}`);
});
