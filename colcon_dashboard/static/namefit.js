/* Package names in a list: fit them in a column and show the part that
   tells them apart. Many names share words (behavior_path_..._module), so:
   - a word that many names of the list share is "common" and shows muted
   - when names do not fit, common words get shorter, one word at a time
     and the same way in every row (behavior -> beh, velocity -> vel)
   - a name that is still too long is cut around the part that differs
   It imports nothing. */

// "behavior" -> "beh", "velocity" -> "vel", "trajectory" -> "traj": the
// letters up to the first consonant after the first vowels, at least three
function abbrev(w) {
  const m = /^[^aeiou]*[aeiou]+[^aeiou]?/.exec(w);
  return w.slice(0, Math.max(3, m ? m[0].length : 3));
}

// for each text, the index of its first character that no other text
// shares: neighbors in sorted order share the longest starts
function differAt(texts) {
  const s = [...new Set(texts)].sort();
  const same = (a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  const at = new Map();
  s.forEach((n, i) => at.set(n, Math.max(i ? same(n, s[i - 1]) : 0,
                                         i + 1 < s.length ? same(n, s[i + 1]) : 0)));
  return at;
}

// the parts of t to show, as [from, to] ranges with … between them (and
// after the last one when it stops short of the end); u is the index of
// the first character that differs from the other names. In order:
// - keep the last word (module, launch, msgs) and as much of the start
//   as fits, when that start shows the part that differs
// - else cut the end, when the part that differs still shows
// - else cut before the word that differs
export function cutRanges(t, fit, u = 0) {
  if (t.length <= fit) return [[0, t.length]];
  const room = fit - 1;  // the characters around the …
  if (room < 4) return [[0, Math.max(0, room)]];
  const lw = t.lastIndexOf('_') + 1;  // the start of the last word
  if (lw > 0 && t.length - lw <= room * 0.4) {
    const head = room - (t.length - lw);
    if (u + 3 <= head) return [[0, head], [lw, t.length]];
  }
  if (u + 3 <= room) return [[0, room]];
  const b = t.lastIndexOf('_', u - 1) + 1;  // the start of the word that differs
  if (t.length - b <= room - 3) return [[0, room - (t.length - b)], [b, t.length]];
  return [[0, 3], [b, b + room - 4]];
}

/* fitNames(labels, fit) -> for each label { text, mask, ranges }:
   text is the label with its shortened words, mask has a '1' for each
   character to mute, u is where it differs, and ranges come from
   cutRanges. The last result is kept: the live chart asks again every
   other poll. */
let last = { key: null, out: null };

export function fitNames(labels, fit) {
  const key = fit + '|' + labels.join(',');
  if (last.key === key) return last.out;
  const split = labels.map(l => l.split('_'));
  const freq = new Map();
  for (const ws of split) {
    for (const w of new Set(ws)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  // common: in 3 names, or in 2% of a long list
  const min = Math.max(3, Math.ceil(labels.length * 0.02));
  const common = w => freq.get(w) >= min && /[a-z]/.test(w);

  // the short form of each common word: one form for the whole list, and
  // only when it saves three letters (module -> mod, not launch -> laun)
  const short = new Map();
  const used = new Set(freq.keys());  // a short form must not read as a word
  const hits = new Map();  // common word -> names that do not fit and hold it
  for (const ws of split) {
    if (ws.join('_').length <= fit) continue;
    for (const w of new Set(ws)) if (common(w)) hits.set(w, (hits.get(w) || 0) + 1);
  }
  // the word that the most names that do not fit hold goes first
  const order = [...hits.keys()].sort((x, y) => hits.get(y) - hits.get(x)
                                               || y.length - x.length);
  for (const w of order) {
    let a = abbrev(w);
    while (used.has(a) && a.length < w.length - 3) a = w.slice(0, a.length + 1);
    if (used.has(a) || a.length > w.length - 3) continue;  // no short form
    used.add(a);
    short.set(w, a);
  }
  // a name that does not fit shortens its common words in that order, until
  // it fits; a name that fits stays whole
  const shortIn = split.map(ws => {
    const mine = new Set();
    let len = ws.join('_').length;
    for (const w of order) {
      if (len <= fit) break;
      if (!short.has(w) || !ws.includes(w)) continue;
      mine.add(w);
      len -= (w.length - short.get(w).length) * ws.filter(x => x === w).length;
    }
    return mine;
  });
  const shown = (w, i) => (shortIn[i].has(w) ? short.get(w) : w);
  const join = (ws, i) => ws.map(w => shown(w, i)).join('_');

  const texts = split.map(join);
  const differs = differAt(texts);
  const out = split.map((ws, i) => {
    // a name of common words only shows nothing muted
    const mute = !ws.every(common);
    let mask = '';
    ws.forEach((w, j) => {
      const m = mute && common(w);
      // the _ between two words is muted when a word next to it is
      if (j) mask += m || mask.endsWith('1') ? '1' : '0';
      mask += (m ? '1' : '0').repeat(shown(w, i).length);
    });
    const text = texts[i], u = differs.get(text);
    return { text, mask, u, ranges: cutRanges(text, fit, u) };
  });
  last = { key, out };
  return out;
}

// the shown string of a fitNames result, with its … marks
export function fittedText(f) {
  let s = '';
  f.ranges.forEach(([a, b], i) => { s += (i ? '…' : '') + f.text.slice(a, b); });
  const end = f.ranges[f.ranges.length - 1][1];
  return end < f.text.length ? s + '…' : s;
}
