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

의존성 없음 (Node 내장 모듈만 사용). `claude` / `codex` CLI가 설치·로그인되어 있어야 합니다.

## 사용법

1. 브라우저에서 대시보드 접속
2. **요구사항** 입력 + **대상 폴더**(절대 경로) 지정 + 최대 반복 횟수 설정
3. ▶ 시작 — 두 AI의 대화/도구 사용이 실시간으로 스트리밍됩니다
4. 필요하면 ■ STOP으로 즉시 중단

여러 작업을 제출하면 큐에 쌓여 순차 실행됩니다.

## 동작 방식

| 단계 | 명령 | 권한 |
|------|------|------|
| 구현 (Claude) | `claude -p --output-format stream-json --dangerously-skip-permissions` | 항상 전체 bypass — 읽기/쓰기/명령 실행 |
| 리뷰 (Codex) | `codex exec --sandbox <모드> --skip-git-repo-check` | 작업별 선택 (아래 표) |

### Codex 권한 모드 (작업 제출 시 선택)

| 모드 | 플래그 | 설명 |
|------|--------|------|
| 전체 bypass (기본) | `--dangerously-bypass-approvals-and-sandbox` | 샌드박스·승인 전부 해제. 신뢰하는 폴더에서만 |
| 쓰기 허용 | `--sandbox workspace-write` | 대상 폴더 안에서 코드/테스트 실행 가능 |
| 읽기 전용 | `--sandbox read-only` | 코드를 읽어서만 검증. 가장 안전 |

- Claude는 작업 내내 **같은 세션을 `--resume`으로 이어가서** 이전 맥락을 유지합니다.
- Codex 리뷰의 첫 줄이 `VERDICT: APPROVED`면 종료, `VERDICT: CHANGES_REQUESTED`면
  피드백 목록이 Claude에게 그대로 전달되어 다음 반복이 시작됩니다.
- 모든 실행 기록은 `runs/<task-id>/`에 남습니다 (`log.jsonl`, `meta.json`, `review-N.md`).
  서버를 재시작해도 과거 기록은 대시보드에서 조회 가능합니다.

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4646` | 서버 포트 |
| `DUET_STEP_TIMEOUT_MS` | `1800000` (30분) | AI 1회 호출 시간 제한 |

## 주의

- Claude는 `--dangerously-skip-permissions`로 실행되므로 **대상 폴더 안에서 모든 작업을
  자율 수행**합니다. 신뢰할 수 있는 폴더만 지정하세요. (Codex는 읽기 전용이라 안전)
- 서버는 `127.0.0.1`에만 바인딩됩니다 — 외부 접근 불가.
- 한 번의 반복이 수 분 이상 걸릴 수 있습니다. API 사용량(비용)에 유의하세요.
