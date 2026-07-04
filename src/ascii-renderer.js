// ascii-renderer.js
// A single WebGL2 renderer shared by every overlay on the page. It owns one
// offscreen canvas + context, compiles the five programs once, and exposes
// render(): take a source <img>/<video>, run the passes, leave the result on
// its internal canvas for the caller to blit out.
//
// Why one shared renderer? Browsers cap simultaneous WebGL contexts (~16). One
// page can easily have more than 16 images, so we render them one at a time
// through a single context and copy each result onto a cheap 2D canvas overlay.

(function () {
  const NS = (window.__AsciiWeb = window.__AsciiWeb || {});
  const S = NS.SHADERS;

  const GLYPH_PX = 16; // resolution each glyph is drawn at in the atlas

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function program(gl, vertSrc, fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function makeTex(gl, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return t;
  }

  function makeFBO(gl, w, h, filter, halfFloat) {
    const tex = makeTex(gl, filter);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (halfFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo: fbo, tex: tex, w: w, h: h };
  }

  function AsciiRenderer() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true // needed so drawImage() can read the result
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    // Programs.
    this.pBlurX = program(gl, S.VERT, S.BLURX_FRAG);
    this.pBlurY = program(gl, S.VERT, S.BLURY_FRAG);
    this.pEdge = program(gl, S.VERT, S.EDGE_FRAG);
    this.pAgg = program(gl, S.VERT, S.AGG_FRAG);
    this.pComp = program(gl, S.VERT, S.COMP_FRAG);

    // Half-float render targets keep the blur intermediates precise enough for
    // a clean DoG subtraction; fall back to 8-bit (slightly noisier lines) if
    // the extension is missing.
    this.halfFloat = !!(gl.getExtension('EXT_color_buffer_float') ||
                        gl.getExtension('EXT_color_buffer_half_float'));

    // Fullscreen triangle.
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    // Source texture (re-uploaded every frame for video).
    this.srcTex = makeTex(gl, gl.LINEAR);

    // Glyph atlas (built once).
    const atlas = NS.createAtlas(GLYPH_PX);
    this.atlas = atlas;
    this.atlasTex = makeTex(gl, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.blurFBO = null; // (outW x outH) horizontally-blurred (narrow, wide)
    this.dogFBO = null;  // (outW x outH) binary DoG line mask
    this.edgeFBO = null; // (outW x outH)
    this.cellsFBO = null; // (cols x rows)
  }

  AsciiRenderer.prototype._drawQuad = function () {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // sourceEl: an <img> or <video>. outW/outH: backing pixel size to render at.
  // destCtx: a 2D context we blit the finished frame into.
  AsciiRenderer.prototype.render = function (sourceEl, outW, outH, destCtx, opts) {
    const gl = this.gl;
    outW = Math.max(1, Math.floor(outW));
    outH = Math.max(1, Math.floor(outH));

    const cellSize = Math.max(2, Math.min(24, opts.cellSize | 0));
    const cols = Math.max(1, Math.floor(outW / cellSize));
    const rows = Math.max(1, Math.floor(outH / cellSize));

    // (Re)allocate buffers if the size changed.
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW;
      this.canvas.height = outH;
    }
    if (!this.edgeFBO || this.edgeFBO.w !== outW || this.edgeFBO.h !== outH) {
      this.blurFBO = makeFBO(gl, outW, outH, gl.LINEAR, this.halfFloat);
      this.dogFBO = makeFBO(gl, outW, outH, gl.LINEAR);
      this.edgeFBO = makeFBO(gl, outW, outH, gl.LINEAR);
    }
    if (!this.cellsFBO || this.cellsFBO.w !== cols || this.cellsFBO.h !== rows) {
      this.cellsFBO = makeFBO(gl, cols, rows, gl.NEAREST);
    }

    // Upload the source frame.
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceEl);
    } catch (e) {
      // Cross-origin media without CORS taints uploads on some browsers. Skip.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (!sourceEl.__asciiWebSkipLogged) {
        sourceEl.__asciiWebSkipLogged = true;
        console.debug('[ASCII Web] skipped, upload threw ' + e.name + ':',
          sourceEl.currentSrc || sourceEl.src || sourceEl);
      }
      return false;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // ---- Pass 1: horizontal blur (both sigmas) -> blurFBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFBO.fbo);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.pBlurX);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(gl.getUniformLocation(this.pBlurX, 'u_src'), 0);
    gl.uniform2f(gl.getUniformLocation(this.pBlurX, 'u_texel'), 1 / outW, 1 / outH);
    this._drawQuad();

    // ---- Pass 2: vertical blur + DoG threshold -> dogFBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dogFBO.fbo);
    gl.useProgram(this.pBlurY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.blurFBO.tex);
    gl.uniform1i(gl.getUniformLocation(this.pBlurY, 'u_src'), 0);
    gl.uniform2f(gl.getUniformLocation(this.pBlurY, 'u_texel'), 1 / outW, 1 / outH);
    this._drawQuad();

    // ---- Pass 3: Sobel on the DoG mask -> edgeFBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edgeFBO.fbo);
    gl.useProgram(this.pEdge);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dogFBO.tex);
    gl.uniform1i(gl.getUniformLocation(this.pEdge, 'u_dog'), 0);
    gl.uniform2f(gl.getUniformLocation(this.pEdge, 'u_texel'), 1 / outW, 1 / outH);
    this._drawQuad();

    // ---- Pass 4: aggregate -> cellsFBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellsFBO.fbo);
    gl.viewport(0, 0, cols, rows);
    gl.useProgram(this.pAgg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(gl.getUniformLocation(this.pAgg, 'u_src'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.edgeFBO.tex);
    gl.uniform1i(gl.getUniformLocation(this.pAgg, 'u_edge'), 1);
    gl.uniform2f(gl.getUniformLocation(this.pAgg, 'u_outTexel'), 1 / outW, 1 / outH);
    gl.uniform1f(gl.getUniformLocation(this.pAgg, 'u_cellSize'), cellSize);
    gl.uniform2f(gl.getUniformLocation(this.pAgg, 'u_grid'), cols, rows);
    this._drawQuad();

    // ---- Pass 5: composite -> visible canvas ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.pComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellsFBO.tex);
    gl.uniform1i(gl.getUniformLocation(this.pComp, 'u_cells'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(gl.getUniformLocation(this.pComp, 'u_atlas'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(gl.getUniformLocation(this.pComp, 'u_src'), 2);
    gl.uniform2f(gl.getUniformLocation(this.pComp, 'u_grid'), cols, rows);
    gl.uniform1f(gl.getUniformLocation(this.pComp, 'u_glyphCount'), this.atlas.glyphCount);
    gl.uniform1f(gl.getUniformLocation(this.pComp, 'u_fillCount'), this.atlas.fillCount);
    gl.uniform1f(gl.getUniformLocation(this.pComp, 'u_edgeBase'), this.atlas.edgeBase);
    gl.uniform1f(gl.getUniformLocation(this.pComp, 'u_edgeThreshold'), opts.edgeThreshold);
    gl.uniform1f(gl.getUniformLocation(this.pComp, 'u_color'), opts.color ? 1 : 0);
    gl.uniform3f(gl.getUniformLocation(this.pComp, 'u_bg'), 0.04, 0.04, 0.04);
    gl.uniform3f(gl.getUniformLocation(this.pComp, 'u_fg'), 0.85, 0.95, 0.85);
    gl.uniform1f(gl.getUniformLocation(this.pComp, 'u_glyphPx'), this.atlas.glyphPx);
    this._drawQuad();

    // Blit onto the overlay's 2D canvas.
    destCtx.clearRect(0, 0, outW, outH);
    destCtx.drawImage(this.canvas, 0, 0);
    return true;
  };

  NS.AsciiRenderer = AsciiRenderer;
})();
