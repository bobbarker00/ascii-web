#!/usr/bin/env bash
# Builds distributable artifacts into dist/:
#   ascii-web-chrome-<v>.zip   -> chrome://extensions (drag in) or the Web Store
#   ascii-web-firefox-<v>.zip  -> about:debugging (temporary) or AMO signing
#   ascii-browse-<v>.tgz       -> npm install -g dist/ascii-browse-<v>.tgz
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p dist

python3 <<'EOF'
import json, os, zipfile

version = json.load(open('manifest.json'))['version']
files = ['manifest.json', 'popup.html', 'popup.js']
files += sorted('src/' + f for f in os.listdir('src'))
files += sorted('icons/' + f for f in os.listdir('icons'))

chrome = f'dist/ascii-web-chrome-{version}.zip'
with zipfile.ZipFile(chrome, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f)
print('wrote', chrome)

firefox = f'dist/ascii-web-firefox-{version}.zip'
with zipfile.ZipFile(firefox, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        if f == 'manifest.json':
            z.write('manifest.firefox.json', 'manifest.json')
        else:
            z.write(f)
print('wrote', firefox)
EOF

(cd cli && npm pack --pack-destination ../dist >/dev/null)
echo "wrote dist/ascii-browse-$(python3 -c "import json;print(json.load(open('cli/package.json'))['version'])").tgz"

ls -la dist/
