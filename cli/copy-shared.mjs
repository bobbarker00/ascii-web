// prepack hook: bundle the shared pipeline files into the package. In the
// repo the CLI reads ../src directly; an installed package has no parent
// repo, so it reads ./shared instead (see SRC_DIR in ascii-browse.mjs).
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, 'shared');
mkdirSync(dest, { recursive: true });
for (const f of ['glyph-atlas.js', 'shaders.js', 'ascii-renderer.js']) {
  copyFileSync(join(here, '..', 'src', f), join(dest, f));
  console.log('bundled shared/' + f);
}
