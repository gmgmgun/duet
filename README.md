# Duet — Claude × Codex 자동 페어 프로그래밍

로컬 서버를 띄우고 요구사항을 던지면, **Claude가 구현하고 Codex가 리뷰**하는 루프가
Codex의 **추가 요구사항이 없어질 때까지(`VERDICT: APPROVED`)** 자동으로 반복됩니다.

```
요구사항 입력
    │
    ▼
┌─────────────┐   구현 결과 보고   ┌─────────────┐
│   CLAUDE     │ ────────────────▶ │    CODEX     │
│  (구현자)    │                   │   (리뷰어)   │
│  코드 작성   │ ◀──────────────── │  코드 검증   │
└─────────────┘   수정 요구사항    └─────────────┘
                                        │
                          VERDICT: APPROVED → 완료 ✓
```

## 실행

```powershell
node server.js
# → http://127.0.0.1:4646 접속
```

서버는 의존성 없음 (Node 내장 모듈만 사용). `claude` / `codex` CLI가 설치·로그인되어 있어야 합니다.
대시보드 빌드 산출물(`public/`)이 저장소에 포함되어 있어 클론 후 바로 실행 가능합니다.

## 프론트엔드 개발 (React + TypeScript + Tailwind)

대시보드 소스는 `web/`에 있습니다 (Vite + React 19 + Tailwind v4).

```powershell
npm --prefix web install   # 최초 1회
npm run dev                # Vite 개발 서버 (http://localhost:5173, /api는 4646으로 프록시)
npm run build              # 타입 체크 + 빌드 → public/ 으로 출력
```

개발 시에는 `node server.js`(API)와 `npm run dev`(프론트)를 함께 띄웁니다.

```
web/src/
├── App.tsx                # 레이아웃 + 선택/뷰 상태
├── api.ts                 # REST 클라이언트
├── markdown.ts            # 경량 마크다운 렌더러 (의존성 없음, XSS-safe)
├── types.ts               # 서버 taskSummary()/emit()과 1:1 타입
├── hooks/
│   ├── useTasks.ts        # 작업 목록 폴링 + SSE status 병합
│   └── useTaskEvents.ts   # 선택된 작업 SSE 구독
└── components/
    ├── Header.tsx         # 상단 바 (로고, 서버 상태 LED)
    ├── TaskForm.tsx       # 새 작업 폼
    ├── TaskList.tsx       # 작업 목록
    ├── LogPane.tsx        # 로그 헤더 + 스트림 (자동 스크롤)
    ├── LogEntry.tsx       # 이벤트 1건 렌더링 (kind/role별 스타일)
    ├── FsModal.tsx        # 폴더 탐색 모달
    ├── Stepper.tsx        # 숫자 스테퍼
    └── Badge.tsx          # 상태 배지
```

## 사용법

1. 브라우저에서 대시보드 접속
2. **요구사항** 입력 + **대상 폴더**(절대 경로) 지정 + 최대 반복 횟수 설정
3. ▶ 시작 — 두 AI의 대화/도구 사용이 실시간으로 스트리밍됩니다
4. 필요하면 ■ STOP으로 즉시 중단

여러 작업을 제출하면 큐에 쌓여 순차 실행됩니다.

## 동작 방식

구현자와 리뷰어 역할에 어떤 AI를 쓸지 **작업마다 선택**합니다 (기본: Claude 구현 / Codex 리뷰).
`claude→claude`, `codex→codex` 같은 동일 엔진 조합도 가능합니다.

| 역할 | Claude로 실행 시 | Codex로 실행 시 |
|------|-----------------|-----------------|
| 구현 | `claude -p --dangerously-skip-permissions` — 작업 내내 같은 세션을 `--resume`으로 유지 | `codex exec` — 호출마다 독립 실행. 쓰기가 필수인데 Windows 샌드박스는 `workspace-write`도 쓰기를 막으므로 **항상 bypass로 실행** (선택한 권한 모드는 리뷰에만 적용) |
| 리뷰 | 매번 **새 세션** — 구현자와 컨텍스트를 공유하지 않는 독립 리뷰. 명령 실행 가능 | `codex exec --sandbox <모드>` — 작업별 선택 (아래 표) |

### 진행 모드 (작업 제출 시 선택)

| 모드 | 흐름 | 용도 |
|------|------|------|
| `single` (기본) | 구현 → 리뷰 반복 | 일반 구현 작업 |
| `micro` | 구현자가 계획 수립 → 스텝별 구현·리뷰 | single이 수렴하지 못하는 큰 작업 |
| `review` | **리뷰 → 수정** 반복 (역순) | 기존 코드 리뷰/감사. 첫 리뷰에서 지적사항이 없으면 즉시 승인 종료. 최대 반복을 1로 두면 수정 없이 리뷰만 수행 |

### Codex 권한 모드 (작업 제출 시 선택, Codex를 쓰는 역할에 적용)

| 모드 | 플래그 | 설명 |
|------|--------|------|
| 전체 bypass (기본) | `--dangerously-bypass-approvals-and-sandbox` | 샌드박스·승인 전부 해제. 신뢰하는 폴더에서만 |
| 쓰기 허용 | `--sandbox workspace-write` | 대상 폴더 안에서 코드/테스트 실행 가능 |
| 읽기 전용 | `--sandbox read-only` | 코드를 읽어서만 검증. 가장 안전 (구현자 Codex에는 적용되지 않음 — 위 표 참고) |

- 리뷰의 첫 줄이 `VERDICT: APPROVED`면 종료, `VERDICT: CHANGES_REQUESTED`면
  피드백 목록이 구현자에게 그대로 전달되어 다음 반복이 시작됩니다.
- 모든 실행 기록은 `runs/<task-id>/`에 남습니다 (`log.jsonl`, `meta.json`, `review-N.md`,
  Codex 구현자일 때 `impl-N.md`). 서버를 재시작해도 과거 기록은 대시보드에서 조회 가능합니다.

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4646` | 서버 포트 |
| `DUET_STEP_TIMEOUT_MS` | `1800000` (30분) | AI 1회 호출 시간 제한 |

## 주의

- Claude는 `--dangerously-skip-permissions`로 실행되므로 **대상 폴더 안에서 모든 작업을
  자율 수행**합니다. **Codex도 기본값이 전체 bypass**이므로 두 AI 모두 제약 없이 동작합니다.
  신뢰할 수 있는 폴더만 지정하고, 더 안전하게 쓰려면 작업 제출 시 Codex 권한을
  "읽기 전용"으로 선택하세요.
- 서버는 `127.0.0.1`에만 바인딩됩니다 — 외부 접근 불가. 추가로 Host/Origin 검증,
  JSON Content-Type 강제, 세션 CSRF 토큰으로 악성 웹 페이지의 cross-origin 요청을 차단합니다.
- 한 번의 반복이 수 분 이상 걸릴 수 있습니다. API 사용량(비용)에 유의하세요.
