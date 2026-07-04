// glyph-atlas.js
// Builds the ASCII glyph atlas: a horizontal strip of characters drawn white-on-black.
// The shader samples this strip to "stamp" the right character into each cell.
//
// Layout of the strip (left to right):
//   [ fill ramp glyphs (dark -> dense) ][ edge glyphs: | - / \ ]
// The composite shader needs three numbers to navigate it:
//   glyphCount : total glyphs in the strip
//   fillCount  : how many of those are the fill ramp (indices 0..fillCount-1)
//   edgeBase   : index where the 4 edge glyphs start (== fillCount)

(function () {
  const NS = (window.__AsciiWeb = window.__AsciiWeb || {});

  // The fill ramp is ordered from least ink (space) to most ink (@).
  // Cell luminance is mapped onto this ramp: dark cell -> space, bright cell -> @.
  // (If you want the classic "dark background" look this is correct; invert the
  //  ramp if you'd rather bright areas be sparse.)
  const FILL_RAMP = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];

  // Edge glyphs, in the order the edge shader assigns direction indices:
  //   0 = '|'  (vertical line)
  //   1 = '-'  (horizontal line)
  //   2 = '/'  (forward diagonal)
  //   3 = '\\' (back diagonal)
  const EDGE_GLYPHS = ['|', '-', '/', '\\'];

  function createAtlas(glyphPx) {
    const glyphs = FILL_RAMP.concat(EDGE_GLYPHS);

    const canvas = document.createElement('canvas');
    canvas.width = glyphs.length * glyphPx;
    canvas.height = glyphPx;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + (glyphPx - 2) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    glyphs.forEach(function (g, i) {
      // +1 nudges the baseline so descenders/centering look right at small sizes.
      ctx.fillText(g, i * glyphPx + glyphPx / 2, glyphPx / 2 + 1);
    });

    return {
      canvas: canvas,
      chars: glyphs, // the actual characters, indexed like the strip
      glyphCount: glyphs.length,
      fillCount: FILL_RAMP.length,
      edgeBase: FILL_RAMP.length,
      glyphPx: glyphPx
    };
  }

  NS.createAtlas = createAtlas;
})();
