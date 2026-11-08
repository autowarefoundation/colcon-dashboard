/* Shell commands in the docs, colored as the app colors its build command
   (colcon_dashboard/static/header.js): the program, the subcommand, the
   flags, and the values. Pygments marks almost nothing in a shell line, so
   this script colors the words of each bash block after the page loads.
   The text stays the same, so the copy button copies what it did before.
   The "$" prompt comes from CSS (extra.css .cd-l), so a copy leaves it out. */
(() => {
  // the programs whose second word is a subcommand
  const SUB = new Set(['apt', 'apt-get', 'pipx', 'pip', 'git', 'systemctl', 'colcon',
    'ros2', 'loginctl', 'journalctl', 'python3', 'uv', 'docker']);
  // the wrappers that run the next word as the program
  const WRAP = new Set(['sudo', 'env', 'nohup', 'time', 'exec']);
  const TOKEN = /(\s+)|("(?:[^"\\]|\\.)*"|'[^']*')|(&&|\|\||2>&1|[|;]|>>?|<)|(#.*$)|([^\s"'|;&<>]+)/g;

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  // one line as colored nodes; cont: the line continues the one before
  function colorLine(text, cont) {
    const out = [];
    let cmd = !cont;   // the next word is in command position
    let prog = null;   // the program of the command
    let words = 0;     // the words after the program
    for (const m of text.matchAll(TOKEN)) {
      const [all, ws, str, op, com, word] = m;
      if (ws) { out.push(ws); continue; }
      if (com) { out.push(span('c-com', com)); continue; }
      if (op) { out.push(span('c-op', op)); cmd = op !== '>' && op !== '>>' && op !== '<' && op !== '2>&1'; prog = null; continue; }
      if (str) { out.push(span('c-val', str)); words++; continue; }
      if (cmd) {
        if (/^\w+=/.test(word)) { out.push(span('c-val', word)); continue; }  // VAR=value
        if (WRAP.has(word)) { out.push(span('c-dim', word)); continue; }
        out.push(span('c-prog', word));
        prog = word.replace(/^.*\//, '');
        cmd = false;
        words = 0;
        continue;
      }
      if (word === '\\') { out.push(span('c-op', word)); continue; }
      if (word.startsWith('-')) {
        const eq = word.indexOf('=');
        if (eq > 0) out.push(span('c-flag', word.slice(0, eq + 1)), span('c-val', word.slice(eq + 1)));
        else out.push(span('c-flag', word));
      } else if (words === 0 && prog && SUB.has(prog)) {
        out.push(span('c-verb', word));
      } else {
        out.push(span('c-val', word));
      }
      words++;
    }
    return out;
  }

  function colorBlock(block) {
    block.classList.add('cd-sh');
    const code = block.querySelector('pre > code');
    if (!code) return;
    // Pygments wraps each line in a span that starts with a line anchor
    const lines = [...code.children].filter(e => e.tagName === 'SPAN' && e.id.startsWith('__span'));
    let cont = false;
    for (const ln of lines) {
      const anchor = ln.querySelector(':scope > a');
      const raw = ln.textContent;
      const text = raw.replace(/\n$/, '');
      const prompt = !cont && text.trim() && !text.trim().startsWith('#');
      ln.replaceChildren(...(anchor ? [anchor] : []), ...colorLine(text, cont), raw.endsWith('\n') ? '\n' : '');
      ln.classList.toggle('cd-l', !!prompt);
      ln.classList.toggle('cd-cont', cont);
      cont = /\\\s*$/.test(text);
    }
  }

  function run() {
    for (const b of document.querySelectorAll('.md-typeset .language-bash.highlight:not(.cd-sh)')) colorBlock(b);
  }

  if (window.document$) window.document$.subscribe(run);
  else document.addEventListener('DOMContentLoaded', run);
})();
