import { on } from './bus.js';
import { PALETTES, svg } from './logo.js';
import { App } from './state.js';
import { $, fmtDur } from './util.js';

/* ---------------- tab progress + notifications ----------------
   The tab title and favicon mirror the build, so a background tab
   still tells the story. The favicon is the logo itself: its liquid
   fills with the build, and its knob turns red on a failure. The bell cycles off -> notify -> notify with
   a chime; desktop notifications fire when a build finishes or first
   fails, and only while the page is not focused. */

const MODES = ['off', 'on', 'sound'];
let notifyMode = localStorage.getItem('cmc-notify') || 'off';
let prevActive = null;
let failNotified = false;
let audioCtx = null;
let lastIcon = null;
let lastLogo = {};
const BASE_TITLE = document.title;
// the tab strip follows the browser's scheme, not the page theme
const darkTabs = matchMedia('(prefers-color-scheme: dark)');
const KNOB = { failed: '#d3402b', aborted: '#e8741f' };

// logo: settings for logo.js, e.g. { progress: 0.4, knob: KNOB.failed };
// {} is the plain logo
function setFavicon(logo) {
  const key = JSON.stringify(logo) + darkTabs.matches;
  if (key === lastIcon) return;
  lastIcon = key;
  lastLogo = logo;
  // index.html starts with a light and a dark icon; one live icon replaces both
  const links = [...document.querySelectorAll('link[rel="icon"]')];
  links.slice(1).forEach(l => l.remove());
  links[0].removeAttribute('media');
  links[0].href = 'data:image/svg+xml,'
    + encodeURIComponent(svg(logo, 'rich', darkTabs.matches, 64));
}
darkTabs.addEventListener('change', () => setFavicon(lastLogo));

function wsName() {
  return (App.workspace || '').split('/').filter(Boolean).pop() || 'colcon';
}

function applyTab(s) {
  const c = s.counts || {};
  // whole percent steps, so the icon redraws at most 100 times a build
  const done = s.total ? Math.round(100 * (c.done || 0) / s.total) / 100 : 0;
  if (s.active) {
    document.title = `[${Math.round(done * 100)}%] ${wsName()}`;
    setFavicon({ progress: done });
  } else if (c.failed) {
    document.title = `✗ ${wsName()}`;
    setFavicon({ progress: done, knob: KNOB.failed });
  } else if (s.total && (c.done || 0) === s.total) {
    document.title = `✓ ${wsName()}`;
    const green = (darkTabs.matches ? PALETTES.richDark : PALETTES.richLight).green;
    setFavicon({ progress: 1, knob: green });
  } else if (c.aborted) {
    document.title = `◌ ${wsName()}`;
    setFavicon({ progress: done, knob: KNOB.aborted });
  } else {
    document.title = BASE_TITLE;
    setFavicon({});
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
    btn.setAttribute('aria-pressed', notifyMode !== 'off' ? 'true' : 'false');
    // the bell must not claim notifications that the browser refuses
    const blocked = notifyMode === 'off' ? null
      : !('Notification' in window) ? 'this browser has no desktop notifications'
        : !window.isSecureContext ? 'browsers allow them only on localhost or https; '
                                    + 'open the dashboard through localhost or an SSH tunnel'
          : Notification.permission === 'denied' ? 'the browser blocks them for this site'
            : null;
    btn.classList.toggle('blocked', !!blocked);
    if (blocked) btn.title += `\n\nDesktop notifications do not work: ${blocked}.`;
  };
  btn.onclick = () => {
    notifyMode = MODES[(MODES.indexOf(notifyMode) + 1) % MODES.length];
    localStorage.setItem('cmc-notify', notifyMode);
    if (notifyMode !== 'off' && 'Notification' in window
        && Notification.permission === 'default') {
      Notification.requestPermission().then(apply, apply);
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
  setFavicon({});
  prevActive = null;  // reconnecting must not fire a stale notification
});
