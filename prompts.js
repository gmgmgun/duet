'use strict';
/**
 * Duet 프롬프트 템플릿
 *
 * 구현자(IMPLEMENTER)와 리뷰어(REVIEWER)에게 전달되는 프롬프트 문자열을 생성합니다.
 * 각 역할은 작업별로 Claude/Codex 중 선택되므로(t.implementer/t.reviewer)
 * 프롬프트는 엔진명이 아닌 역할명을 사용합니다. 오케스트레이션은 orchestrator.js.
 *
 * 마이크로 이터레이션 구조:
 *  - planPrompt: 요구사항을 작은 스텝으로 분해 (PLAN_JSON 마커로 출력)
 *  - implementStepPrompt / reviseStepPrompt: 한 번에 한 스텝만 구현/수정
 *  - reviewStepPrompt: 해당 스텝만 리뷰 (VERDICT 형식 유지)
 * plan이 단일 스텝이면 사실상 기존(전체 한 덩어리) 동작과 같아집니다.
 */

/* ──────────────────────────── 후속 작업(이어가기) 컨텍스트 ──────────────────────────── */

/** 구현자용: 이전 작업 위에 이어서 작업함을 알린다. 후속 작업이 아니면 빈 문자열. */
function followupImplementNote(t) {
  if (!t.parentId) return '';
  const sessionNote = t.claudeSessionId
    ? ' This conversation is resumed from that task, so you may remember the details.'
    : '';
  return `This is a FOLLOW-UP task: you previously completed work in this same working directory.${sessionNote}
Previous task requirement:
<previous_requirement>
${t.parentRequirement || '(unknown)'}
</previous_requirement>

The codebase already contains that work. Build on the existing code — do not start from scratch and do not break existing behavior.

`;
}

/** 리뷰어용: 기존 코드는 이미 승인된 컨텍스트임을 알린다. 후속 작업이 아니면 빈 문자열. */
function followupReviewNote(t) {
  if (!t.parentId) return '';
  return `Note: this requirement is a FOLLOW-UP to earlier work already completed and approved in this directory (previous requirement: "${t.parentRequirement || '(unknown)'}"). Review the implementation of the NEW requirement; treat pre-existing code as accepted context unless the new changes break it.

`;
}

/* ──────────────────────────── 분해(Plan) ──────────────────────────── */

function planPrompt(t) {
  return `You are the IMPLEMENTER in an automated pair-programming loop. Before writing any code, break the requirement below into a short ordered list of small, independently verifiable steps. Your partner, the REVIEWER, will review your work one step at a time.

${followupImplementNote(t)}Task requirement:
<requirement>
${t.requirement}
</requirement>

Guidelines for the plan:
- Each step should be a small, self-contained unit that can be implemented and reviewed on its own (think "one small commit").
- Order steps so each builds on the previous ones.
- Match the plan size to the requirement size. If the requirement is trivial (a single small file, a one-liner, a tiny fix), output exactly ONE step — do not pad the plan. For substantial work prefer 3–8 steps. Do NOT over-split into trivial steps, and do NOT lump everything into one giant step.
- Do NOT implement anything yet — only produce the plan.

End your message with EXACTLY this marker on its own line, followed by a JSON array of steps:
PLAN_JSON:
[{"title": "short imperative description of step 1"}, {"title": "step 2"}]

Write the step titles in the same language as the requirement.`;
}

/* ──────────────────────────── 구현(Implement) ──────────────────────────── */

function stepHeader(t, step, plan, stepIndex, total) {
  const list = plan
    .map((s, i) => {
      const mark = i < stepIndex ? '[done]' : i === stepIndex ? '[NOW]' : '[todo]';
      return `  ${i + 1}. ${mark} ${s.title}`;
    })
    .join('\n');
  return `Task requirement (overall goal, for context):
<requirement>
${t.requirement}
</requirement>

Full plan (${total} steps):
${list}

You are working on step ${stepIndex + 1}/${total}: "${step.title}"
Steps marked [done] are already implemented and approved — do not redo them, but you may build on them.`;
}

const PLAN_UPDATE_NOTE = `If — and only if — you discover the remaining plan needs to change (a step should be added, removed, split, or reworded), append at the very end of your message EXACTLY this marker on its own line followed by a JSON array of the REMAINING steps (everything AFTER the current one):
PLAN_UPDATE:
[{"title": "..."}]
Omit the marker entirely if the remaining plan is fine.`;

function implementStepPrompt(t, step, plan, stepIndex, total) {
  return `You are the IMPLEMENTER in an automated pair-programming loop. The REVIEWER will review this step after you finish.

${stepHeader(t, step, plan, stepIndex, total)}

Implement ONLY this step in the current working directory. Write real, working code — create files, run commands, and verify your work where possible. Do not jump ahead to later steps.

When you are done, end with a concise summary of WHAT you implemented for this step, WHICH files you touched, and HOW to run/verify it.
${PLAN_UPDATE_NOTE}
Respond in the same language as the requirement.`;
}

function reviseStepPrompt(t, step, feedback, stepIndex, total, plan) {
  return `The REVIEWER reviewed step ${stepIndex + 1}/${total} ("${step.title}") and requests changes. Address EVERY point below, then re-verify your work for this step.

Reviewer feedback:
<feedback>
${feedback}
</feedback>

(Overall requirement, for reference: ${t.requirement})

Stay focused on the current step only. When done, end with a concise summary of the changes you made in response to each point.
${PLAN_UPDATE_NOTE}
Respond in the same language as the requirement.`;
}

/* ──────────────────────────── 리뷰(Review) ──────────────────────────── */

/** 리뷰어 권한에 따른 검증 지침 한 줄. Claude 리뷰어는 항상 명령 실행 가능,
    Codex 리뷰어는 작업 제출 시 선택한 샌드박스를 따른다. */
function sandboxNote(t) {
  const canRun = t.reviewer === 'claude' || (t.codexSandbox && t.codexSandbox !== 'read-only');
  return canRun
    ? 'You have permission to execute commands — actually RUN the code/tests to verify the claimed behavior before giving your verdict.'
    : 'Your sandbox is read-only: verify by reading the code (running it may be blocked by policy — do not treat blocked commands as implementation failures).';
}

function reviewStepPrompt(t, step, report, plan, stepIndex, total, iteration) {
  return `You are the REVIEWER in an automated pair-programming loop. The IMPLEMENTER just finished attempt ${iteration} on step ${stepIndex + 1}/${total} of the plan.

Overall requirement (for context only):
<requirement>
${t.requirement}
</requirement>

${followupReviewNote(t)}The step you are reviewing NOW: "${step.title}"
Review ONLY whether THIS step is correctly and completely implemented. Do not demand work that belongs to later steps of the plan; later steps will be reviewed separately. Earlier steps were already approved.

Implementer's report for this step:
<report>
${report}
</report>

Do NOT trust the report — inspect the actual files in the working directory and verify that this step is fully and correctly implemented, and that the code quality is acceptable (correctness first; style nitpicks only if serious).
${sandboxNote(t)}

Your final message MUST start with exactly one of these lines:
VERDICT: APPROVED
VERDICT: CHANGES_REQUESTED

If CHANGES_REQUESTED, follow the verdict line with a concrete, numbered list of issues for THIS step, each actionable for the implementer. Only approve when you have NO further requirements for this step. Respond in the same language as the requirement.`;
}

/* ──────────────────────────── 단일 루프(single 모드) ────────────────────────────
   요구사항 전체를 한 덩어리로 구현·리뷰하는 기존 방식. 마이크로 이터레이션과의
   A/B 성능 비교(bench.js)를 위해 보존한다. */

function implementPrompt(t) {
  return `You are the IMPLEMENTER in an automated pair-programming loop. Your partner, the REVIEWER, will review your work after you finish.

${followupImplementNote(t)}Task requirement:
<requirement>
${t.requirement}
</requirement>

Implement this requirement in the current working directory. Write real, working code — create files, run commands, and verify your work where possible.

When you are done, end with a concise summary of WHAT you implemented, WHICH files you touched, and HOW to run/verify it. Respond in the same language as the requirement.`;
}

function revisePrompt(t, feedback) {
  return `The REVIEWER reviewed your implementation and requests changes. Address EVERY point below, then re-verify your work.

Reviewer feedback:
<feedback>
${feedback}
</feedback>

(Original requirement, for reference: ${t.requirement})

When done, end with a concise summary of the changes you made in response to each point. Respond in the same language as the requirement.`;
}

function reviewPrompt(t, report, iteration) {
  return `You are the REVIEWER in an automated pair-programming loop. The IMPLEMENTER just finished iteration ${iteration} of ${t.maxIterations}.

Task requirement:
<requirement>
${t.requirement}
</requirement>

${followupReviewNote(t)}Implementer's report:
<report>
${report}
</report>

Do NOT trust the report — inspect the actual files in the working directory and verify that the requirement is fully and correctly implemented, and that the code quality is acceptable (correctness first; style nitpicks only if serious).
${sandboxNote(t)}

Your final message MUST start with exactly one of these lines:
VERDICT: APPROVED
VERDICT: CHANGES_REQUESTED

If CHANGES_REQUESTED, follow the verdict line with a concrete, numbered list of issues or missing requirements, each actionable for the implementer. Only approve when you have NO further requirements. Respond in the same language as the requirement.`;
}

/* ──────────────────────────── 선리뷰 루프(review 모드) ────────────────────────────
   Codex가 먼저 기존 코드를 리뷰하고, 지적사항이 있으면 Claude가 수정하는 역순 루프.
   리뷰/감사형 요구사항("이 코드 리뷰해줘", "보안 점검해줘")에 사용한다. */

function reviewFirstPrompt(t) {
  return `You are the REVIEWER in an automated pair-programming loop. This is a REVIEW-FIRST task: you act before the implementer. Review the EXISTING code in the current working directory against the request below. If you raise issues, your partner, the IMPLEMENTER, will fix them and you will re-review.

Review request:
<requirement>
${t.requirement}
</requirement>

${followupReviewNote(t)}Inspect the actual files in the working directory. If the request names specific files, areas, or concerns, focus there; otherwise review for correctness first, then security and code quality (style nitpicks only if serious).
${sandboxNote(t)}

Your final message MUST start with exactly one of these lines:
VERDICT: APPROVED
VERDICT: CHANGES_REQUESTED

If CHANGES_REQUESTED, follow the verdict line with a concrete, numbered list of issues, each actionable for the implementer. Use APPROVED only when you have NO findings worth fixing. Respond in the same language as the requirement.`;
}

function fixPrompt(t, feedback) {
  return `You are the IMPLEMENTER in an automated pair-programming loop. The REVIEWER reviewed the existing code in the current working directory against the request below and produced the findings. Address EVERY point, then re-verify your work. The REVIEWER will re-review after you finish.

${followupImplementNote(t)}Review request:
<requirement>
${t.requirement}
</requirement>

Reviewer findings:
<feedback>
${feedback}
</feedback>

When done, end with a concise summary of the changes you made in response to each finding. Respond in the same language as the requirement.`;
}

module.exports = {
  // 마이크로 이터레이션 (micro 모드)
  planPrompt,
  implementStepPrompt,
  reviseStepPrompt,
  reviewStepPrompt,
  // 단일 루프 (single 모드)
  implementPrompt,
  revisePrompt,
  reviewPrompt,
  // 선리뷰 루프 (review 모드)
  reviewFirstPrompt,
  fixPrompt,
};
