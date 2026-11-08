import { advanceSgr, buildLine, newSgr, PKG_RE, sgrActive, stripAnsi, TS_RE } from './ansi.js';
import { lintLine, newLintState, pkgTag } from './lint.js';

/* ---------------- the log view ----------------
   A pane keeps its whole log as data: the lines as strings, and per
   line its lint classes, the lint and ANSI state before it, and its
   package. The display is a list of items (a line, or a fold group of
   install lines), cut into chunks of CH items.

   Measured on a 9 MB Autoware build log (53,600 lines), laying out every
   line as elements took 1.1 s, a resize 0.24 s, and the wrap toggle
   0.78 s. So:
   - each chunk has content-visibility: auto: the browser skips the
     layout and the paint of the chunks out of view, and a resize or the
     wrap toggle touches only the chunks in view;
   - a chunk far from the view holds plain text, one text node; a chunk
     near the view gets its highlight elements (hydrate), and loses them
     again when it moves far away. A chunk that holds part of the
     selection never changes, so a selection stays stable;
   - copy takes whole lines from the data: the exact log text, also the
     lines inside folded groups;
   - search runs over the data, and opens the group of a match. A folded
     group keeps its lines as hidden="until-found" text, so the browser's
     own find (Ctrl+F) reaches them too and opens the group. */

const CH = 200;           // items per chunk; even, so that the stripes alternate across chunks
const FOLD_MIN = 4;       // a shorter run of install lines stays open, with no group line
const NEAR = '2400px 0px';
const MAX_MARKS = 400;

// the few distinct lint states, shared by many lines
const states = new Map();
function snap(st) {
  const k = `${st.block}|${st.diag}`;
  let s = states.get(k);
  if (!s) states.set(k, s = Object.freeze({ block: st.block, diag: st.diag }));
  return s;
}

export class LogView {
  constructor(pre, { fixed = false, ai = false, raw = false, decorate = null } = {}) {
    this.pre = pre;
    this.fixed = fixed;
    this.ai = ai;
    this.raw = raw;
    this.decorate = decorate;  // a hook for each rendered line text (editor links)
    pre.classList.toggle('raw', raw);
    this.linePx = 18;          // measured on the first rendered chunk
    this.io = new IntersectionObserver(es => this.onIntersect(es), { root: pre, rootMargin: NEAR });
    this.waiting = new Set();  // chunks that wait for the selection to end
    this.onSelection = () => this.retry();
    document.addEventListener('selectionchange', this.onSelection);
    pre.addEventListener('copy', ev => this.onCopy(ev));
    pre.addEventListener('beforematch', ev => this.onBeforeMatch(ev));
    this.reset();
  }

  reset() {
    this.io.disconnect();
    this.waiting.clear();
    this.pre.textContent = '';
    this.text = [];        // the lines, as the log has them
    this.plainAt = new Map();  // the text without ANSI codes, where it differs
    this.cls = [];         // the lint classes of each line
    this.st = [];          // the lint state before each line
    this.sgrAt = new Map();    // the ANSI state before a line, where it is not plain
    this.pkg = [];         // the package of a build log line, or ''
    this.itemOf = [];      // the display item of each line
    this.chunks = [];
    this.open = new Map(); // package -> the group that its install lines join
    this.lintBy = new Map();
    this.sgr = newSgr();
    this.problems = [];    // [line, 'err' | 'warn'], for the marks
    this.hits = [];
    this.hitSet = new Set();
    this.hitIdx = -1;
    this.query = null;
    this.queryRe = null;
    this.buf = '';
    this.tsw = false;
  }

  get lines() { return this.text.length; }

  // the pane closed: let go of the observer and the document listener
  destroy() {
    this.io.disconnect();
    document.removeEventListener('selectionchange', this.onSelection);
  }

  plainOf(i) { return this.plainAt.get(i) ?? this.text[i]; }

  // ---- data in ----------------------------------------------------------

  append(data) {
    this.buf += data;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    if (!lines.length) return;
    const touched = new Set();
    for (const line of lines) this.ingest(line, touched);
    for (const c of touched) this.sync(c);
  }

  ingest(line, touched) {
    const i = this.text.length;
    this.text.push(line);
    if (line.includes('\x1b') || sgrActive(this.sgr)) {
      if (sgrActive(this.sgr)) this.sgrAt.set(i, { ...this.sgr });
      advanceSgr(this.sgr, line);
      const plain = stripAnsi(line);
      if (plain !== line) this.plainAt.set(i, plain);
    }
    let text = this.plainOf(i);
    const tm = TS_RE.exec(text);
    if (tm) {
      text = text.slice(tm[0].length);
      if (!this.tsw) {  // wrapped lines indent past the timestamp (style.css)
        this.tsw = true;
        this.pre.style.setProperty('--tsw', `${tm[0].length}ch`);
      }
    }
    let pkg = '';
    if (this.fixed) {
      const pm = PKG_RE.exec(text);
      if (pm) { pkg = pm[1]; text = text.slice(pm[0].length); }
    }
    this.pkg[i] = pkg;
    let fold = null;
    if (this.ai) {
      this.cls[i] = '';
    } else {
      // parallel jobs interleave their lines: each package keeps its own
      // lint state (a CMake warning block, the last diagnostic)
      let st = this.lintBy.get(pkg);
      if (!st) this.lintBy.set(pkg, st = newLintState());
      this.st[i] = snap(st);
      const r = lintLine(text, st, false);
      this.cls[i] = r.cls.join(' ');
      if (r.cls.includes('l-err')) this.problems.push([i, 'err']);
      else if (r.cls.includes('l-warn')) this.problems.push([i, 'warn']);
      if (!this.raw) fold = r.fold;
    }
    // install lines join one group per package, also when other packages
    // print in between, until that package prints something else
    if (fold) {
      let g = this.open.get(pkg);
      if (!g) {
        g = { g: true, pkg, members: [], open: false };
        this.place(g);
        this.open.set(pkg, g);
      }
      g.members.push(i);
      this.itemOf[i] = g;
      touched.add(this.chunks[g.c]);
    } else {
      this.open.delete(pkg);
      const it = { i };
      this.itemOf[i] = it;
      this.place(it);
      touched.add(this.chunks[it.c]);
    }
    if (this.query && this.matches(i)) {
      this.hits.push(i);
      this.hitSet.add(i);
    }
  }

  place(it) {
    let c = this.chunks[this.chunks.length - 1];
    if (!c || c.items.length >= CH) {
      const el = document.createElement('div');
      el.className = 'chunk';
      c = { idx: this.chunks.length, items: [], el, rich: false, near: false, done: 0 };
      el.chunk = c;
      this.chunks.push(c);
      this.pre.appendChild(el);
      this.io.observe(el);
    }
    it.c = c.idx;
    it.k = c.items.length;
    c.items.push(it);
  }

  // ---- display ----------------------------------------------------------

  shown(g) { return g.open || g.members.length < FOLD_MIN; }

  // a chunk changed: new items, or a group in it grew
  sync(c) {
    c.rows = null;
    if (!c.rich) {
      if (!this.selected(c)) c.el.textContent = this.plainText(c);
      else this.waiting.add(c);
    } else {
      for (const it of c.items.slice(0, c.done)) if (it.g) this.syncGroup(it);
      const frag = document.createDocumentFragment();
      for (const it of c.items.slice(c.done)) frag.appendChild(this.renderItem(it));
      c.el.appendChild(frag);
      c.done = c.items.length;
    }
    this.size(c);
  }

  // a rendered group gets the members that arrived since
  syncGroup(g) {
    if (!g.el) return;
    const wasShown = g.el.dataset.shown === '1';
    if (wasShown !== this.shown(g)) {  // it grew past FOLD_MIN: fold it
      const el = this.renderItem(g);
      g.el.replaceWith(el);
      return;
    }
    if (g.done < g.members.length) {
      const add = g.members.slice(g.done);
      if (this.shown(g)) for (const i of add) g.body.appendChild(this.lineEl(i));
      else g.body.append(add.map(i => this.plainOf(i) + '\n').join(''));
      g.done = g.members.length;
    }
    this.headText(g);
  }

  renderItem(it) {
    if (!it.g) return this.lineEl(it.i);
    const el = document.createElement('span');
    el.className = 'lgrp';
    el.item = it;
    const shown = this.shown(it);
    el.dataset.shown = shown ? '1' : '0';
    if (it.members.length < FOLD_MIN) el.classList.add('short');
    if (!shown) el.classList.add('folded');
    const head = document.createElement('span');
    head.className = 'lgrp-head';
    head.title = 'click to show or hide these lines';
    if (it.pkg) head.append(pkgTag(it.pkg), ' ');
    head.appendChild(Object.assign(document.createElement('span'), { className: 'gcount' }));
    const body = document.createElement('span');
    body.className = 'lgrp-body';
    if (shown) {
      const frag = document.createDocumentFragment();
      for (const i of it.members) frag.appendChild(this.lineEl(i));
      body.appendChild(frag);
    } else {
      // the browser's find reaches folded lines, and opens the group
      body.setAttribute('hidden', 'until-found');
      body.textContent = it.members.map(i => this.plainOf(i) + '\n').join('');
    }
    el.append(head, body);
    it.el = el;
    it.body = body;
    it.done = it.members.length;
    this.headText(it);
    return el;
  }

  headText(g) {
    g.el.querySelector('.gcount').textContent = `${g.members.length} install lines`;
  }

  lineEl(i) {
    const ln = buildLine(this.text[i], {
      fixed: this.fixed, ai: this.ai, raw: this.raw, cls: this.cls[i],
      st: this.st[i] ? { ...this.st[i] } : newLintState(),
      sgr: this.sgrAt.has(i) ? { ...this.sgrAt.get(i) } : newSgr(),
    });
    ln.dataset.i = i;
    if (this.hitSet.has(i)) ln.classList.add('hit');
    if (i === this.hits[this.hitIdx]) ln.classList.add('hit-cur');
    this.decorate?.(ln.lastElementChild);
    return ln;
  }

  // the rows of a chunk as plain text, as the rendered chunk shows them
  plainText(c) {
    let s = '';
    for (const it of c.items) {
      if (!it.g) { s += this.plainOf(it.i) + '\n'; continue; }
      if (it.members.length >= FOLD_MIN) {
        s += `${it.pkg ? it.pkg + ' ' : ''}${it.members.length} install lines\n`;
      }
      if (this.shown(it)) for (const i of it.members) s += this.plainOf(i) + '\n';
    }
    return s;
  }

  // the rows of a chunk, and the longest one, for the size estimate
  measure(c) {
    if (c.rows) return c.rows;
    const wrap = this.pre.classList.contains('wrap') ? this.cols() : 0;
    const rowsOf = i => (wrap ? Math.max(1, Math.ceil(this.text[i].length / wrap)) : 1);
    let rows = 0, wide = 0;
    for (const it of c.items) {
      if (!it.g) {
        rows += rowsOf(it.i);
        wide = Math.max(wide, this.text[it.i].length);
        continue;
      }
      if (it.members.length >= FOLD_MIN) rows++;
      if (this.shown(it)) {
        for (const i of it.members) {
          rows += rowsOf(i);
          wide = Math.max(wide, this.text[i].length);
        }
      }
    }
    return (c.rows = { rows, wide });
  }

  cols() {
    if (!this.charPx) {
      const probe = document.createElement('span');
      probe.textContent = 'x'.repeat(100);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      this.pre.appendChild(probe);
      this.charPx = probe.getBoundingClientRect().width / 100 || 7.2;
      probe.remove();
    }
    return Math.max(20, Math.floor((this.pre.clientWidth - 40) / this.charPx));
  }

  // the size that the browser assumes for a chunk out of view
  size(c) {
    const m = this.measure(c);
    c.el.style.containIntrinsicSize = `${m.wide + 4}ch ${Math.max(1, m.rows) * this.linePx}px`;
  }

  // the width or the wrap changed: new estimates for the chunks
  relayout() {
    this.charPx = 0;
    for (const c of this.chunks) {
      c.rows = null;
      this.size(c);
    }
  }

  onIntersect(entries) {
    for (const e of entries) {
      const c = e.target.chunk;
      c.near = e.isIntersecting;
      if (c.near) this.hydrate(c);
      else this.dehydrate(c);
    }
  }

  selected(c) {
    const s = getSelection();
    return s.rangeCount > 0 && !s.isCollapsed && s.getRangeAt(0).intersectsNode(c.el);
  }

  hydrate(c, force = false) {
    if (c.rich) return;
    if (!force && this.selected(c)) { this.waiting.add(c); return; }
    this.waiting.delete(c);
    const frag = document.createDocumentFragment();
    for (const it of c.items) frag.appendChild(this.renderItem(it));
    c.el.textContent = '';
    c.el.appendChild(frag);
    c.rich = true;
    c.done = c.items.length;
    if (!this.calibrated && !this.pre.classList.contains('wrap') && c.el.offsetHeight) {
      // the real line height, for the estimates of the other chunks
      this.calibrated = true;
      const px = c.el.offsetHeight / Math.max(1, this.measure(c).rows);
      if (px > 8 && px < 40 && Math.abs(px - this.linePx) > 0.1) {
        this.linePx = px;
        this.relayout();
      }
    }
  }

  dehydrate(c) {
    if (!c.rich) return;
    if (this.selected(c)) { this.waiting.add(c); return; }
    if (c.items.some(it => !it.g && it.i === this.hits[this.hitIdx])) return;
    for (const it of c.items) if (it.g) { it.el = null; it.body = null; }
    c.rich = false;
    c.el.textContent = this.plainText(c);
  }

  // the selection ended: the chunks that waited change now
  retry() {
    for (const c of [...this.waiting]) {
      if (this.selected(c)) continue;
      this.waiting.delete(c);
      if (c.near) this.hydrate(c);
      else if (c.rich) this.dehydrate(c);
      else c.el.textContent = this.plainText(c);
    }
  }

  toggleGroup(head) {
    const g = head.parentElement.item;
    if (!g) return;
    g.open = !this.shown(g) ? true : false;
    this.rebuild(g);
  }

  rebuild(g) {
    const c = this.chunks[g.c];
    c.rows = null;
    if (c.rich && g.el) g.el.replaceWith(this.renderItem(g));
    else if (!c.rich) c.el.textContent = this.plainText(c);
    this.size(c);
  }

  onBeforeMatch(ev) {
    const g = ev.target.closest('.lgrp')?.item;
    if (g && !this.shown(g)) {
      g.open = true;
      // the browser shows the match after this event: rebuild after it
      requestAnimationFrame(() => this.rebuild(g));
    }
  }

  // show line i: open its group, render its chunk, scroll to it
  reveal(i, flash = false) {
    const it = this.itemOf[i];
    if (!it) return null;
    if (it.g && !this.shown(it)) {
      it.open = true;
      this.rebuild(it);
    }
    const c = this.chunks[it.c];
    this.hydrate(c, true);
    const el = c.el.querySelector(`[data-i="${i}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      if (flash) {
        el.classList.remove('flash');
        void el.offsetWidth;  // restart the animation
        el.classList.add('flash');
      }
    }
    return el;
  }

  refreshRich() {
    for (const c of this.chunks) {
      if (!c.rich || this.selected(c)) continue;
      c.rich = false;
      this.hydrate(c);
    }
  }

  setRaw(raw) {
    this.keepPosition(() => {
      const text = this.text, buf = this.buf, q = this.query, re = this.queryRe;
      this.reset();
      this.raw = raw;
      this.pre.classList.toggle('raw', raw);
      this.query = q;
      this.queryRe = re;
      if (text.length) this.append(text.join('\n') + '\n');
      this.buf = buf;
    });
  }

  // ---- the scroll position ------------------------------------------------

  // run change (a new display, or a new line layout), and keep the line at
  // the top of the view where it was
  keepPosition(change) {
    const anchor = this.topLine();
    change();
    if (anchor) this.restore(anchor);
  }

  // the first line in view, and how far below the top of the view it is.
  // Rects, not offsetTop: a chunk's containment makes it the offsetParent
  // of its lines, so their offsetTop counts from the chunk
  topLine() {
    const view = this.pre.getBoundingClientRect().top;
    for (const c of this.chunks) {
      const r = c.el.getBoundingClientRect();
      if (r.bottom <= view) continue;
      if (!c.rich) {  // plain text in view: its first item is close enough
        const it = c.items[0];
        if (!it) return null;
        return { i: it.g ? it.members[0] : it.i, dy: r.top - view };
      }
      for (const el of c.el.querySelectorAll('.ln[data-i], .lgrp.folded')) {
        const er = el.getBoundingClientRect();
        if (er.bottom <= view) continue;
        const i = el.dataset.i != null ? +el.dataset.i : el.item.members[0];
        return { i, dy: er.top - view };
      }
    }
    return null;
  }

  restore({ i, dy }) {
    const it = this.itemOf[i];
    if (!it) return;
    const c = this.chunks[it.c];
    this.hydrate(c, true);
    // the line itself, or the group line when it folded away
    const el = c.el.querySelector(`.ln[data-i="${i}"]`) || (it.g && it.el) || c.el;
    const now = el.getBoundingClientRect().top - this.pre.getBoundingClientRect().top;
    this.pre.scrollTop += now - dy;
  }

  // ---- search -------------------------------------------------------------

  matches(i) {
    const t = this.plainOf(i).replace(TS_RE, '');
    return this.queryRe ? this.queryRe.test(t) : t.toLowerCase().includes(this.query);
  }

  // q: the typed text; re, when given, picks the lines instead
  search(q, re = null) {
    for (const el of this.pre.querySelectorAll('.hit, .hit-cur')) el.classList.remove('hit', 'hit-cur');
    this.query = q ? q.toLowerCase() : null;
    this.queryRe = q ? re : null;
    this.hits = [];
    this.hitSet = new Set();
    this.hitIdx = -1;
    if (!this.query) return 0;
    for (let i = 0; i < this.text.length; i++) if (this.matches(i)) this.hits.push(i);
    this.hitSet = new Set(this.hits);
    for (const el of this.pre.querySelectorAll('.ln[data-i]')) {
      if (this.hitSet.has(+el.dataset.i)) el.classList.add('hit');
    }
    return this.hits.length;
  }

  // jump to hit k (wraps around)
  focusHit(k) {
    if (!this.hits.length) return null;
    this.pre.querySelector('.hit-cur')?.classList.remove('hit-cur');
    this.hitIdx = (k + this.hits.length) % this.hits.length;
    const el = this.reveal(this.hits[this.hitIdx]);
    el?.classList.add('hit', 'hit-cur');
    return el;
  }

  // ---- marks ---------------------------------------------------------------

  // the errors and warnings, as marks in box: their place in the log
  marks(box, onJump) {
    box.textContent = '';
    const h = this.pre.scrollHeight;
    if (!h || h <= this.pre.clientHeight || !this.problems.length) return;
    const step = Math.max(1, Math.ceil(this.problems.length / MAX_MARKS));
    const frag = document.createDocumentFragment();
    for (let k = 0; k < this.problems.length; k += step) {
      const [i, kind] = this.problems[k];
      const y = this.yOf(i);
      if (y == null) continue;
      const m = document.createElement('span');
      m.className = `mk ${kind}`;
      m.style.top = `${(100 * y / h).toFixed(2)}%`;
      m.title = this.plainOf(i).replace(TS_RE, '').trim().slice(0, 160);
      m.onclick = () => { onJump?.(); this.reveal(i, true); };
      frag.appendChild(m);
    }
    box.appendChild(frag);
  }

  // the y of line i: its chunk's top, and its row in the chunk
  yOf(i) {
    const it = this.itemOf[i];
    if (!it) return null;
    const c = this.chunks[it.c];
    let row = 0;
    for (const x of c.items) {
      if (x === it) break;
      if (!x.g) row++;
      else row += (x.members.length >= FOLD_MIN ? 1 : 0) + (this.shown(x) ? x.members.length : 0);
    }
    const rows = Math.max(1, this.measure(c).rows);
    return c.el.offsetTop + (row / rows) * c.el.offsetHeight;
  }

  // ---- copy -----------------------------------------------------------------

  // a selection over more than one line copies whole lines from the data:
  // the exact log text, with the lines of folded groups, and without the
  // timestamps while they are hidden
  onCopy(ev) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const a = this.rowAt(r.startContainer, r.startOffset);
    const b = this.rowAt(r.endContainer, r.endOffset, true);
    if (!a || !b) return;
    if (a.c === b.c && a.k === b.k && a.m === b.m && !this.chunks[a.c].items[a.k].g) return;
    const ts = this.pre.classList.contains('showts');
    const out = this.linesBetween(a, b).map(i => (ts ? this.plainOf(i) : this.plainOf(i).replace(TS_RE, '')));
    if (!out.length) return;
    ev.clipboardData.setData('text/plain', out.join('\n') + '\n');
    ev.preventDefault();
  }

  // the display row at a DOM position: chunk c, item k, member m (-1: the
  // line itself, or a whole group)
  rowAt(node, offset, end = false) {
    if (node === this.pre) {
      const c = this.chunks[Math.min(offset, this.chunks.length) - (end ? 1 : 0)] || this.chunks[0];
      if (!c) return null;
      const k = end ? c.items.length - 1 : 0;
      return { c: c.idx, k, m: -1 };
    }
    const el = node.nodeType === 1 ? node : node.parentElement;
    const chunkEl = el?.closest('.chunk');
    if (!chunkEl || !this.pre.contains(chunkEl)) return null;
    const c = chunkEl.chunk;
    if (c.rich) {
      const ln = el.closest('.ln[data-i]');
      if (ln) {
        const i = +ln.dataset.i;
        const it = this.itemOf[i];
        return { c: c.idx, k: it.k, m: it.g ? it.members.indexOf(i) : -1 };
      }
      const g = el.closest('.lgrp')?.item;
      if (g) return { c: c.idx, k: g.k, m: -1 };
      // between the items of the chunk
      const k = Math.min(c.items.length - 1, Math.max(0, node === chunkEl ? offset - (end ? 1 : 0) : 0));
      return { c: c.idx, k, m: -1 };
    }
    // plain text: count the rows before the offset
    const text = chunkEl.textContent;
    const at = node.nodeType === 3 ? offset : (offset ? text.length : 0);
    let row = 0;
    for (let p = text.indexOf('\n'); p >= 0 && p < at - (end ? 1 : 0); p = text.indexOf('\n', p + 1)) row++;
    for (const it of c.items) {
      if (!it.g) {
        if (row === 0) return { c: c.idx, k: it.k, m: -1 };
        row--;
        continue;
      }
      if (it.members.length >= FOLD_MIN) {
        if (row === 0) return { c: c.idx, k: it.k, m: -1 };
        row--;
      }
      if (this.shown(it)) {
        if (row < it.members.length) return { c: c.idx, k: it.k, m: row };
        row -= it.members.length;
      }
    }
    return { c: c.idx, k: c.items.length - 1, m: -1 };
  }

  // the lines from row a to row b, in display order
  linesBetween(a, b) {
    const out = [];
    for (let ci = a.c; ci <= b.c; ci++) {
      const items = this.chunks[ci].items;
      const k0 = ci === a.c ? a.k : 0;
      const k1 = ci === b.c ? b.k : items.length - 1;
      for (let k = k0; k <= k1; k++) {
        const it = items[k];
        if (!it.g) { out.push(it.i); continue; }
        const m0 = ci === a.c && k === a.k && a.m >= 0 ? a.m : 0;
        const m1 = ci === b.c && k === b.k && b.m >= 0 ? b.m : it.members.length - 1;
        for (let m = m0; m <= m1; m++) out.push(it.members[m]);
      }
    }
    return out;
  }
}
