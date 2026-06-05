/* ───── 경량 마크다운 렌더러 (의존성 없음) ─────
   AI 메시지를 안전하게 HTML로 변환한다. 입력은 항상 먼저 이스케이프해
   XSS를 차단하고, 화이트리스트 문법(헤더/목록/코드/굵게/링크 등)만 변환한다. */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 이스케이프된 한 줄에 인라인 문법 적용. 인라인 코드는 NUL 플레이스홀더로 보호.
function renderInline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => '\u0000' + (codes.push(c) - 1) + '\u0000');
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => `<code>${codes[Number(n)]}</code>`);
}

const MD_BLOCK_RE = /^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>|```|\s*(?:---|\*\*\*|___)\s*$)/;

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 펜스 코드 블록 ```lang
    if (/^```/.test(line)) {
      closeList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // 닫는 펜스 건너뜀
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    // 수평선
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }
    // 헤더
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${renderInline(escapeHtml(h[2]))}</h${h[1].length}>`);
      i++;
      continue;
    }
    // 인용
    if (/^>\s?/.test(line)) {
      closeList();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderInline(escapeHtml(quote.join(' ')))}</blockquote>`);
      continue;
    }
    // 순서 없는 목록
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`);
      i++;
      continue;
    }
    // 순서 있는 목록
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(escapeHtml(ol[1]))}</li>`);
      i++;
      continue;
    }
    // 빈 줄
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }
    // 일반 문단 — 연속된 비-블록 줄을 모은다
    closeList();
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !MD_BLOCK_RE.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${renderInline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }
  closeList();
  return out.join('');
}
