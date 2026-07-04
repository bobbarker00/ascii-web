// popup.js
// Reads/writes settings to chrome.storage.local. The content script listens for
// changes and updates live, so there's no messaging to wire up here.

const DEFAULTS = { enabled: false, cellSize: 8, color: false, edgeThreshold: 0.08, textMode: false };

const els = {
  enabled: document.getElementById('enabled'),
  cellSize: document.getElementById('cellSize'),
  cellSizeVal: document.getElementById('cellSizeVal'),
  edgeThreshold: document.getElementById('edgeThreshold'),
  edgeThresholdVal: document.getElementById('edgeThresholdVal'),
  color: document.getElementById('color'),
  textMode: document.getElementById('textMode')
};

function paint(s) {
  els.enabled.checked = s.enabled;
  els.cellSize.value = s.cellSize;
  els.cellSizeVal.textContent = s.cellSize;
  els.edgeThreshold.value = s.edgeThreshold;
  els.edgeThresholdVal.textContent = (+s.edgeThreshold).toFixed(2);
  els.color.checked = s.color;
  els.textMode.checked = s.textMode;
}

chrome.storage.local.get(DEFAULTS, paint);

function save(patch) {
  chrome.storage.local.set(patch);
}

els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
els.color.addEventListener('change', () => save({ color: els.color.checked }));
els.textMode.addEventListener('change', () => save({ textMode: els.textMode.checked }));
els.cellSize.addEventListener('input', () => {
  els.cellSizeVal.textContent = els.cellSize.value;
  save({ cellSize: +els.cellSize.value });
});
els.edgeThreshold.addEventListener('input', () => {
  els.edgeThresholdVal.textContent = (+els.edgeThreshold.value).toFixed(2);
  save({ edgeThreshold: +els.edgeThreshold.value });
});
