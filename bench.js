#!/usr/bin/env node
'use strict';
/**
 * ai-pair 벤치 하니스 — single(단일 루프) vs micro(마이크로 이터레이션) A/B 비교
 *
 * 동일한 요구사항을 양쪽 모드로 실행하고, runs/<id>/{meta.json,log.jsonl}에서
 * wall-clock·반복수·스텝수·Claude 호출수/비용·Codex 토큰을 집계해 표로 출력한다.
 * 의존성 없음 — Node 내장 모듈만 사용. 실행 중인 서버(server.js)를 대상으로 한다.
 *
 * 사용법 (먼저 다른 터미널에서 `node server.js` 실행):
 *   node bench.js                         # small 케이스를 single·micro 각 1회
 *   node bench.js --cases=small,medium    # 여러 케이스
 *   node bench.js --modes=micro           # 한 모드만
 *   node bench.js --repeat=3              # 비결정성 완화를 위해 N회씩
 *   node bench.js --req="요구사항 직접 지정" --case=custom
 *   옵션: --max=8 --sandbox=bypass --port=4646 --timeout=1800 (초)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNS_DIR = path.join(__dirname, 'runs');
const WORK_BASE = path.join(os.tmpdir(), 'ai-pair-bench');
const DONE = ['approved', 'max_iterations', 'stopped', 'error', 'interrupted'];

/* ──────────────────────────── 인자 파싱 ──────────────────────────── */

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const HOST = '127.0.0.1';
const PORT = Number(args.port || process.env.PORT || 4646);
const MAX = Math.max(1, Math.min(30, Number(args.max) || 8));
const SANDBOX = args.sandbox || 'bypass';
const REPEAT = Math.max(1, Number(args.repeat) || 1);
const TIMEOUT_MS = (Number(args.timeout) || 1800) * 1000;
const MODES = (args.modes ? String(args.modes) : 'single,micro').split(',').map((s) => s.trim()).filter(Boolean);

/* ──────────────────────────── 테스트 케이스 ──────────────────────────── */

const CASES = {
  small: { key: 'small', req: "이 폴더에 hello.py를 만들어 실행하면 'Hello, AI-Pair'를 출력하게 해라." },
  medium: { key: 'medium', req: '이 폴더에 add/list/done 세 기능을 가진 할 일 관리 CLI를 파이썬으로 만들어라. 데이터는 같은 폴더의 JSON 파일에 저장하고, 잘못된 입력도 안전하게 처리할 것.' },
  large: { key: 'large', req: '이 폴더에 Node 내장 http만으로 메모 REST API를 만들어라. 엔드포인트: 메모 생성(POST)/목록(GET)/삭제(DELETE), 인메모리 저장, 입력 검증, 그리고 핵심 동작을 검증하는 간단한 테스트 스크립트 포함.' },
};

let selectedCases;
if (args.req) {
  selectedCases = [{ key: String(args.case || 'custom'), req: String(args.req) }];
} else {
  const keys = (args.cases ? String(args.cases) : (args.case || 'small')).split(',').map((s) => s.trim()).filter(Boolean);
  selectedCases = keys.map((k) => CASES[k] || null).filter(Boolean);
  if (!selectedCases.length) { console.error(`알 수 없는 케이스. 사용 가능: ${Object.keys(CASES).join(', ')}`); process.exit(1); }
}

/* ──────────────────────────── HTTP ──────────────────────────── */

function api(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let j;
          try { j = buf ? JSON.parse(buf) : {}; } catch { return reject(new Error(`잘못된 응답: ${buf.slice(0, 200)}`)); }
          if (res.statusCode >= 400) return reject(new Error(j.error || `HTTP ${res.statusCode}`));
          resolve(j);
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ──────────────────────────── 집계 ──────────────────────────── */

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function aggregate(id) {
  const dir = path.join(RUNS_DIR, id);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* ignore */ }
  const ev = readJsonl(path.join(dir, 'log.jsonl'));
  let cost = 0, claudeCalls = 0, codexTokens = 0;
  for (const e of ev) {
    if (e.kind !== 'info' || typeof e.text !== 'string') continue;
    const c = /cost: \$([\d.]+)/.exec(e.text);
    if (c) { cost += parseFloat(c[1]); claudeCalls++; }
    const k = /Codex tokens used: ([\d,]+)/.exec(e.text);
    if (k) codexTokens += parseInt(k[1].replace(/,/g, ''), 10);
  }
  const wall = meta.finishedAt && meta.createdAt ? (meta.finishedAt - meta.createdAt) / 1000 : null;
  return {
    status: meta.status || '?',
    iteration: meta.iteration || 0,
    steps: Array.isArray(meta.steps) ? meta.steps.length : 0,
    wall, claudeCalls, cost, codexTokens,
    events: ev.length,
  };
}

/* ──────────────────────────── 실행 ──────────────────────────── */

async function runOne(mode, c, n) {
  const cwd = path.join(WORK_BASE, `${mode}-${c.key}-${n}`);
  fs.mkdirSync(cwd, { recursive: true });
  const created = await api('POST', '/api/tasks', { requirement: c.req, cwd, maxIterations: MAX, codexSandbox: SANDBOX, mode });
  const id = created.id;
  const start = Date.now();
  let st = created;
  while (!DONE.includes(st.status)) {
    if (Date.now() - start > TIMEOUT_MS) { try { await api('POST', `/api/tasks/${id}/stop`, {}); } catch { /* */ } throw new Error('시간 초과'); }
    await sleep(3000);
    try { st = await api('GET', `/api/tasks/${id}`); } catch { /* 서버 일시 단절 — 재시도 */ continue; }
    const stepInfo = (st.steps && st.steps.length) ? ` step=${(st.currentStep || 0) + 1}/${st.steps.length}` : '';
    process.stdout.write(`\r  [${mode}/${c.key}#${n}] ${st.status} iter=${st.iteration}${stepInfo}            `);
  }
  process.stdout.write('\n');
  return { mode, case: c.key, run: n, id, ...aggregate(id) };
}

/* ──────────────────────────── 출력 ──────────────────────────── */

function fmt(v, w, right = true) {
  const s = String(v);
  return right ? s.padStart(w) : s.padEnd(w);
}

function printTable(rows) {
  const cols = [
    ['mode', 6, false], ['case', 8, false], ['run', 4], ['status', 14, false],
    ['wall(s)', 8], ['iter', 5], ['steps', 6], ['claude', 7], ['$cost', 9], ['codexTok', 9],
  ];
  const head = cols.map(([k, w, r]) => fmt(k, w, r !== false)).join('  ');
  console.log('\n' + head);
  console.log('─'.repeat(head.length));
  for (const r of rows) {
    console.log([
      fmt(r.mode, 6, false), fmt(r.case, 8, false), fmt(r.run, 4),
      fmt(r.status, 14, false), fmt(r.wall == null ? '?' : r.wall.toFixed(0), 8),
      fmt(r.iteration, 5), fmt(r.steps || '-', 6), fmt(r.claudeCalls, 7),
      fmt(r.cost.toFixed(4), 9), fmt(r.codexTokens.toLocaleString(), 9),
    ].join('  '));
  }
}

function printAverages(rows) {
  // mode×case 평균 (repeat>1일 때 유용)
  const groups = {};
  for (const r of rows) {
    const g = `${r.mode}|${r.case}`;
    (groups[g] = groups[g] || []).push(r);
  }
  const avgRows = [];
  for (const [g, rs] of Object.entries(groups)) {
    const [mode, cs] = g.split('|');
    const ok = rs.filter((r) => r.status === 'approved');
    const avg = (sel) => rs.reduce((a, r) => a + (sel(r) || 0), 0) / rs.length;
    avgRows.push({
      mode, case: cs, run: `avg/${rs.length}`,
      status: `approved ${ok.length}/${rs.length}`,
      wall: avg((r) => r.wall), iteration: +avg((r) => r.iteration).toFixed(1),
      steps: +avg((r) => r.steps).toFixed(1), claudeCalls: +avg((r) => r.claudeCalls).toFixed(1),
      cost: avg((r) => r.cost), codexTokens: Math.round(avg((r) => r.codexTokens)),
    });
  }
  if (rows.length > avgRows.length) {
    console.log('\n── 평균 ──');
    printTable(avgRows);
  }
}

/* ──────────────────────────── main ──────────────────────────── */

(async () => {
  // 서버 도달 확인
  try { await api('GET', '/api/tasks'); } catch (e) {
    console.error(`서버에 연결할 수 없습니다 (http://${HOST}:${PORT}). 먼저 'node server.js'를 실행하세요.\n  ${e.message}`);
    process.exit(1);
  }

  fs.mkdirSync(WORK_BASE, { recursive: true });
  const plan = [];
  for (const mode of MODES) for (const c of selectedCases) for (let n = 1; n <= REPEAT; n++) plan.push({ mode, c, n });
  console.log(`벤치 시작 — ${plan.length}회 실행 (모드: ${MODES.join(', ')}, 케이스: ${selectedCases.map((c) => c.key).join(', ')}, 반복: ${REPEAT}, max=${MAX}, sandbox=${SANDBOX})`);
  console.log(`작업 디렉터리: ${WORK_BASE}`);

  const rows = [];
  for (const { mode, c, n } of plan) {
    try {
      rows.push(await runOne(mode, c, n));
    } catch (e) {
      console.log(`\n  ✗ [${mode}/${c.key}#${n}] 실패: ${e.message}`);
      rows.push({ mode, case: c.key, run: n, id: '-', status: `FAIL:${e.message}`.slice(0, 14), iteration: 0, steps: 0, wall: null, claudeCalls: 0, cost: 0, codexTokens: 0, events: 0 });
    }
  }

  printTable(rows);
  printAverages(rows);

  const outFile = path.join(WORK_BASE, `results-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), opts: { MODES, cases: selectedCases.map((c) => c.key), REPEAT, MAX, SANDBOX }, rows }, null, 2));
  console.log(`\n결과 저장: ${outFile}`);
})();
