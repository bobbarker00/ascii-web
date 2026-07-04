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
    edgeThreshold: 0.08,
    textMode: false
  };

  const MIN_SIZE = 64;       // ignore tiny icons/sprites
  let settings = Object.assign({}, DEFAULTS);
  let renderer = null;       // lazily created shared AsciiRenderer
  const overlays = new Map(); // element -> Overlay

  // ---- cross-origin image fallback ----
  // Non-CORS images taint the direct WebGL upload, so we ask the background
  // service worker (which has host_permissions) for the bytes and decode them
  // to an ImageBitmap ourselves. Cached by URL and bounded so image-heavy
  // pages (Google Images...) don't hoard hundreds of decoded bitmaps.
  const bitmapCache = new Map(); // url -> Promise<ImageBitmap|null>
  const BITMAP_CACHE_MAX = 64;

  // Get raw image bytes: try a direct fetch first (works for same-origin and
  // CORS-enabled hosts, straight from HTTP cache), fall back to the background
  // worker for everything else. Resolves to a Blob or null.
  function fetchBytes(url) {
    return fetch(url, { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .catch(
        () =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'ascii-fetch-image', url: url }, (resp) => {
              if (chrome.runtime.lastError || !resp || !resp.ok) return resolve(null);
              fetch(resp.dataUrl).then((r) => r.blob()).then(resolve, () => resolve(null));
            });
          })
      );
  }

  function fetchBitmap(url) {
    if (bitmapCache.has(url)) return bitmapCache.get(url);
    const p = fetchBytes(url).then((blob) => {
      if (!blob) return null;
      // flipY here: WebGL ignores UNPACK_FLIP_Y for ImageBitmap sources,
      // so the flip is baked in to match the renderer's upload convention.
      return createImageBitmap(blob, { imageOrientation: 'flipY' }).catch(() => null);
    });
    if (bitmapCache.size >= BITMAP_CACHE_MAX) {
      const oldest = bitmapCache.keys().next().value;
      bitmapCache.get(oldest).then((b) => { if (b) b.close(); });
      bitmapCache.delete(oldest);
    }
    bitmapCache.set(url, p);
    return p;
  }

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
    this.animating = false; // true once an ImageDecoder loop owns this overlay
    this.decoder = null;
    this.textMode = !!settings.textMode;
    this.renderW = 1; // backing pixel size to render at
    this.renderH = 1;
    this.lastCols = 0;
    this.lastRows = 0;

    let node;
    if (this.textMode) {
      // Real, selectable characters. Note: unlike the canvas, the <pre> takes
      // pointer events so the text can be selected — it covers the element.
      node = document.createElement('pre');
      node.style.margin = '0';
      node.style.overflow = 'hidden';
      node.style.background = '#0a0a0a';
      node.style.color = '#d9f2d9';
      node.style.fontFamily = 'monospace';
      node.style.letterSpacing = '0';
      node.style.userSelect = 'text';
      this.pre = node;
    } else {
      node = document.createElement('canvas');
      node.style.pointerEvents = 'none';
      node.style.imageRendering = 'pixelated';
      this.canvas = node;
      this.ctx = node.getContext('2d');
    }
    node.style.position = 'absolute';
    node.style.zIndex = '2147483646';
    document.body.appendChild(node);
    this.node = node;

    this.position();
    if (this.isVideo) this.loop();
    else this.renderImage();
  }

  Overlay.prototype.position = function () {
    const r = this.el.getBoundingClientRect();
    const n = this.node;
    n.style.left = (r.left + window.scrollX) + 'px';
    n.style.top = (r.top + window.scrollY) + 'px';
    n.style.width = r.width + 'px';
    n.style.height = r.height + 'px';

    // Backing resolution at device pixel ratio for crisp glyphs.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    const key = w + 'x' + h;
    if (key !== this.lastSize) {
      this.lastSize = key;
      this.renderW = w;
      this.renderH = h;
      if (this.canvas) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (!this.isVideo) this.renderImage();
    }
    // Hide overlay if the element is off-screen or zero-sized.
    n.style.display = (r.width < 1 || r.height < 1) ? 'none' : 'block';
  };

  // Render any source (element or ImageBitmap) into this overlay, honouring
  // its mode: composite to the canvas, or read cells back and fill the <pre>.
  Overlay.prototype.renderSource = function (src) {
    const r = getRenderer();
    if (!r) return false;
    if (!this.textMode) {
      return r.render(src, this.renderW, this.renderH, this.ctx, settings);
    }
    // ~1:2 cells to match monospace glyph shape.
    const grid = r.readCells(src, this.renderW, this.renderH,
      Object.assign({}, settings, { cellAspect: 2 }));
    if (!grid) return false;
    this.pre.textContent = grid.text;
    if (grid.cols !== this.lastCols || grid.rows !== this.lastRows) {
      // Fit the character grid to the element's CSS box.
      const rect = this.el.getBoundingClientRect();
      const cellW = rect.width / grid.cols;
      // Monospace advance is ~0.6em, so this makes a char ~cellW wide.
      this.pre.style.fontSize = (cellW / 0.6) + 'px';
      this.pre.style.lineHeight = (rect.height / grid.rows) + 'px';
      this.lastCols = grid.cols;
      this.lastRows = grid.rows;
    }
    return true;
  };

  Overlay.prototype.renderImage = function () {
    const r = getRenderer();
    if (!r) return;
    if (this.animating) return; // the animation loop owns the canvas
    if (!this.el.complete || this.el.naturalWidth === 0) {
      this.el.addEventListener('load', () => this.renderImage(), { once: true });
      return;
    }
    const ok = this.renderSource(this.el);
    if (!ok) this.renderFetched();
    this.maybeAnimate();
  };

  // Fallback when the direct upload tainted: render from a background-fetched
  // ImageBitmap instead of the element itself.
  Overlay.prototype.renderFetched = function () {
    const url = this.el.currentSrc || this.el.src;
    if (!url || !/^https?:/i.test(url)) return;
    fetchBitmap(url).then((bmp) => {
      if (!bmp || !overlays.has(this.el)) return;          // torn down mid-fetch
      if ((this.el.currentSrc || this.el.src) !== url) return; // src swapped mid-fetch
      this.renderSource(bmp);
    });
  };

  // Animated images (GIF/APNG/animated WebP). Uploading an animated <img> to
  // WebGL always yields the *first frame* (that's per spec, not a bug), so to
  // animate we must decode the file ourselves: fetch the bytes, run them
  // through WebCodecs' ImageDecoder, and drive frames like a video.
  const ANIMATED_EXT = /\.(gif|apng|webp)$/i;

  Overlay.prototype.maybeAnimate = function () {
    if (this.animating || typeof ImageDecoder === 'undefined') return;
    const url = this.el.currentSrc || this.el.src;
    if (!url || !/^https?:/i.test(url)) return;
    let path;
    try { path = new URL(url).pathname; } catch (e) { return; }
    if (!ANIMATED_EXT.test(path)) return;

    this.animating = true; // reserve now; released if the file turns out static
    fetchBytes(url)
      .then((blob) => {
        if (!blob || !overlays.has(this.el)) throw new Error('gone');
        if ((this.el.currentSrc || this.el.src) !== url) throw new Error('src changed');
        return blob.arrayBuffer().then((buf) => {
          const decoder = new ImageDecoder({ data: buf, type: blob.type || 'image/gif' });
          return decoder.tracks.ready.then(() => {
            const track = decoder.tracks.selectedTrack;
            if (!track || track.frameCount <= 1) {
              decoder.close();
              throw new Error('static');
            }
            this.decoder = decoder;
            this.animate(decoder, track);
          });
        });
      })
      .catch(() => { this.animating = false; });
  };

  Overlay.prototype.animate = function (decoder, track) {
    let index = 0;
    let nextAt = 0;
    let busy = false;
    const step = () => {
      if (!overlays.has(this.el)) return; // torn down; destroy() closes the decoder
      this.raf = requestAnimationFrame(step);
      const now = performance.now();
      if (busy || now < nextAt) return;
      busy = true;
      decoder
        .decode({ frameIndex: index })
        .then((res) => {
          const frame = res.image;
          let ms = (frame.duration || 0) / 1000; // duration is in microseconds
          if (ms < 20) ms = 100; // GIF convention: near-zero delay means ~10fps
          nextAt = now + ms;
          index = (index + 1) % track.frameCount;
          // Through ImageBitmap for the same reason as fetchBitmap: bakes in
          // the vertical flip that UNPACK_FLIP_Y won't apply to this source.
          return createImageBitmap(frame, { imageOrientation: 'flipY' }).then((bmp) => {
            frame.close();
            this.renderSource(bmp);
            bmp.close();
          });
        })
        .then(() => { busy = false; }, () => { busy = false; });
    };
    this.raf = requestAnimationFrame(step);
  };

  Overlay.prototype.loop = function () {
    const r = getRenderer();
    if (!r) return;
    const step = () => {
      this.position();
      if (this.el.readyState >= 2 && !this.el.paused && this.el.videoWidth > 0) {
        this.renderSource(this.el);
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
    if (this.decoder) {
      try { this.decoder.close(); } catch (e) { /* already closed */ }
      this.decoder = null;
    }
    this.node.remove();
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
      if ('textMode' in changes) {
        teardown(); // overlay node type changes; rebuild from scratch
        scan();
      } else {
        overlays.forEach((o) => o.refresh()); // re-render images with new params
      }
    }
  });
})();
