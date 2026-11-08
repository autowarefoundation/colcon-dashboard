/* ---- Markdown for the Claude pane, one line at a time ----

   A log pane keeps its text as lines, and it renders only the lines near
   the view. So the Markdown renders line by line too, with a small state
   that carries across lines: the open code fence. mdLine returns the row
   classes and the nodes of one line, and it advances the state. The data
   stays the raw Markdown, so search and copy see what Claude wrote.

   The transcript also holds the lines that the server writes (ai.py): the
   question ("❯ ..."), the tool calls ("  → Read path"), and the end
   ("─ answered in 6s"). They get their own row classes. */

export function newMdState() { return { fence: null, ind: 0 }; }

// the depth of an indented line under a list item: 3 spaces is the text of
// a top-level item, 6 spaces the text of a nested item
const depthOf = n => Math.max(0, Math.min(4, Math.floor((n - 1) / 3)));

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEAD_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;

// the inline spans: code, bold, italic, and links to http(s) addresses
const INLINE_RE = new RegExp([
  /(`+)([^`]|[^`].*?[^`])\1(?!`)/.source,       // 1, 2: code
  /\*\*(?=\S)(.+?)(?<=\S)\*\*/.source,            // 3: bold
  /__(?=\S)(.+?)(?<=\S)__/.source,                // 4: bold
  /(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/.source,  // 5: italic
  /(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/.source,     // 6: italic
  /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.source,  // 7, 8: link
].join('|'), 'g');

function el(tag, cls, kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of [].concat(kids)) e.append(k);
  return e;
}

export function inline(text) {
  const out = [];
  let last = 0;
  // matchAll works on its own copy of the regex: the calls for bold and
  // italic text nest, and a shared lastIndex would loop forever
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(el('code', 'md-ic', m[2]));
    else if (m[3] != null || m[4] != null) out.push(el('strong', '', inline(m[3] ?? m[4])));
    else if (m[5] != null || m[6] != null) out.push(el('em', '', inline(m[5] ?? m[6])));
    else {
      const a = el('a', 'md-a', inline(m[7]));
      a.href = m[8];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      out.push(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* One line: {cls, nodes}. build = false only classifies the line and
   advances the state (the data pass of the log view). */
export function mdLine(text, st, build = true) {
  const nodes = [];
  const cls = [];
  const fm = FENCE_RE.exec(text);
  if (st.fence) {
    // a block under a list item indents with the item
    if (st.ind) cls.push('md-in', `md-d${depthOf(st.ind)}`);
    if (fm && fm[2][0] === st.fence[0] && fm[2].length >= st.fence.length && !fm[3]) {
      st.fence = null;
      cls.push('md-fence', 'md-fence-end');
      if (build) nodes.push(el('span', 'md-mark', text));
    } else {
      cls.push('md-code');
      const lead = /^\s*/.exec(text)[0].length;
      if (build) nodes.push(text.slice(Math.min(lead, st.ind)));
    }
    return { cls, nodes };
  }
  if (fm) {
    st.fence = fm[2];
    st.ind = fm[1].replace(/\t/g, '    ').length;
    if (st.ind) cls.push('md-in', `md-d${depthOf(st.ind)}`);
    cls.push('md-fence');
    if (build) nodes.push(el('span', 'md-mark', fm[2]), el('span', 'md-lang', fm[3] || ''));
    return { cls, nodes };
  }
  // the lines that the server writes around the answer
  if (text.startsWith('❯ ')) {
    cls.push('md-q');
    if (build) nodes.push(el('span', 'md-qmark', '❯'), ' ', text.slice(2));
    return { cls, nodes };
  }
  let m = /^\s+→ (\S+)\s?(.*)$/.exec(text);
  if (m) {
    cls.push('md-tool');
    if (build) nodes.push(el('span', 'md-arrow', '→'), ' ', el('span', 'md-tname', m[1]), ' ', m[2]);
    return { cls, nodes };
  }
  if (/^─ answered in /.test(text) || /^(claude exited with|analysis failed:)/.test(text)) {
    cls.push('md-end');
    if (build) nodes.push(text);
    return { cls, nodes };
  }
  if (!text.trim()) {
    cls.push('md-blank');
    return { cls, nodes };
  }
  if ((m = HEAD_RE.exec(text))) {
    cls.push('md-h', `md-h${Math.min(m[1].length, 3)}`);
    if (build) nodes.push(...inline(m[2]));
    return { cls, nodes };
  }
  if (HR_RE.test(text)) {
    cls.push('md-hr');
    if (build) nodes.push(el('span', 'md-rule', ''));
    return { cls, nodes };
  }
  if (TABLE_RE.test(text)) {
    cls.push('md-table');
    if (build) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(text)) nodes.push(el('span', 'md-mark', text));
      else for (const [k, part] of text.trim().slice(1, -1).split('|').entries()) {
        if (k) nodes.push(el('span', 'md-mark', ' │ '));
        nodes.push(...inline(part.trim()));
      }
    }
    return { cls, nodes };
  }
  if ((m = QUOTE_RE.exec(text))) {
    cls.push('md-quote');
    if (build) nodes.push(...inline(m[1]));
    return { cls, nodes };
  }
  if ((m = LIST_RE.exec(text))) {
    const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
    cls.push('md-li', `md-d${depth}`);
    if (build) {
      const ordered = /\d/.test(m[2]);
      nodes.push(el('span', ordered ? 'md-num' : 'md-bullet', ordered ? m[2] : '•'), ' ', ...inline(m[3]));
    }
    return { cls, nodes };
  }
  const indent = /^\s+/.exec(text);
  if (indent) {  // the rest of a list item, on its own line
    cls.push('md-cont', `md-d${depthOf(indent[0].replace(/\t/g, '    ').length)}`);
    if (build) nodes.push(...inline(text.trim()));
    return { cls, nodes };
  }
  cls.push('md-p');
  if (build) nodes.push(...inline(text));
  return { cls, nodes };
}
