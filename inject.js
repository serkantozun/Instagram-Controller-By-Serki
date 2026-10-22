// Sayfanın kendi dünyasında (MAIN world) çalışır.
// Instagram'a "sekme hep görünür" gösterir; böylece sekme/pencere değişince videoları durdurmaz.
// Varsayılan olarak açıktır; <html data-ivc-keepalive="0"> yazılırsa kapanır.
(() => {
  if (window.__ivcMain) return;
  window.__ivcMain = true;

  const on = () => {
    const h = document.documentElement;
    return !h || h.getAttribute("data-ivc-keepalive") !== "0";   // varsayılan: açık
  };

  const D = Document.prototype;
  const patch = (name, fake) => {
    const d = Object.getOwnPropertyDescriptor(D, name);
    if (!d || !d.get) return;
    Object.defineProperty(D, name, {
      configurable: true,
      enumerable: d.enumerable,
      get() { return on() ? fake : d.get.call(this); },
    });
  };
  patch("hidden", false);
  patch("visibilityState", "visible");
  patch("webkitHidden", false);
  patch("webkitVisibilityState", "visible");

  const origHasFocus = D.hasFocus;
  D.hasFocus = function () { return on() ? true : origHasFocus.call(this); };

  // window'da en başta, yakalama aşamasında dinle: sayfanın dinleyicilerinden önce çalışır
  const block = (e) => { if (on()) e.stopImmediatePropagation(); };
  window.addEventListener("visibilitychange", block, true);
  window.addEventListener("webkitvisibilitychange", block, true);
  window.addEventListener("blur", (e) => { if (e.target === window) block(e); }, true);

  // ---------- Sayfanın kendi indirdiği medya verisini yakala (hikaye / gönderi) ----------
  // Instagram'ın hangi servisi kullandığına bağlı kalmamak için: sayfa kendi yüklediği
  // JSON yanıtlarını (REST veya GraphQL) buradan da görürüz ve video/görsel adreslerini topluruz.
  const EV = "ivc:media";
  const buffer = [];
  let bufferChars = 0;

  const strId = (n) => String(n.pk || (n.id ? String(n.id).split("_")[0] : "") || "");
  function norm(n, depth, reel) {
    const o = { pk: strId(n), media_type: n.media_type, taken_at: n.taken_at,
                video_duration: n.video_duration, has_audio: n.has_audio };
    if (reel) o.reel = reel;                          // ör. "highlight:1791" veya kullanıcı id'si
    if (n.user && n.user.username) o.user = { username: n.user.username };
    else if (n.owner && n.owner.username) o.user = { username: n.owner.username };
    if (Array.isArray(n.video_versions)) o.video_versions = n.video_versions.map((v) => ({ url: v.url, width: v.width, height: v.height }));
    if (typeof n.video_dash_manifest === "string") o.video_dash_manifest = n.video_dash_manifest;
    const c = n.image_versions2 && n.image_versions2.candidates;
    if (Array.isArray(c)) o.image_versions2 = { candidates: c.map((v) => ({ url: v.url, width: v.width, height: v.height })) };
    if (Array.isArray(n.carousel_media) && depth < 1) o.carousel_media = n.carousel_media.map((x) => norm(x, depth + 1));
    return o;
  }
  function walk(node, out, seen, depth, reel) {
    if (!node || typeof node !== "object" || depth > 16 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const x of node) walk(x, out, seen, depth + 1, reel); return; }
    // "items" dizisi olan ve kimliği olan nesne bir hikaye akışıdır (öne çıkan ya da kullanıcının hikayeleri)
    let r = reel;
    if (Array.isArray(node.items) && (node.id != null || node.pk != null)) r = String(node.id != null ? node.id : node.pk);
    const hasMedia = Array.isArray(node.video_versions) || (node.image_versions2 && Array.isArray(node.image_versions2.candidates));
    if (hasMedia && (node.pk || node.id)) out.push(norm(node, 0, r));
    for (const k in node) { const v = node[k]; if (v && typeof v === "object") walk(v, out, seen, depth + 1, r); }
  }
  function parseJsonLoose(text) {
    text = text.replace(/^for \(;;\);/, "");
    try { return [JSON.parse(text)]; } catch (e) {}
    const res = [];                                   // satır satır JSON (GraphQL akışı)
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
      try { res.push(JSON.parse(t)); } catch (e) {}
    }
    return res;
  }
  function handle(url, body, text) {
    if (!text || text.length > 12e6) return;
    const docs = parseJsonLoose(text);
    const out = [];
    for (const d of docs) walk(d, out, new Set(), 0, undefined);
    const items = out.filter((x) => x.pk);
    if (!items.length) return;
    let ctx = url + " " + body;
    try { ctx = decodeURIComponent(ctx); } catch (e) {}
    const detail = JSON.stringify({ ctx: ctx.slice(0, 3000), items });
    buffer.push(detail); bufferChars += detail.length;
    while ((buffer.length > 60 || bufferChars > 12e6) && buffer.length > 1) bufferChars -= buffer.shift().length;
    document.dispatchEvent(new CustomEvent(EV, { detail }));
  }
  // İçerik betiği sonradan yüklenirse kaçırdıklarını yeniden iste
  document.addEventListener("ivc:replay", () => {
    for (const d of buffer) document.dispatchEvent(new CustomEvent(EV, { detail: d }));
  });

  const bodyStr = (b) => { try { if (typeof b === "string") return b; if (b instanceof URLSearchParams) return b.toString(); } catch (e) {} return ""; };
  const API_RE = /\/(api|graphql)\b/;

  const OF = window.fetch;
  window.fetch = function (input, init) {
    const p = OF.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || String(input || "");
      if (API_RE.test(url)) {
        const body = bodyStr(init && init.body);
        p.then((res) => {
          try {
            const ct = (res.headers && res.headers.get("content-type")) || "";
            if (!/json|javascript|text/.test(ct)) return;
            res.clone().text().then((t) => handle(url, body, t)).catch(() => {});
          } catch (e) {}
        }, () => {});
      }
    } catch (e) {}
    return p;
  };

  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__ivcUrl = String(u); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      const url = this.__ivcUrl || "";
      if (API_RE.test(url)) {
        const body = bodyStr(b);
        this.addEventListener("load", () => {
          try {
            let t = "";
            if (this.responseType === "" || this.responseType === "text") t = this.responseText;
            else if (this.responseType === "json" && this.response) t = JSON.stringify(this.response);
            handle(url, body, t);
          } catch (e) {}
        });
      }
    } catch (e) {}
    return XS.apply(this, arguments);
  };
})();
