/* The landing page hero (overrides/home.html) has one looping video per
   theme. This script loads and plays only the video of the current theme,
   and it switches when the theme changes. A reader who asks for reduced
   motion keeps the still image, which is the poster of each video. */
(() => {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let watching = false;

  function sync() {
    const scheme = document.body.getAttribute('data-md-color-scheme') || 'default';
    for (const v of document.querySelectorAll('.cd-hero video.cd-vid')) {
      if (v.dataset.scheme !== scheme || still.matches) {
        v.pause();
        continue;
      }
      if (!v.dataset.loaded) {  // preload="none": the first play fetches it
        for (const s of v.querySelectorAll('source[data-src]')) s.src = s.dataset.src;
        v.dataset.loaded = '1';
        v.load();
      }
      v.play().catch(() => { /* the poster stays */ });
    }
  }

  function start() {
    sync();
    if (watching) return;
    watching = true;
    new MutationObserver(sync).observe(document.body,
      { attributes: true, attributeFilter: ['data-md-color-scheme'] });
    still.addEventListener?.('change', sync);
  }

  if (window.document$) window.document$.subscribe(start);
  else document.addEventListener('DOMContentLoaded', start);
})();
