import { on } from './bus.js';
import { App } from './state.js';
import { $, fmtDur } from './util.js';

/* ---------------- tab progress + notifications ----------------
   The tab title and favicon mirror the build, so a background tab
   still tells the story. The bell cycles off -> notify -> notify with
   a chime; desktop notifications fire when a build finishes or first
   fails, and only while the page is not focused. */

const MODES = ['off', 'on', 'sound'];
let notifyMode = localStorage.getItem('cmc-notify') || 'off';
let prevActive = null;
let failNotified = false;
let audioCtx = null;
let lastIcon = null;
const BASE_TITLE = document.title;

function favicon(color) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    + '<polygon points="50,4 93,27 93,73 50,96 7,73 7,27" fill="none"'
    + ' stroke="#2a78d6" stroke-width="10"/>'
    + `<circle cx="50" cy="50" r="20" fill="${color}"/></svg>`);
}

function setFavicon(color) {
  if (color === lastIcon) return;
  lastIcon = color;
  document.querySelector('link[rel="icon"]').href = favicon(color);
}

function wsName() {
  return (App.workspace || '').split('/').filter(Boolean).pop() || 'colcon';
}

function applyTab(s) {
  const c = s.counts || {};
  if (s.active) {
    const pct = s.total ? Math.round(100 * (c.done || 0) / s.total) : 0;
    document.title = `[${pct}%] ${wsName()}`;
    setFavicon('#2a78d6');
  } else if (c.failed) {
    document.title = `✗ ${wsName()}`;
    setFavicon('#d03b3b');
  } else if (s.total && (c.done || 0) === s.total) {
    document.title = `✓ ${wsName()}`;
    setFavicon('#0ca30c');
  } else if (c.aborted) {
    document.title = `◌ ${wsName()}`;
    setFavicon('#ec835a');
  } else {
    document.title = BASE_TITLE;
    setFavicon('#0ca30c');
  }
}

function ding() {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    for (const [freq, at] of [[880, 0], [1175, 0.16]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.06, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.55);
    }
  } catch (e) { /* no audio device */ }
}

function notify(title, body) {
  if (notifyMode === 'off' || document.hasFocus()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body }); } catch (e) { /* denied */ }
  }
  if (notifyMode === 'sound') ding();
}

// Material Symbols, Apache-2.0, inlined so the page stays self-contained
export const BELL_ICONS = {
  off: '<svg viewBox="0 0 24 24"><path d="M20 18.69L7.84 6.14 5.27 3.49 4 ' +
       '4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 ' +
       '19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11' +
       'c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 ' +
       '1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 ' +
       '0-.01 0-.02.01-.23.09-.46.2-.68.31 0 0-.01 0-.01.01L18 14.68z"/>' +
       '</svg>',
  on: '<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 ' +
      '2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s' +
      '-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>' +
      '</svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M7.58 4.08L6.15 2.65C3.75 4.48 ' +
         '2.17 7.3 2.03 10.5h2c.15-2.65 1.51-4.97 3.55-6.42zm12.39 6.42h2c' +
         '-.15-3.2-1.73-6.02-4.12-7.85l-1.42 1.43c2.02 1.45 3.39 3.77 3.54 ' +
         '6.42zM18 11c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s' +
         '-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2v-5' +
         'zm-6 11c.14 0 .27-.01.4-.04.65-.13 1.19-.58 1.44-1.18.1-.24.15' +
         '-.5.15-.78h-4c.01 1.1.9 2 2.01 2z"/></svg>',
};

export function initNotify() {
  const btn = $('#bellBtn');
  const apply = () => {
    btn.classList.toggle('on', notifyMode !== 'off');
    btn.innerHTML = BELL_ICONS[notifyMode] || BELL_ICONS.off;
    btn.title = notifyMode === 'off'
      ? 'notifications off - click to notify when the build finishes'
      : notifyMode === 'on'
        ? 'notifications on - click to also play a chime'
        : 'notifications + chime - click to switch off';
  };
  btn.onclick = () => {
    notifyMode = MODES[(MODES.indexOf(notifyMode) + 1) % MODES.length];
    localStorage.setItem('cmc-notify', notifyMode);
    if (notifyMode !== 'off' && 'Notification' in window
        && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    if (notifyMode === 'sound') ding();  // the click is the audio gesture
    apply();
  };
  apply();
  // audio needs a user gesture per page load: the first interaction
  // primes the context, or a reloaded chime setting would stay silent
  const prime = () => {
    if (notifyMode !== 'sound') return;
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio device */ }
  };
  addEventListener('pointerdown', prime, { once: true, capture: true });
  addEventListener('keydown', prime, { once: true, capture: true });
}

on('state', s => {
  applyTab(s);
  const active = !!s.active;
  if (prevActive === true && !active && s.total) {
    const c = s.counts || {};
    if (c.failed) {
      notify(`✗ ${wsName()}: build failed`,
             `${c.failed} of ${s.total} packages failed`);
    } else if ((c.done || 0) === s.total) {
      notify(`✓ ${wsName()}: build complete`,
             `${s.total} packages in ${fmtDur(s.elapsed)}`);
    } else {
      notify(`◌ ${wsName()}: build stopped`,
             `${c.done || 0}/${s.total} done, ${c.aborted || 0} aborted`);
    }
  }
  prevActive = active;
});

on('pkg-failed', name => {
  if (failNotified) return;
  failNotified = true;
  notify(`✗ ${name} failed`, `the first failure in ${wsName()}`);
});

on('build-changed', () => {
  failNotified = false;
  prevActive = null;
});

on('state-lost', () => {
  // no build state to mirror: a stale "[42%]" title would lie
  document.title = BASE_TITLE;
  setFavicon('#0ca30c');
  prevActive = null;  // reconnecting must not fire a stale notification
});
