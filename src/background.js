// background.js
// MV3 service worker with exactly one job: fetch cross-origin image bytes on
// behalf of content scripts. Content scripts share the page's CORS rules, so
// non-CORS images taint their WebGL uploads; extension-privileged fetches
// (backed by host_permissions in the manifest) are not subject to that.
//
// The result goes back as a data URL because chrome.runtime messaging is
// JSON-serialized — blobs/ArrayBuffers wouldn't survive the trip.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'ascii-fetch-image') return;

  fetch(msg.url, { credentials: 'omit' })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    })
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        })
    )
    .then(
      (dataUrl) => sendResponse({ ok: true, dataUrl: dataUrl }),
      (e) => sendResponse({ ok: false, error: String(e) })
    );

  return true; // keep the message channel open for the async sendResponse
});
