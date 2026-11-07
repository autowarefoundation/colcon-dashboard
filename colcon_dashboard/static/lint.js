/* ---------------- log lint ----------------
   Colors the recurring parts of a colcon log, so that a long log reads
   by its shape: colcon job lines, CMake status and progress, CMake
   warning blocks, GCC diagnostics with their code excerpts, make, and
   setuptools. The patterns come from real Autoware builds, where 60% of
   the lines are "-- Up-to-date symlink:" install noise: those lines fold
   (fold: 'install'), and ansi.js groups each run of them.

   lintLine(text, st) returns { cls, fold, nodes }: the line classes, the
   fold kind or null, and the nodes that render the text. st carries what
   one line tells about the next ones (a CMake warning block, the
   severity of the last GCC diagnostic) and belongs to one log. */

export function newLintState() { return { block: null, diag: null }; }

const sp = (cls, text) => {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
};
const tx = text => document.createTextNode(text);

// a stable hue per package, so that the interleaved output of parallel
// jobs in the build log separates by color
const hues = new Map();
export function pkgHue(name) {
  let h = hues.get(name);
  if (h == null) {
    h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    // 80..300: greens, blues, and purples; red, orange, and yellow mean trouble
    h = 80 + (h % 220);
    hues.set(name, h);
  }
  return h;
}

export function pkgTag(name) {
  const s = sp('pk', name);
  s.style.setProperty('--h', pkgHue(name));
  s.title = `${name}: click to open its log`;
  return s;
}

// an absolute path: the directories dim, the file name plain
function pathNodes(path, cls = 'pth') {
  const i = path.lastIndexOf('/');
  if (i <= 0) return [sp(cls, path)];
  const s = document.createElement('span');
  s.className = cls;
  s.append(sp('pdir', path.slice(0, i + 1)), tx(path.slice(i + 1)));
  return [s];
}

// a message: ‘quoted code’ and a trailing [-Wflag] stand out
function msgNodes(msg) {
  const out = [];
  let rest = msg;
  let flag = null;
  const fm = /\s(\[-W[\w=+-]+\])$/.exec(rest);
  if (fm) { flag = fm[1]; rest = rest.slice(0, fm.index); }
  const re = /‘([^’]*)’|'([^'\n]{1,120})'/g;
  let at = 0, m;
  while ((m = re.exec(rest))) {
    if (m.index > at) out.push(tx(rest.slice(at, m.index)));
    out.push(sp('qt', m[0]));
    at = m.index + m[0].length;
  }
  if (at < rest.length) out.push(tx(rest.slice(at)));
  if (flag) out.push(tx(' '), sp('wflag', flag));
  return out;
}

function durNode(sec) {
  const s = sp('dur', `${sec}s`);
  const v = parseFloat(sec);
  if (v >= 300) s.classList.add('slow2');
  else if (v >= 60) s.classList.add('slow1');
  return s;
}

const SEV = { 'fatal error': 'err', error: 'err', warning: 'warn', note: 'note' };

// GCC/Clang: path:line[:col]: severity: message
const DIAG_RE = /^((?:\/|\.{1,2}\/|[\w.+-]+\/)[^\s:]*|[\w.+-]+\.\w+):(\d+)(?::(\d+))?: (fatal error|error|warning|note): (.*)$/;
// NVCC: path(line): warning #191-D: message
const NVCC_RE = /^((?:\/|\.{1,2}\/)[^\s(]*)\((\d+)\): (error|warning|remark)( #[\w-]+)?: (.*)$/;
// a tool without a position: "lto-wrapper: warning: ..."
const TOOL_DIAG_RE = /^([\w.+-]+): (fatal error|error|warning|note): (.*)$/;
const CTX_RE = /^(\S+): ((?:In (?:static |member |instantiation of |constructor |destructor )?(?:function|member function|instantiation of|constructor|destructor)?.*|At global scope)):$/;
const INCL_RE = /^(In file included from|\s+from) ((?:\/|\.)[^\s:]*):(\d+)([,:]?)$/;
const CODE_RE = /^(\s*)(\d+)( \| )(.*)$/;
const CARET_RE = /^(\s*\| )(.*)$/;
const CMAKE_MSG_RE = /^CMake (Warning|Error|Deprecation Warning)( \(dev\))?( at (\S+?):(\d+)( \([\w-]+\))?)?:?$/;
const INSTALL_RE = /^-- (Up-to-date symlink|Up-to-date|Installing|Symlinking|Old export file \S+ will be replaced\.|Removing):? ?(.*)$/;
const FOUND_RE = /^-- (Found) ([\w.+-]+)(?:: ([\w.+-]+))?(.*)$/;
const PROGRESS_RE = /^\[\s*(\d+)%\] (.*)$/;
const NINJA_RE = /^\[(\d+)\/(\d+)\] (.*)$/;
const STEP_RE = /^(Building (?:CXX|C|CUDA|NVCC|Fortran) object|Linking (?:CXX|C|CUDA) (?:shared library|executable|static library|shared module)|Built target|Generating|Automatic MOC|Running|Scanning dependencies)( )?(.*)$/;
const PY_RE = /^(running|copying|creating|writing|byte-compiling|removing|reading|adding|Copying|Creating|Listing|Compiling|Installing|Processing|Searching|Finished processing|Installed|Running setup\.py) (.*)$/;
const MAKE_RE = /^(g?make(?:\[\d+\])?:) (.*)$/;
const INVOKE_RE = /^(Invoking|Invoked) command in '([^']*)'(?: (returned) '(-?\d+)')?: (.*)$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

// the environment that colcon puts before each command: one chip that
// opens on a click (dock.js), then the command itself
function invokeNodes(m) {
  const out = [sp('mut', `${m[1]} command in `), ...pathNodes(m[2])];
  if (m[3]) out.push(tx(' '), sp(m[4] === '0' ? 'rc ok' : 'rc bad', `returned ${m[4]}`));
  out.push(tx(': '));
  const words = m[5].split(' ');
  let i = 0;
  while (i < words.length && ENV_RE.test(words[i])) i++;
  if (i) {
    const label = `${i} environment variable${i === 1 ? '' : 's'}`;
    const env = sp('envfold', label);
    env.dataset.lbl = label;
    env.dataset.full = words.slice(0, i).join(' ');
    env.title = 'click to show the environment';
    out.push(env, tx(' '));
  }
  const cmd = words.slice(i);
  if (cmd.length) {
    out.push(sp('cmd', cmd[0]));
    for (const w of cmd.slice(1)) out.push(tx(' '), /^-/.test(w) ? sp('flag', w) : tx(w));
  }
  return out;
}

function progressNodes(pct, rest) {
  const bar = sp('pct', `${pct}%`);
  bar.style.setProperty('--p', `${pct}%`);
  const out = [bar, tx(' ')];
  const sm = STEP_RE.exec(rest);
  if (!sm) return { cls: [], nodes: out.concat(tx(rest)) };
  const step = sm[1];
  const cls = step === 'Built target' ? ['l-built'] : step.startsWith('Linking') ? ['l-link'] : ['l-step'];
  out.push(sp('verb', step));
  if (sm[3]) {
    out.push(tx(' '));
    out.push(...(/\//.test(sm[3]) ? pathNodes(sm[3]) : [sp('tgt', sm[3])]));
  }
  return { cls, nodes: out };
}

export function lintLine(text, st) {
  let m;
  // a CMake message block: its indented lines and blank lines, and the
  // few unindented lines that CMake puts inside, until other output
  if (st.block) {
    const inBlock = { cls: ['l-blk', `l-blk-${st.block}`], fold: null };
    if (/^\s*$/.test(text)) return { ...inBlock, nodes: [tx(text)] };
    if (/^\s/.test(text) || /^Call Stack \(most recent call first\):/.test(text)) {
      return { ...inBlock, nodes: msgNodes(text) };
    }
    if (/^This (warning|error) is for project developers/.test(text)) {
      const r = { ...inBlock, nodes: msgNodes(text) };
      st.block = null;  // the last line of a dev message
      return r;
    }
    st.block = null;
  }
  // colcon's job lines in the build log
  if ((m = /^Starting >>> (\S+)(.*)$/.exec(text))) {
    return { cls: ['l-job', 'l-start'], fold: null, nodes: [sp('jobv', 'Starting'), tx(' '), pkgTag(m[1]), tx(m[2])] };
  }
  if ((m = /^(Finished|Failed|Aborted)\s+<<< (\S+)(?: \[([\d.]+)s\])?(.*)$/.exec(text))) {
    const kind = { Finished: 'l-fin', Failed: 'l-err', Aborted: 'l-abort' }[m[1]];
    const nodes = [sp('jobv', m[1]), tx(' '), pkgTag(m[2])];
    if (m[3]) nodes.push(tx(' '), durNode(m[3]));
    nodes.push(tx(m[4]));
    return { cls: ['l-job', kind], fold: null, nodes };
  }
  if ((m = /^(--- (?:stderr|stdout): )(\S+)$/.exec(text))) {
    return { cls: ['l-sep'], fold: null, nodes: [sp('mut', m[1]), pkgTag(m[2])] };
  }
  if (text === '---') return { cls: ['l-sep'], fold: null, nodes: [sp('mut', text)] };
  if ((m = /^(Summary:)(.*)$/.exec(text))) return { cls: ['l-sum'], fold: null, nodes: [sp('jobv', m[1]), tx(m[2])] };

  // CMake
  if ((m = INSTALL_RE.exec(text))) {
    const nodes = [sp('mut', `-- ${m[1]}${m[2] ? ': ' : ''}`)];
    if (m[2]) nodes.push(...(m[2].startsWith('/') ? pathNodes(m[2]) : [tx(m[2])]));
    return { cls: ['l-noise'], fold: 'install', nodes };
  }
  if ((m = CMAKE_MSG_RE.exec(text))) {
    const sev = m[1] === 'Error' ? 'err' : 'warn';
    st.block = sev;
    const nodes = [sp(`sev ${sev}`, `CMake ${m[1]}${m[2] || ''}`)];
    if (m[3]) nodes.push(tx(' at '), ...pathNodes(`${m[4]}:${m[5]}`, 'pth fl'), tx(m[6] || ''));
    nodes.push(tx(':'));
    return { cls: [`l-${sev}`], fold: null, nodes };
  }
  if ((m = FOUND_RE.exec(text))) {
    const nodes = [sp('mut', '-- '), sp('verb', m[1]), tx(' '), sp('tgt', m[2])];
    if (m[3]) nodes.push(tx(': '), sp('ver', m[3]));
    const rest = m[4];
    const pm = /^(\s*\()(\/[^)]*)(\).*)$/.exec(rest);
    if (pm) nodes.push(tx(pm[1]), ...pathNodes(pm[2]), tx(pm[3]));
    else nodes.push(tx(rest));
    return { cls: ['l-cmake'], fold: null, nodes };
  }
  if (/^-- (Configuring done|Generating done|Build files have been written)/.test(text)) {
    return { cls: ['l-cmake', 'l-done'], fold: null, nodes: [tx(text)] };
  }
  if (text.startsWith('-- ')) return { cls: ['l-cmake'], fold: null, nodes: [tx(text)] };

  // GCC and Clang
  if ((m = DIAG_RE.exec(text))) {
    const sev = SEV[m[4]];
    st.diag = sev;
    const pos = m[2] + (m[3] ? `:${m[3]}` : '');
    return {
      cls: [`l-${sev}`, 'l-diag'],
      fold: null,
      nodes: [...pathNodes(`${m[1]}:${pos}`, 'pth fl'), tx(': '), sp(`sev ${sev}`, m[4]), tx(': '), ...msgNodes(m[5])],
    };
  }
  if ((m = NVCC_RE.exec(text))) {
    const sev = m[3] === 'remark' ? 'note' : SEV[m[3]];
    st.diag = sev;
    return {
      cls: [`l-${sev}`, 'l-diag'],
      fold: null,
      nodes: [...pathNodes(`${m[1]}(${m[2]})`, 'pth fl'), tx(': '), sp(`sev ${sev}`, m[3] + (m[4] || '')), tx(': '), ...msgNodes(m[5])],
    };
  }
  if ((m = TOOL_DIAG_RE.exec(text))) {
    const sev = SEV[m[2]];
    st.diag = sev;
    return { cls: [`l-${sev}`, 'l-diag'], fold: null, nodes: [sp('tgt', m[1]), tx(': '), sp(`sev ${sev}`, m[2]), tx(': '), ...msgNodes(m[3])] };
  }
  if ((m = INCL_RE.exec(text))) {
    return { cls: ['l-ctx'], fold: null, nodes: [sp('mut', m[1] + ' '), ...pathNodes(`${m[2]}:${m[3]}`, 'pth fl'), tx(m[4])] };
  }
  if ((m = CTX_RE.exec(text))) {
    return { cls: ['l-ctx'], fold: null, nodes: [...pathNodes(m[1], 'pth'), tx(': '), ...msgNodes(m[2]), tx(':')] };
  }
  if ((m = CODE_RE.exec(text))) {
    return { cls: ['l-code'], fold: null, nodes: [tx(m[1]), sp('lno', m[2]), sp('gut', m[3]), sp('src', m[4])] };
  }
  if ((m = CARET_RE.exec(text)) && /[\^~]/.test(m[2])) {
    return { cls: ['l-caret', `l-caret-${st.diag || 'note'}`], fold: null, nodes: [sp('gut', m[1]), sp('car', m[2])] };
  }

  // build steps
  if ((m = PROGRESS_RE.exec(text))) {
    const r = progressNodes(m[1], m[2]);
    return { cls: ['l-prog', ...r.cls], fold: null, nodes: r.nodes };
  }
  if ((m = NINJA_RE.exec(text))) {
    const pct = Math.round(100 * m[1] / Math.max(1, m[2]));
    const r = progressNodes(pct, m[3]);
    r.nodes[0].textContent = `${m[1]}/${m[2]}`;
    return { cls: ['l-prog', ...r.cls], fold: null, nodes: r.nodes };
  }
  if ((m = STEP_RE.exec(text))) {
    const r = progressNodes(0, text);
    return { cls: ['l-prog', ...r.cls], fold: null, nodes: r.nodes.slice(2) };
  }
  if ((m = MAKE_RE.exec(text))) {
    const bad = /\*\*\*.*Error/.test(m[2]);
    return { cls: [bad ? 'l-err' : 'l-make'], fold: null, nodes: [sp('mut', m[1] + ' '), tx(m[2])] };
  }
  if ((m = INVOKE_RE.exec(text))) {
    const bad = m[4] != null && m[4] !== '0';
    return { cls: ['l-invoke', ...(bad ? ['l-err'] : [])], fold: null, nodes: invokeNodes(m) };
  }
  if ((m = PY_RE.exec(text))) return { cls: ['l-py'], fold: null, nodes: [sp('verb', m[1]), tx(' '), tx(m[2])] };

  // anything else: the old word rules
  if (/\berror\b|\bfatal\b|FAILED/i.test(text)) return { cls: ['l-err'], fold: null, nodes: msgNodes(text) };
  if (/\bwarning\b/i.test(text)) return { cls: ['l-warn'], fold: null, nodes: msgNodes(text) };
  return { cls: [], fold: null, nodes: [tx(text)] };
}
