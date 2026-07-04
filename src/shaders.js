// shaders.js
// All GLSL for the pipeline, kept as strings so the extension needs no extra
// file fetches. Targets WebGL2 / GLSL ES 3.00.
//
// The pipeline (mirrors the AcerolaFX ASCII shader, restructured for WebGL):
//   1. BLUR X   : horizontal leg of two Gaussian blurs (sigma and 1.6*sigma),
//                 computed together on luminance
//   2. BLUR Y   : vertical leg completing both blurs, then the Difference-of-
//                 Gaussians (narrow - wide), thresholded to a binary line mask
//   3. EDGE     : Sobel on the DoG mask -> edge magnitude + quantized direction
//   4. AGGREGATE: collapse the image to one texel per character cell
//                 (average luminance + dominant edge direction for that cell)
//   5. COMPOSITE: for every output pixel, pick a glyph for its cell and stamp it

(function () {
  const NS = (window.__AsciiWeb = window.__AsciiWeb || {});

  // Shared vertex shader. We draw one big triangle covering the screen; v_uv
  // runs 0..1 across the visible area.
  const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  // ---- Passes 1+2: Difference-of-Gaussians -----------------------------------
  // Two Gaussian blurs (SIGMA1 and SIGMA2 = 1.6 * SIGMA1, the classic DoG
  // ratio) computed together, separably: pass 1 blurs horizontally and writes
  // (narrow, wide) into RG; pass 2 blurs that vertically, subtracts, and
  // thresholds. The result is a thin binary mask along contours, independent of
  // local contrast — this is what gives AcerolaFX its clean line art.
  //
  // Tuning: SIGMA1 sets line scale (bigger = only larger features outline);
  // DOG_THRESH sets sensitivity (lower = more lines).
  const BLURX_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 frag;
uniform sampler2D u_src;
uniform vec2 u_texel;          // 1.0 / resolution

const float SIGMA1 = 1.2;
const float SIGMA2 = 1.92;     // 1.6 * SIGMA1
const int   RADIUS = 6;        // ~3 * SIGMA2

float lum(vec2 uv) {
  vec3 c = texture(u_src, uv).rgb;
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 sum = vec2(0.0);
  vec2 wsum = vec2(0.0);
  for (int i = -RADIUS; i <= RADIUS; i++) {
    float x = float(i);
    vec2 w = exp(vec2(-x * x / (2.0 * SIGMA1 * SIGMA1),
                      -x * x / (2.0 * SIGMA2 * SIGMA2)));
    sum += w * lum(v_uv + vec2(u_texel.x * x, 0.0));
    wsum += w;
  }
  frag = vec4(sum / wsum, 0.0, 1.0);
}`;

  const BLURY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 frag;
uniform sampler2D u_src;       // RG = horizontally blurred (narrow, wide)
uniform vec2 u_texel;

const float SIGMA1 = 1.2;
const float SIGMA2 = 1.92;
const int   RADIUS = 6;
const float DOG_THRESH = 0.015; // DoG response needed to count as a line

void main() {
  vec2 sum = vec2(0.0);
  vec2 wsum = vec2(0.0);
  for (int i = -RADIUS; i <= RADIUS; i++) {
    float y = float(i);
    vec2 w = exp(vec2(-y * y / (2.0 * SIGMA1 * SIGMA1),
                      -y * y / (2.0 * SIGMA2 * SIGMA2)));
    sum += w * texture(u_src, v_uv + vec2(0.0, u_texel.y * y)).rg;
    wsum += w;
  }
  vec2 b = sum / wsum;

  // One-sided threshold (per AcerolaFX), not |d|: responds on the bright side
  // of a contour, which keeps lines single rather than doubled.
  float d = b.x - b.y;
  float mask = (d >= DOG_THRESH) ? 1.0 : 0.0;

  // G carries the raw (biased) DoG for eyeballing in a debugger; only R is
  // consumed downstream.
  frag = vec4(mask, d * 0.5 + 0.5, 0.0, 1.0);
}`;

  // ---- Pass 3: edge direction ------------------------------------------------
  // Reads the DoG line mask, returns (magnitude, direction) per pixel.
  // Direction is quantized to the 4 glyphs | - / \ and stored in the G channel.
  // (A binary mask has no gradient exactly on a 1px line's centre, but the
  //  strong responses immediately beside it land in the same cell, which is
  //  what the aggregate pass accumulates.)
  const EDGE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 frag;
uniform sampler2D u_dog;
uniform vec2 u_texel;          // 1.0 / resolution

float mask(vec2 uv) {
  return texture(u_dog, uv).r;
}

void main() {
  // 3x3 neighbourhood for a Sobel operator.
  float tl = mask(v_uv + u_texel * vec2(-1.0,  1.0));
  float t  = mask(v_uv + u_texel * vec2( 0.0,  1.0));
  float tr = mask(v_uv + u_texel * vec2( 1.0,  1.0));
  float l  = mask(v_uv + u_texel * vec2(-1.0,  0.0));
  float r  = mask(v_uv + u_texel * vec2( 1.0,  0.0));
  float bl = mask(v_uv + u_texel * vec2(-1.0, -1.0));
  float b  = mask(v_uv + u_texel * vec2( 0.0, -1.0));
  float br = mask(v_uv + u_texel * vec2( 1.0, -1.0));

  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);

  float mag = length(vec2(gx, gy));

  // Gradient angle, folded to [0,180) since a line has no head/tail.
  float ang = degrees(atan(gy, gx));
  if (ang < 0.0) ang += 180.0;

  // The drawn line is perpendicular to the gradient.
  // 0:'|'  1:'-'  2:'/'  3:'\\'
  float dir;
  if (ang < 22.5 || ang >= 157.5) dir = 0.0; // gradient horizontal -> vertical line
  else if (ang < 67.5)            dir = 3.0; // gradient ~45 deg     -> back diagonal
  else if (ang < 112.5)           dir = 1.0; // gradient vertical    -> horizontal line
  else                            dir = 2.0; // gradient ~135 deg    -> forward diagonal

  // NOTE: verified on real hardware (Chrome, 2026-07-04): with the renderer's
  // UNPACK_FLIP_Y upload convention this mapping renders / and \ correctly.
  // If a browser/driver ever disagrees, swap the dir values 2.0 and 3.0 above.
  frag = vec4(clamp(mag, 0.0, 1.0), dir / 3.0, 0.0, 1.0);
}`;

  // ---- Pass 4: aggregate to one texel per cell -------------------------------
  // Output resolution here is (cols x rows), i.e. the character grid.
  const AGG_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 frag;
uniform sampler2D u_src;       // full-res source (for luminance / colour)
uniform sampler2D u_edge;      // full-res edge texture from pass 1
uniform vec2 u_outTexel;       // 1.0 / full-res output size
uniform vec2 u_cellSize;       // pixels per character cell (width, height) —
                               // rectangular so text mode can match the ~1:2
                               // aspect of real monospace glyphs
uniform vec2 u_grid;           // cols, rows

const int MAX_CELL = 32;       // loop cap; keep cell dimensions <= this

void main() {
  vec2 cell = floor(v_uv * u_grid);
  vec2 originPx = cell * u_cellSize;
  int csx = int(u_cellSize.x);
  int csy = int(u_cellSize.y);

  float lumSum = 0.0;
  float cnt = 0.0;
  float dirMag[4];
  dirMag[0] = 0.0; dirMag[1] = 0.0; dirMag[2] = 0.0; dirMag[3] = 0.0;

  for (int y = 0; y < MAX_CELL; y++) {
    if (y >= csy) break;
    for (int x = 0; x < MAX_CELL; x++) {
      if (x >= csx) break;
      vec2 px = originPx + vec2(float(x), float(y)) + 0.5;
      vec2 uv = px * u_outTexel;

      vec3 c = texture(u_src, uv).rgb;
      lumSum += dot(c, vec3(0.299, 0.587, 0.114));
      cnt += 1.0;

      vec4 e = texture(u_edge, uv);
      int d = int(e.g * 3.0 + 0.5);
      dirMag[d] += e.r;
    }
  }

  float avgLum = (cnt > 0.0) ? lumSum / cnt : 0.0;

  // Dominant edge direction = the bucket with the most accumulated magnitude.
  float best = dirMag[0]; float bestDir = 0.0;
  if (dirMag[1] > best) { best = dirMag[1]; bestDir = 1.0; }
  if (dirMag[2] > best) { best = dirMag[2]; bestDir = 2.0; }
  if (dirMag[3] > best) { best = dirMag[3]; bestDir = 3.0; }

  float energy = (cnt > 0.0) ? best / cnt : 0.0; // 0..1, strength of that direction

  frag = vec4(avgLum, clamp(energy, 0.0, 1.0), bestDir / 3.0, 1.0);
}`;

  // ---- Utility: plain copy ----------------------------------------------------
  // Used by text-mode readback to downsample the source to one colour per cell
  // (the canvas path gets its per-cell colour the same way, by sampling the
  // source at the cell centre inside COMP_FRAG).
  const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 frag;
uniform sampler2D u_src;
void main() {
  frag = texture(u_src, v_uv);
}`;

  // ---- Pass 5: composite -----------------------------------------------------
  // Renders at full output resolution and stamps a glyph into each cell.
  const COMP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 frag;
uniform sampler2D u_cells;     // cols x rows aggregate texture
uniform sampler2D u_atlas;     // glyph strip
uniform sampler2D u_src;       // source, for per-cell colour in colour mode
uniform vec2 u_grid;           // cols, rows
uniform float u_glyphCount;
uniform float u_fillCount;
uniform float u_edgeBase;
uniform float u_edgeThreshold; // edge energy needed to draw a line instead of fill
uniform float u_color;         // 0 = monochrome, 1 = tint by cell colour
uniform vec3 u_bg;
uniform vec3 u_fg;
uniform float u_glyphPx;

void main() {
  vec2 cellCoord = v_uv * u_grid;
  vec2 cellId = floor(cellCoord);
  vec2 localUV = fract(cellCoord);          // position inside the cell, 0..1
  vec2 cellUV = (cellId + 0.5) / u_grid;

  vec4 cellData = texture(u_cells, cellUV);
  float lumv = cellData.r;
  float edge = cellData.g;
  float dir  = floor(cellData.b * 3.0 + 0.5);

  // Choose which glyph index to stamp.
  float glyph;
  if (edge > u_edgeThreshold) {
    glyph = u_edgeBase + dir;               // a line character
  } else {
    float idx = clamp(floor(lumv * u_fillCount), 0.0, u_fillCount - 1.0);
    glyph = idx;                            // a fill-ramp character
  }

  // Inset a touch so linear filtering doesn't bleed neighbouring glyphs.
  float inset = 0.5 / u_glyphPx;
  float gx = clamp(localUV.x, inset, 1.0 - inset);
  float gy = clamp(localUV.y, inset, 1.0 - inset);
  vec2 atlasUV = vec2((glyph + gx) / u_glyphCount, gy);

  float coverage = texture(u_atlas, atlasUV).r;
  vec3 fg = (u_color > 0.5) ? texture(u_src, cellUV).rgb : u_fg;

  frag = vec4(mix(u_bg, fg, coverage), 1.0);
}`;

  NS.SHADERS = {
    VERT: VERT,
    BLURX_FRAG: BLURX_FRAG,
    BLURY_FRAG: BLURY_FRAG,
    COPY_FRAG: COPY_FRAG,
    EDGE_FRAG: EDGE_FRAG,
    AGG_FRAG: AGG_FRAG,
    COMP_FRAG: COMP_FRAG
  };
})();
