chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "download") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: false },
      () => {
        const err = chrome.runtime.lastError;
        sendResponse({ ok: !err, error: err && err.message });
      }
    );
    return true; // async cevap
  }
});
