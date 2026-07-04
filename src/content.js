// content.js
// The orchestrator that runs on every page. Responsibilities:
//   - read settings from chrome.storage and react to changes
//   - find <img> / <video> worth converting
//   - put a positioned canvas overlay on top of each one
//   - keep that overlay aligned on scroll/resize
//   - drive a per-video animation loop; render images once
//   - watch the DOM for new media

(function () {
  const NS = window.__AsciiWeb;

  const DEFAULTS = {
    enabled: false,
    cellSize: 8,
    color: false,
    edgeThreshold: 0.08
  };

  const MIN_SIZE = 64;       // ignore tiny icons/sprites
  let settings = Object.assign({}, DEFAULTS);
  let renderer = null;       // lazily created shared AsciiRenderer
  const overlays = new Map(); // element -> Overlay

  function getRenderer() {
    if (!renderer) {
      try {
        renderer = new NS.AsciiRenderer();
      } catch (e) {
        console.warn('[ASCII Web] renderer unavailable:', e.message);
        renderer = false; // sentinel: tried and failed
      }
    }
    return renderer || null;
  }

  // ---- one overlay per converted element ----
  function Overlay(el) {
    this.el = el;
    this.isVideo = el.tagName === 'VIDEO';
    this.raf = 0;
    this.lastSize = '';

    const c = document.createElement('canvas');
    c.style.position = 'absolute';
    c.style.pointerEvents = 'none';
    c.style.zIndex = '2147483646';
    c.style.imageRendering = 'pixelated';
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');

    this.position();
    if (this.isVideo) this.loop();
    else this.renderImage();
  }

  Overlay.prototype.position = function () {
    const r = this.el.getBoundingClientRect();
    const c = this.canvas;
    c.style.left = (r.left + window.scrollX) + 'px';
    c.style.top = (r.top + window.scrollY) + 'px';
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';

    // Backing resolution at device pixel ratio for crisp glyphs.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    const key = w + 'x' + h;
    if (key !== this.lastSize) {
      c.width = w;
      c.height = h;
      this.lastSize = key;
      if (!this.isVideo) this.renderImage();
    }
    // Hide overlay if the element is off-screen or zero-sized.
    c.style.display = (r.width < 1 || r.height < 1) ? 'none' : 'block';
  };

  Overlay.prototype.renderImage = function () {
    const r = getRenderer();
    if (!r) return;
    if (!this.el.complete || this.el.naturalWidth === 0) {
      this.el.addEventListener('load', () => this.renderImage(), { once: true });
      return;
    }
    r.render(this.el, this.canvas.width, this.canvas.height, this.ctx, settings);
  };

  Overlay.prototype.loop = function () {
    const r = getRenderer();
    if (!r) return;
    const step = () => {
      this.position();
      if (this.el.readyState >= 2 && !this.el.paused && this.el.videoWidth > 0) {
        r.render(this.el, this.canvas.width, this.canvas.height, this.ctx, settings);
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  Overlay.prototype.refresh = function () {
    // Called when settings change. Videos pick it up on their next frame.
    if (!this.isVideo) this.renderImage();
  };

  Overlay.prototype.destroy = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.remove();
  };

  // ---- scanning ----
  function eligible(el) {
    if (overlays.has(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  function scan() {
    if (!settings.enabled) return;
    document.querySelectorAll('img, video').forEach((el) => {
      if (eligible(el)) overlays.set(el, new Overlay(el));
    });
  }

  function teardown() {
    overlays.forEach((o) => o.destroy());
    overlays.clear();
  }

  // ---- alignment + DOM watching ----
  let repositionPending = false;
  function repositionAll() {
    if (repositionPending) return;
    repositionPending = true;
    requestAnimationFrame(() => {
      repositionPending = false;
      overlays.forEach((o) => o.position());
    });
  }
  window.addEventListener('scroll', repositionAll, { passive: true });
  window.addEventListener('resize', repositionAll, { passive: true });

  let scanTimer = 0;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  });

  // ---- settings wiring ----
  function applyEnabled() {
    if (settings.enabled) {
      scan();
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      observer.disconnect();
      teardown();
    }
  }

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = Object.assign({}, DEFAULTS, stored);
    applyEnabled();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const wasEnabled = settings.enabled;
    for (const k in changes) settings[k] = changes[k].newValue;
    if (settings.enabled !== wasEnabled) {
      applyEnabled();
    } else if (settings.enabled) {
      overlays.forEach((o) => o.refresh()); // re-render images with new params
    }
  });
})();
