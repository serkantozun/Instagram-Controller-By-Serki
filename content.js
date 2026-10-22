(() => {
  if (window.__ivcLoaded) return;
  window.__ivcLoaded = true;
  console.log("[IVC] Instagram Video Controller yüklendi");

  const SEEK_STEP = 5;
  const SPEED_STEP = 0.25, SPEED_MIN = 0.25, SPEED_MAX = 4;

  const state = {
    speed: 1, volume: 1, muted: false, collapsed: false, pos: null, auto: false, scale: 1,
    eq: { bass: 0, mid: 0, treble: 0 },
  };
  const volumeApplied = new WeakSet();

  const PRESETS = [
    { name: "Düz",   eq: { bass: 0,  mid: 0, treble: 0 } },
    { name: "Bass+", eq: { bass: 12, mid: 0, treble: 1 } },
    { name: "Vokal", eq: { bass: -3, mid: 5, treble: 2 } },
    { name: "Tiz+",  eq: { bass: -2, mid: 0, treble: 8 } },
  ];

  const save = () => { try { chrome.storage.local.set({ ivc: state }); } catch (e) {} };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const round2 = (x) => Math.round(x * 100) / 100;
  const fmt = (s) => {
    if (!isFinite(s)) return "0:00";
    s = Math.floor(s);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  const fmtSize = (bytes) => (bytes / 1048576 >= 10 ? Math.round(bytes / 1048576) : (bytes / 1048576).toFixed(1)) + " MB";

  function getActiveVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > bestArea) { bestArea = w * h; best = v; }
    }
    return best;
  }

  // ---------- Ses durumu koruması (duraklat/oynat sonrası ses kapanmasın) ----------
  // Kullanıcının istediği ses durumu. Instagram oynat/duraklat sırasında kendi
  // "sessiz" durumunu videoya geri uygularsa, burada tutulan değere geri çevrilir.
  const desired = { muted: null, volume: null };
  let guardUntil = 0;
  const openGuard = (ms) => { guardUntil = Math.max(guardUntil, Date.now() + ms); };
  const setDesired = (muted, volume) => { desired.muted = muted; desired.volume = volume; guardUntil = 0; };

  function enforceDesired(v) {
    if (!v || desired.muted === null) return;
    if (v.muted !== desired.muted || Math.abs(v.volume - desired.volume) > 0.001) {
      v.muted = desired.muted;
      v.volume = desired.volume;
    }
  }

  document.addEventListener("volumechange", (e) => {
    const v = e.target;
    if (!v || v.tagName !== "VIDEO") return;
    if (Date.now() < guardUntil && desired.muted !== null) { enforceDesired(v); return; }
    if (v === getActiveVideo()) {      // kullanıcı Instagram'ın kendi ses butonunu kullandı
      desired.muted = v.muted;
      desired.volume = v.volume;
      state.muted = v.muted;
      if (!v.muted && v.volume > 0) state.volume = v.volume;
      save();
    }
  }, true);

  ["play", "pause"].forEach((ev) =>
    document.addEventListener(ev, () => {
      openGuard(1200);
      if (audio && audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
    }, true));

  // koruma penceresinde sık sık kontrol et
  setInterval(() => {
    if (Date.now() < guardUntil) enforceDesired(getActiveVideo());
  }, 60);

  // ---------- Temel kontroller ----------
  let userSeekUntil = 0;
  function seek(delta) {
    const v = getActiveVideo(); if (!v) return;
    userSeekUntil = Date.now() + 1200;
    const dur = isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = clamp(v.currentTime + delta, 0, dur);
  }
  function setSpeed(s) {
    state.speed = round2(clamp(s, SPEED_MIN, SPEED_MAX));
    const v = getActiveVideo(); if (v) v.playbackRate = state.speed;
    save(); syncUI();
  }
  function currentPercent() {
    const v = getActiveVideo();
    if (v) return Math.round((v.muted ? 0 : v.volume) * 100);
    return Math.round((state.muted ? 0 : state.volume) * 100);
  }
  function setVolume(vol) {                  // vol: 0..1
    state.volume = round2(clamp(vol, 0, 1));
    state.muted = state.volume === 0;
    setDesired(state.muted, state.volume);
    const v = getActiveVideo();
    if (v) { v.volume = state.volume; v.muted = state.muted; }
    save(); syncUI();
  }
  const stepVolume = (deltaPercent) => setVolume((currentPercent() + deltaPercent) / 100);
  function toggleMute() {
    state.muted = !state.muted;
    if (!state.muted && state.volume === 0) state.volume = 0.5;
    setDesired(state.muted, state.volume);
    const v = getActiveVideo();
    if (v) { v.muted = state.muted; v.volume = state.volume; }
    save(); syncUI();
  }
  function toggleAuto() {
    state.auto = !state.auto;
    autoLast = { v: null, t: 0 };
    save(); syncUI();
  }
  function togglePlay() {
    const v = getActiveVideo(); if (!v) return;
    if (desired.muted === null) setDesired(v.muted, v.volume);
    openGuard(2000);
    if (v.paused) v.play().catch(() => {}); else v.pause();
    setTimeout(updatePlayBtn, 50);
  }

  // ---------- Önceki / sonraki video (reels) ----------
  // Arka plan sekmesinde sayfa çizilmediği için Instagram kaydırmayı fark edemez;
  // o durumda eski videoyu durdurup yenisini kendimiz oynatırız.
  function handoff(prev, next) {
    let tries = 0;
    const run = () => {
      const nv = next || getActiveVideo();
      if (!nv || nv === prev) { if (++tries < 4) setTimeout(run, 300); return; }
      try { prev.pause(); } catch (e) {}
      enforceDesired(nv);
      nv.playbackRate = state.speed;
      nv.play().catch(() => {});
      if (document.pictureInPictureElement) pipSwitch(nv);          // resim içinde resim açıksa pencere yeni videoya geçsin
    };
    setTimeout(run, 40);
  }

  function gotoVideo(dir) {                  // -1: yukarı (önceki), +1: aşağı (sonraki)
    const v = getActiveVideo(); if (!v) return;
    const hidden = document.hidden;
    const behavior = hidden ? "auto" : "smooth";   // arka planda animasyon çalışmaz: anında kaydır
    const vr = v.getBoundingClientRect();
    const vc = vr.top + vr.height / 2;
    let target = null, best = Infinity;
    for (const x of document.querySelectorAll("video")) {
      if (x === v) continue;
      const r = x.getBoundingClientRect();
      if (r.height < 50) continue;
      const d = (r.top + r.height / 2 - vc) * dir;
      if (d > 10 && d < best) { best = d; target = x; }
    }
    if (target) {
      target.scrollIntoView({ block: "center", behavior });
      if (hidden) handoff(v, target);
      return;
    }
    let node = v.parentElement;
    while (node && node !== document.body) {
      const oy = getComputedStyle(node).overflowY;
      if (/(auto|scroll)/.test(oy) && node.scrollHeight > node.clientHeight + 5) {
        node.scrollBy({ top: dir * node.clientHeight, behavior });
        if (hidden) handoff(v, null);
        return;
      }
      node = node.parentElement;
    }
    window.scrollBy({ top: dir * innerHeight, behavior });
    if (hidden) handoff(v, null);
  }

  // ---------- Otomatik kaydırma (video bitince sonrakine geç; arka planda da çalışır) ----------
  let autoCool = 0;
  let autoLast = { v: null, t: 0 };
  let userPaused = false;                    // videoyu kullanıcı mı durdurdu?

  function autoAdvance() {
    const now = Date.now();
    if (now < autoCool) return;
    autoCool = now + 1500;
    gotoVideo(1);
    if (document.pictureInPictureElement && !document.hidden) {     // görünürken yumuşak kaydırma bittikten sonra PiP'i taşı
      setTimeout(() => { const nv = getActiveVideo(); if (nv) pipSwitch(nv); }, 800);
    }
  }
  // Instagram videoları döngüye alır: sondan başa sarma = video bitti.
  // Hem zamanlayıcıdan hem 'timeupdate' olayından çağrılır (arka planda zamanlayıcı yavaşlar, olaylar yavaşlamaz).
  function autoCheck() {
    if (!state.auto) { autoLast.v = null; return; }
    const v = getActiveVideo();
    if (!v || !isFinite(v.duration) || v.duration <= 0) { autoLast.v = null; return; }
    if (autoLast.v !== v) { autoLast = { v, t: v.currentTime }; return; }
    const last = autoLast.t, cur = v.currentTime, dur = v.duration, r = v.playbackRate || 1;
    autoLast.t = cur;
    if (Date.now() < userSeekUntil) return;               // kullanıcı kendisi sardıysa sayma
    const wasNearEnd = last >= dur - (0.25 * r + 0.5);
    const wrapped = cur < last - Math.min(0.5, dur / 2) && cur < Math.max(1.5, dur * 0.3);
    if (wasNearEnd && wrapped) autoAdvance();
  }
  // Arka planda Instagram videoyu durdurursa (kullanıcı durdurmadıysa) devam ettir
  function keepPlaying() {
    if (!document.hidden) return;
    const v = getActiveVideo();
    if (v && v.paused && !userPaused && !v.ended) v.play().catch(() => {});
  }

  document.addEventListener("ended", (e) => {      // döngüsüz video
    if (state.auto && e.target && e.target.tagName === "VIDEO" && e.target === getActiveVideo()) autoAdvance();
  }, true);
  document.addEventListener("timeupdate", (e) => {
    if (e.target && e.target.tagName === "VIDEO") autoCheck();
  }, true);
  document.addEventListener("play", (e) => {
    if (e.target && e.target.tagName === "VIDEO") userPaused = false;
  }, true);
  document.addEventListener("pause", (e) => {
    const t = e.target;
    if (!t || t.tagName !== "VIDEO" || t !== getActiveVideo()) return;
    if (document.hidden) { if (!userPaused) setTimeout(keepPlaying, 0); }
    else userPaused = true;
  }, true);
  setInterval(() => { autoCheck(); keepPlaying(); }, 100);

  // ---------- Tam ekran (orijinal oranda, kırpmadan) ----------
  let fsVideo = null, fsPrevStyle = null, fsPrevControls = false;
  const FS_STYLE = [
    ["object-fit", "contain"], ["width", "100%"], ["height", "100%"],
    ["max-width", "none"], ["max-height", "none"], ["transform", "none"],
    ["margin", "0"], ["background", "#000"],
  ];
  const applyFsStyle = (v) => FS_STYLE.forEach(([k, val]) => v.style.setProperty(k, val, "important"));

  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const v = getActiveVideo(); if (!v) return;
    v.requestFullscreen().catch((e) => console.warn("[IVC] tam ekran hatası:", e));
  }
  document.addEventListener("fullscreenchange", () => {
    const fs = document.fullscreenElement;
    if (fs && fs.tagName === "VIDEO") {
      fsVideo = fs;
      fsPrevStyle = fs.getAttribute("style");
      fsPrevControls = fs.controls;
      applyFsStyle(fs);          // Instagram'ın 'cover' ayarı yerine tüm video görünsün
      fs.controls = true;
    } else if (fsVideo) {
      if (fsPrevStyle === null) fsVideo.removeAttribute("style");
      else fsVideo.setAttribute("style", fsPrevStyle);
      fsVideo.controls = fsPrevControls;
      fsVideo = null;
    }
    if (typeof fsBtn !== "undefined") {
      const inFs = !!document.fullscreenElement;
      setIcon(fsBtn, inFs ? "exitfull" : "full");
      setLabel(fsBtn, inFs ? "Çık (F)" : "Tam ekran (F)");
    }
  });

  // ---------- Ekolayzer / Bass boost (Web Audio) ----------
  let audio = null;
  const attached = new WeakSet();
  const unsupported = new WeakSet();
  const eqActive = () => state.eq.bass !== 0 || state.eq.mid !== 0 || state.eq.treble !== 0;

  function ensureAudio() {
    if (audio) return audio;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const low = ctx.createBiquadFilter();  low.type = "lowshelf";  low.frequency.value = 120;
    const mid = ctx.createBiquadFilter();  mid.type = "peaking";   mid.frequency.value = 1000; mid.Q.value = 0.9;
    const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 6000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 10; comp.attack.value = 0.003; comp.release.value = 0.25;
    low.connect(mid); mid.connect(high); high.connect(comp); comp.connect(ctx.destination);
    audio = { ctx, low, mid, high, comp };
    return audio;
  }
  function applyEq() {
    if (!audio) return;
    const t = audio.ctx.currentTime;
    audio.low.gain.setTargetAtTime(state.eq.bass, t, 0.02);
    audio.mid.gain.setTargetAtTime(state.eq.mid, t, 0.02);
    audio.high.gain.setTargetAtTime(state.eq.treble, t, 0.02);
    audio.comp.ratio.value = eqActive() ? 8 : 1;
  }
  function attachAudio(v) {
    if (attached.has(v)) return true;
    if (unsupported.has(v)) return false;
    if (!v.currentSrc) return false;
    if (!v.currentSrc.startsWith("blob:")) { unsupported.add(v); return false; }
    try {
      const a = ensureAudio();
      const src = a.ctx.createMediaElementSource(v);
      src.connect(a.low);
      attached.add(v);
      applyEq();
      if (a.ctx.state === "suspended") a.ctx.resume().catch(() => {});
      return true;
    } catch (e) {
      console.warn("[IVC] ekolayzer bağlanamadı:", e);
      unsupported.add(v);
      return false;
    }
  }
  function setEq(partial) {
    Object.assign(state.eq, partial);
    save();
    if (eqActive()) { const v = getActiveVideo(); if (v) attachAudio(v); }
    if (audio) {
      applyEq();
      if (audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
    }
    syncEqUI();
  }
  document.addEventListener("pointerdown", () => {
    if (audio && audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
  }, true);

  // ---------- Instagram verisi ----------
  const SHORT_RE = /\/(?:p|reels?|tv)\/(?!audio\/)([A-Za-z0-9_-]+)/;
  const itemCache = new Map();

  function shortcodeFromLinks(root) {
    let node = root;
    while (node && node !== document.body) {
      const a = node.querySelector && node.querySelector(
        'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]');
      if (a) { const m = (a.getAttribute("href") || "").match(SHORT_RE); if (m) return m[1]; }
      if (node.tagName === "ARTICLE") break;
      node = node.parentElement;
    }
    return null;
  }
  function getShortcode(v) {
    const m = location.pathname.match(SHORT_RE);
    if (m) return m[1];
    return shortcodeFromLinks(v);
  }
  function shortcodeToId(sc) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const c of sc) id = id * 64n + BigInt(alphabet.indexOf(c));
    return id.toString();
  }
  async function apiJson(path) {
    const headers = { "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest", "X-ASBD-ID": "129477" };
    try { const claim = sessionStorage.getItem("www-claim-v2"); if (claim) headers["X-IG-WWW-Claim"] = claim; } catch (e) {}
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    if (m) headers["X-CSRFToken"] = decodeURIComponent(m[1]);
    const r = await fetch(path, { credentials: "include", headers });
    if (!r.ok) throw new Error("API " + r.status);
    return r.json();
  }

  // inject.js'in sayfanın kendi yanıtlarından topladığı medya verisi
  const captured = new Map();      // pk -> medya
  const batches = [];              // { ctx, pks }: hangi istekten hangi medyalar geldi
  document.addEventListener("ivc:media", (e) => {
    try {
      const b = JSON.parse(e.detail);
      for (const it of b.items) { captured.delete(it.pk); captured.set(it.pk, it); }
      while (captured.size > 600) captured.delete(captured.keys().next().value);
      batches.push({ ctx: b.ctx, pks: b.items.map((x) => x.pk) });
      if (batches.length > 80) batches.shift();
    } catch (_) {}
  });
  document.dispatchEvent(new Event("ivc:replay"));        // içerik betiği geç yüklendiyse kaçırılanları iste

  // Aynı hikaye akışına (öne çıkan / kullanıcının hikayeleri) ait öğeler, geliş sırasıyla
  function capturedByReel(reelId) {
    const out = [], seen = new Set();
    for (const b of batches) {
      for (const pk of b.pks) {
        const it = captured.get(pk);
        if (it && !seen.has(pk) && it.reel === reelId) { seen.add(pk); out.push(it); }
      }
    }
    return out;
  }
  function capturedHighlight(hid) {
    const tagged = capturedByReel("highlight:" + hid);
    if (tagged.length) return tagged;
    // etiket yoksa (yanıt biçimi farklıysa) isteğin içeriğine bak
    const out = [], seen = new Set();
    for (const b of batches) {
      if (!b.ctx.includes("highlight:" + hid)) continue;
      for (const pk of b.pks) if (!seen.has(pk) && captured.has(pk)) { seen.add(pk); out.push(captured.get(pk)); }
    }
    return out;
  }
  function capturedByUser(name) {
    const now = Date.now() / 1000;
    return [...captured.values()]
      .filter((it) => it.user && it.user.username === name && it.taken_at && now - it.taken_at < 90000)
      .sort((a, b) => a.taken_at - b.taken_at);
  }

  async function fetchById(id) {
    const c = itemCache.get(id);
    if (c && Date.now() - c.t < 5 * 60 * 1000) return c.item;
    let item;
    try {
      const j = await apiJson("/api/v1/media/" + id + "/info/");
      item = j.items && j.items[0];
      if (!item) throw new Error("boş yanıt");
    } catch (e) {
      const cap = captured.get(String(id));            // servis cevap vermezse sayfadan yakalanana bak
      if (cap) return cap;
      throw e;
    }
    if (itemCache.size > 20) itemCache.delete(itemCache.keys().next().value);
    itemCache.set(id, { t: Date.now(), item });
    return item;
  }
  const fetchItem = (code) => fetchById(shortcodeToId(code.slice(0, 11)));

  // ---------- Video kalite listesi ----------
  function collectVersions(item) {
    if (item.video_versions && item.video_versions.length) return item.video_versions;
    if (item.carousel_media) {
      for (const c of item.carousel_media) { const r = collectVersions(c); if (r.length) return r; }
    }
    return [];
  }
  function findDashXml(item) {
    if (item.video_dash_manifest) return item.video_dash_manifest;
    if (item.carousel_media) {
      for (const c of item.carousel_media) if (c.video_dash_manifest) return c.video_dash_manifest;
    }
    return null;
  }

  // DASH manifest: ayrı video (birçok çözünürlük) ve ses parçaları
  function parseDash(xml) {
    const out = { videos: [], audio: null };
    try {
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      const audios = [];
      for (const r of doc.getElementsByTagName("Representation")) {
        const base = r.getElementsByTagName("BaseURL")[0];
        const url = base && (base.textContent || "").trim();
        if (!url) continue;
        const as = r.parentElement;
        const attr = (n) => r.getAttribute(n) || (as && as.getAttribute(n)) || "";
        const codecs = attr("codecs"), mime = attr("mimeType"), ctype = attr("contentType");
        if (mime && !/mp4/.test(mime)) continue;
        const bw = parseInt(attr("bandwidth") || "0", 10);
        const w = parseInt(attr("width") || "0", 10), h = parseInt(attr("height") || "0", 10);
        const isAudio = /^audio/.test(mime) || ctype === "audio" || /^(mp4a|opus|ac-3|ec-3)/.test(codecs);
        if (isAudio) { if (!codecs || /^mp4a/.test(codecs)) audios.push({ url, bw, codecs }); }
        else if (w && h && !/^(vp0?[89]|av01)/.test(codecs)) out.videos.push({ url, bw, w, h, codecs });
      }
      if (out.videos.some((x) => /^avc/.test(x.codecs))) out.videos = out.videos.filter((x) => /^avc/.test(x.codecs));
      audios.sort((a, b) => b.bw - a.bw);
      out.audio = audios[0] || null;
    } catch (e) { console.warn("[IVC] manifest okunamadı:", e); }
    return out;
  }

  // en yüksek + ortadaki + en düşük kalite
  function pickThree(videos) {
    const sorted = videos.slice().sort((a, b) => (b.w * b.h - a.w * a.h) || (b.bw - a.bw));
    const uniq = [], seen = new Set();
    for (const x of sorted) {
      const k = Math.min(x.w, x.h);
      if (seen.has(k)) continue;
      seen.add(k); uniq.push(x);
    }
    const n = uniq.length;
    const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].sort((a, b) => a - b);
    return idx.map((i) => uniq[i]);
  }

  function progressiveList(raw) {
    const sorted = raw.filter((x) => x && x.url).slice()
      .sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0));
    const out = [], seen = new Set();
    for (const x of sorted) {
      const k = x.width + "x" + x.height;
      if (seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out.slice(0, 3).map((x) => {
      const dim = Math.min(x.width || 0, x.height || 0);
      return { url: x.url, label: dim ? dim + "p" : "Orijinal", w: x.width, h: x.height, bytes: 0 };
    });
  }

  function buildQualities(item, fallbackDuration) {
    const prog = progressiveList(collectVersions(item));
    const fallbackUrl = prog[0] ? prog[0].url : null;
    const dur = item.video_duration || fallbackDuration || 0;
    const xml = findDashXml(item);
    if (xml) {
      const d = parseDash(xml);
      if (d.videos.length) {
        return pickThree(d.videos).map((x) => ({
          label: Math.min(x.w, x.h) + "p", w: x.w, h: x.h,
          bytes: dur ? Math.round(((x.bw || 0) + (d.audio ? d.audio.bw : 0)) * dur / 8) : 0,
          dash: { video: x, audio: d.audio }, fallbackUrl,
        }));
      }
    }
    return prog;
  }

  async function getQualities(v) {
    const code = getShortcode(v);
    if (code) {
      try {
        const item = await fetchItem(code);
        const list = buildQualities(item, isFinite(v.duration) ? v.duration : 0);
        if (list.length) return { list, code };
      } catch (e) { console.warn("[IVC] kalite listesi alınamadı:", e); }
    }
    if (v.currentSrc && !v.currentSrc.startsWith("blob:")) {
      return { list: [{ url: v.currentSrc, label: "Orijinal", bytes: 0 }], code };
    }
    return { list: [], code };
  }

  // ---------- İndirme yardımcıları ----------
  const timers = new Map();
  function flashBtn(btn, text, reset, ms) {
    setLabel(btn, text);
    btn._flashUntil = Date.now() + (ms || 2500);
    clearTimeout(timers.get(btn));
    timers.set(btn, setTimeout(() => {
      btn._flashUntil = 0;
      setLabel(btn, typeof reset === "function" ? reset() : reset);
    }, ms || 2500));
  }
  const flash = (t, ms) => flashBtn(dlBtn, t, DL_LABEL, ms);
  const flashImg = (t, ms) => flashBtn(imgBtn, t, IMG_LABEL, ms);

  function sendDownload(url, filename, done) {
    chrome.runtime.sendMessage({ type: "download", url, filename }, (res) => {
      const ok = !chrome.runtime.lastError && res && res.ok;
      if (!ok) console.warn("[IVC] indirme hatası:", chrome.runtime.lastError || (res && res.error));
      done && done(ok);
    });
  }
  async function fetchBuf(url) {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.arrayBuffer();
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 15000);
  }

  // fl: durum yazısını hangi butonda göstereceği (varsayılan: video indir butonu)
  async function startDownload(q, code, fl) {
    fl = fl || flash;
    closeQualityMenu();
    const base = "instagram_" + (code || Date.now());
    const viaApi = (url, name, label) => new Promise((res) =>
      sendDownload(url, name, (ok) => {
        fl(ok ? "✅ İndiriliyor (" + label + ")" : "❌ İndirilemedi");
        res(ok);
      }));
    if (q.dash) {
      fl("⏳ İndiriliyor...", 120000);
      try {
        const [vb, ab] = await Promise.all([
          fetchBuf(q.dash.video.url),
          q.dash.audio ? fetchBuf(q.dash.audio.url) : Promise.resolve(null),
        ]);
        const out = self.IVCMux.mux(new Uint8Array(vb), ab ? new Uint8Array(ab) : null);
        saveBlob(new Blob([out], { type: "video/mp4" }), base + "_" + q.label + ".mp4");
        fl("✅ " + q.label + " kaydedildi", 3000);
        return true;
      } catch (e) {
        console.warn("[IVC] DASH indirme/birleştirme başarısız:", e);
        if (!q.fallbackUrl) { fl("❌ İndirilemedi"); return false; }
        fl("⚠ Standart kalite indiriliyor", 3000);
        return viaApi(q.fallbackUrl, base + "_standart.mp4", "standart");
      }
    }
    return viaApi(q.url, base + "_" + q.label + ".mp4", q.label);
  }

  function menuRow(label, badge, sub, onclick, title) {
    const b = el("button", { class: "rowbtn", title: title || "" });
    b.addEventListener("click", onclick);
    b.appendChild(el("span", { class: "rl", text: label }));
    if (badge) b.appendChild(el("span", { class: "badge", text: badge }));
    b.appendChild(el("span", { class: "rs", text: sub || "" }));
    return b;
  }
  function showQualityMenu(list, code) {
    while (qCol.firstChild) qCol.removeChild(qCol.firstChild);
    list.forEach((q, i) => {
      qCol.appendChild(menuRow(
        q.label, i === 0 ? "En yüksek" : "", q.bytes ? "~" + fmtSize(q.bytes) : "",
        () => startDownload(q, code), q.w ? q.w + "×" + q.h : ""));
    });
    qCode = code;
    qWrap.classList.add("open");
  }
  function closeQualityMenu() { qWrap.classList.remove("open"); qCode = undefined; }

  async function onDownloadClick() {
    if (qWrap.classList.contains("open")) { closeQualityMenu(); return; }
    const v = getActiveVideo();
    if (!v) { flash("Video yok"); return; }
    flash("⏳ Hazırlanıyor...", 20000);
    const { list, code } = await getQualities(v);
    if (!list.length) { flash("❌ Bulunamadı"); return; }
    flash(DL_LABEL, 10);
    if (list.length === 1) { startDownload(list[0], code); return; }
    showQualityMenu(list, code);
  }
  async function quickDownload() {         // Alt+D: en yüksek kalite
    const v = getActiveVideo();
    if (!v) { flash("Video yok"); return; }
    flash("⏳ Hazırlanıyor...", 20000);
    const { list, code } = await getQualities(v);
    if (!list.length) { flash("❌ Bulunamadı"); return; }
    startDownload(list[0], code);
  }

  // ---------- Görsel indirme (tekli / kaydırmalı gönderiler) ----------
  function bestImage(node) {
    const c = node.image_versions2 && node.image_versions2.candidates;
    if (!c || !c.length) return null;
    return c.slice().sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0].url;
  }
  function mediaList(item) {
    const nodes = item.carousel_media && item.carousel_media.length ? item.carousel_media : [item];
    const out = [];
    nodes.forEach((n, i) => {
      if (n.video_versions && n.video_versions.length) out.push({ i: i + 1, type: "video", url: n.video_versions[0].url });
      else { const u = bestImage(n); if (u) out.push({ i: i + 1, type: "image", url: u }); }
    });
    return out;
  }
  function extOf(url, fallback) {
    const m = (url.split("?")[0] || "").match(/\.(jpe?g|png|webp|heic|mp4)$/i);
    return m ? m[1].toLowerCase() : fallback;
  }

  function getActivePost() {
    const m = location.pathname.match(/\/p\/([A-Za-z0-9_-]+)/);
    if (m) return { code: m[1] };
    let best = null, bestArea = 0;
    for (const a of document.querySelectorAll("article")) {
      const r = a.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > bestArea) { bestArea = w * h; best = a; }
    }
    if (!best) return null;
    const code = shortcodeFromLinks(best);
    return code ? { code } : null;
  }

  // ----- ZIP (sıkıştırmasız "store" biçimi; dış kütüphane gerekmez) -----
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {                         // files: [{ name, data: Uint8Array }]
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // 0x0800: UTF-8 dosya adı
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  // "Hepsini indir": dosyaları tek tek değil, tek bir ZIP olarak indir
  async function downloadAllZip(items, code) {
    closeImageMenu();
    const files = [];
    let fail = 0;
    for (let i = 0; i < items.length; i++) {
      flashImg("⏳ ZIP hazırlanıyor (" + (i + 1) + "/" + items.length + ")", 180000);
      const it = items[i];
      try {
        const buf = await fetchBuf(it.url);
        files.push({ name: "instagram_" + code + "_" + it.i + "." + extOf(it.url, it.type === "video" ? "mp4" : "jpg"), data: new Uint8Array(buf) });
      } catch (e) { fail++; console.warn("[IVC] ZIP: dosya alınamadı:", it.i, e && e.message); }
    }
    if (!files.length) {                              // hiçbiri alınamadıysa son çare: tek tek indir
      console.warn("[IVC] ZIP yapılamadı, dosyalar tek tek indiriliyor");
      flashImg("⚠ ZIP yapılamadı, tek tek iniyor", 4000);
      downloadMedia(items, code);
      return;
    }
    saveBlob(makeZip(files), "instagram_" + code + "_gorseller.zip");
    flashImg(fail ? "⚠ ZIP indirildi, " + fail + " dosya alınamadı" : "✅ ZIP indirildi (" + files.length + " dosya)", 4000);
  }

  function downloadMedia(items, code) {
    closeImageMenu();
    let n = 0, fail = 0;
    items.forEach((it, k) => {
      setTimeout(() => {
        const ext = extOf(it.url, it.type === "video" ? "mp4" : "jpg");
        sendDownload(it.url, "instagram_" + code + "_" + it.i + "." + ext, (ok) => {
          n++; if (!ok) fail++;
          if (n === items.length) flashImg(fail ? "❌ " + fail + " hata" : "✅ İndiriliyor (" + items.length + ")");
        });
      }, k * 350);
    });
  }

  function showImageMenu(list, code) {
    while (iCol.firstChild) iCol.removeChild(iCol.firstChild);
    iCol.appendChild(menuRow("Hepsini indir", "ZIP", list.length + " dosya", () => downloadAllZip(list, code)));
    const grid = el("div", { class: "grid" });
    list.forEach((it) => grid.appendChild(el("button", {
      class: "nbtn", text: it.i + (it.type === "video" ? " ▶" : ""),
      title: it.i + ". " + (it.type === "video" ? "video" : "görsel"),
      onclick: () => downloadMedia([it], code),
    })));
    iCol.appendChild(grid);
    iCode = code;
    iWrap.classList.add("open");
  }
  function closeImageMenu() { iWrap.classList.remove("open"); iCode = undefined; }

  async function onImageClick() {
    if (iWrap.classList.contains("open")) { closeImageMenu(); return; }
    const post = getActivePost();
    if (!post) { flashImg("Gönderi yok"); return; }
    flashImg("⏳ Hazırlanıyor...", 20000);
    try {
      const item = await fetchItem(post.code);
      const list = mediaList(item);
      if (!list.length) { flashImg("Görsel yok"); return; }
      flashImg(IMG_LABEL, 10);
      if (list.length === 1) { downloadMedia(list, post.code); return; }
      showImageMenu(list, post.code);
    } catch (e) {
      console.warn("[IVC] görsel listesi alınamadı:", e);
      flashImg("❌ Bulunamadı");
    }
  }

  // ---------- Hikaye indirme (video: sesiyle birlikte, fotoğraf: görsel) ----------
  const isVideoItem = (it) => it.media_type === 2 || !!(it.video_versions && it.video_versions.length);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let sPath;

  function parseStoryUrl() {
    let m = location.pathname.match(/^\/stories\/highlights\/(\d+)/);
    if (m) return { highlight: m[1] };
    m = location.pathname.match(/^\/stories\/([^/]+)\/?(\d+)?/);
    if (m) return { user: m[1], id: m[2] || null };
    return null;
  }
  function reelItems(j) {
    const a = j.reels_media && j.reels_media[0];
    if (a && a.items) return a.items;
    const r = j.reels && Object.values(j.reels)[0];
    return (r && r.items) || [];
  }
  const itemId = (it) => String(it.pk || String(it.id || "").split("_")[0] || "");

  // Açık hikayenin öğelerini getirir (önce sayfanın kendi verisi, sonra servisler).
  // current: şu an gösterilen öğe (bilinmiyorsa null). attempts: hata ayıklama notları.
  async function getStoryItems(info, attempts) {
    const note = (t) => attempts.push(t);
    if (info.highlight) {
      const cap = capturedHighlight(info.highlight);
      note("yakalanan:" + cap.length);
      if (cap.length) return { items: cap, current: null };
      try {
        const j = await apiJson("/api/v1/feed/reels_media/?reel_ids=" + encodeURIComponent("highlight:" + info.highlight));
        const items = reelItems(j);
        note("akış:" + items.length);
        if (items.length) return { items, current: null };
      } catch (e) { note("akış:" + e.message); }
      return { items: [], current: null };
    }
    if (info.id) {
      const c = captured.get(info.id);
      note("yakalanan:" + (c ? "var" : "yok"));
      if (c) return { items: [c], current: c };
      try {
        const item = await fetchById(info.id);
        note("medya:tamam");
        return { items: [item], current: item };
      } catch (e) { note("medya:" + e.message); }
    } else {
      const cu = capturedByUser(info.user);
      note("yakalanan-kullanıcı:" + cu.length);
      if (cu.length) return { items: cu, current: null };
    }
    try {
      const pj = await apiJson("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(info.user));
      const uid = pj.data && pj.data.user && pj.data.user.id;
      if (!uid) throw new Error("kullanıcı yok");
      const j = await apiJson("/api/v1/feed/reels_media/?reel_ids=" + uid);
      const items = reelItems(j);
      note("akış:" + items.length);
      const cur = info.id ? items.find((it) => itemId(it) === info.id) : null;
      if (items.length) return { items, current: cur || null };
    } catch (e) { note("akış:" + e.message); }
    return { items: [], current: null };
  }

  let storyCounter = "";
  const storyLabel = () => STORY_LABEL + (storyCounter ? " (" + storyCounter + ")" : "");
  const flashStory = (t, ms) => flashBtn(storyBtn, t, storyLabel, ms);

  // ----- Şu an ekranda izlenen hikaye öğesini bul -----
  const keyOf = (u) => { try { return new URL(u, location.href).pathname.split("/").pop() || ""; } catch (e) { return ""; } };
  const keyCache = new WeakMap();
  function itemKeys(it) {                       // öğenin dosya adları (görsel / video adresleri)
    let k = keyCache.get(it);
    if (k) return k;
    k = new Set();
    const c = it.image_versions2 && it.image_versions2.candidates;
    if (c) c.forEach((x) => k.add(keyOf(x.url)));
    if (it.video_versions) it.video_versions.forEach((x) => k.add(keyOf(x.url)));
    if (typeof it.video_dash_manifest === "string") {
      const re = /<BaseURL>([^<]+)<\/BaseURL>/g;
      let m;
      while ((m = re.exec(it.video_dash_manifest))) k.add(keyOf(m[1].replace(/&amp;/g, "&")));
    }
    k.delete("");
    keyCache.set(it, k);
    return k;
  }

  // 1) Üstteki ilerleme çubukları: dolan parça kaçıncı? (parça sayısı = öğe sayısı)
  function storyProgressIndex(n) {
    if (n < 2) return -1;
    let best = null, bestW = 0;
    for (const c of document.querySelectorAll("div")) {
      if (c.childElementCount !== n) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 100 || r.height < 1 || r.height > 40 || r.bottom < 0 || r.top > innerHeight) continue;
      const segs = [...c.children];
      const rs = segs.map((x) => x.getBoundingClientRect());
      let row = true;
      for (let i = 0; i < n; i++) {
        if (rs[i].height < 1 || rs[i].height > 12 || rs[i].width < 2 || Math.abs(rs[i].top - rs[0].top) > 2 ||
            (i && rs[i].left < rs[i - 1].left)) { row = false; break; }
      }
      if (row && r.width > bestW) { best = { segs, rs }; bestW = r.width; }   // birden fazla varsa en genişi (öndeki)
    }
    if (!best) return -1;
    const { segs, rs } = best;
    let idx;
    if (segs.every((x) => !x.firstElementChild)) {
      // dolgu elemanı yoksa: izlenmiş parçalar daha opak
      const al = segs.map((x) => { const m = getComputedStyle(x).backgroundColor.match(/[\d.]+/g) || []; return m.length >= 4 ? parseFloat(m[3]) : 1; });
      const hi = Math.max(...al), lo = Math.min(...al);
      if (hi - lo < 0.2) return -1;
      const full = al.map((a) => a >= hi - 0.05);
      idx = full.indexOf(false);
      if (idx < 0) return n - 1;
      for (let j = 0; j < idx; j++) if (!full[j]) return -1;
      for (let j = idx; j < n; j++) if (full[j]) return -1;
      return idx;
    }
    const ratios = segs.map((x, i) => {
      let m = 0;
      for (const d of x.querySelectorAll("*")) {
        const dr = d.getBoundingClientRect();
        const ov = Math.max(0, Math.min(dr.right, rs[i].right) - Math.max(dr.left, rs[i].left));   // taşma/kaydırma ile gizlenen kısmı sayma
        if (ov > m) m = ov;
      }
      return Math.min(1, m / rs[i].width);
    });
    idx = ratios.findIndex((x) => x < 0.98);
    if (idx < 0) idx = n - 1;
    for (let j = 0; j < idx; j++) if (ratios[j] < 0.9) return -1;           // beklenen düzen: öncekiler dolu...
    for (let j = idx + 1; j < n; j++) if (ratios[j] > 0.1) return -1;       // ...sonrakiler boş
    return idx;
  }

  // 2) Ekrandaki büyük görselin dosya adı (fotoğraf hikaye ya da videonun kapak görseli)
  function matchByImage(items) {
    const u = domStoryImageUrl();
    const k = u ? keyOf(u) : "";
    if (!k) return null;
    const hits = items.filter((it) => itemKeys(it).has(k));
    return hits.length === 1 ? hits[0] : null;
  }

  // 3) Oynayan video: oynatıcı hangi öğenin dosyalarını, oynatma başlamadan hemen önce istedi?
  const playStart = new WeakMap();
  document.addEventListener("playing", (e) => {
    if (e.target && e.target.tagName === "VIDEO") playStart.set(e.target, performance.now());
  }, true);
  function matchByNetwork(items) {
    const v = getActiveVideo();
    if (!v) return null;
    const ents = performance.getEntriesByType("resource").filter((e) => /\.mp4/.test(e.name)).slice(-500);
    if (!ents.length) return null;
    const first = new Map();
    for (const it of items) {
      if (!isVideoItem(it)) continue;
      const keys = itemKeys(it);
      for (const e of ents) {
        if (!keys.has(keyOf(e.name))) continue;
        if (!first.has(it) || e.startTime < first.get(it)) first.set(it, e.startTime);
      }
    }
    if (!first.size) return null;
    let cands = [...first.keys()];
    const dur = isFinite(v.duration) ? v.duration : 0;
    if (dur) { const f = cands.filter((it) => !it.video_duration || Math.abs(it.video_duration - dur) < 0.6); if (f.length) cands = f; }
    if (cands.length === 1) return cands[0];
    const ps = playStart.get(v);
    // şu anki hikayenin dosyası oynatma başlamadan ÖNCE istenmiş olmalı; sonradan önden yüklenenleri (sıradaki hikaye) ele
    if (ps != null) { const f = cands.filter((it) => first.get(it) <= ps + 50); if (f.length) cands = f; }
    cands.sort((a, b) => first.get(b) - first.get(a));
    return cands[0];
  }

  function currentStoryItem(items, info) {
    if (!items.length) return null;
    if (items.length === 1) return items[0];
    if (info.id) { const m = items.find((it) => itemId(it) === info.id); if (m) return m; }
    const idx = storyProgressIndex(items.length);
    if (idx >= 0 && idx < items.length) return items[idx];
    return matchByImage(items) || matchByNetwork(items);
  }

  // Sayfanın kendi yüklediği veriden, şu anki hikaye akışının öğeleri
  function storyListNow(info) {
    if (info.highlight) return capturedHighlight(info.highlight);
    const c = info.id ? captured.get(info.id) : null;
    if (c && c.reel) { const l = capturedByReel(c.reel); if (l.length) return l; }
    if (c) return [c];
    return info.user ? capturedByUser(info.user) : [];
  }

  // Buton hep şu an izlenen hikayeyi gösterir: "Hikaye indir (3/12)"; hikaye değiştikçe güncellenir
  let lastStoryTick = 0, storyLast = { idx: -1, t: 0 };
  function storyTick() {
    const info = parseStoryUrl();
    const now = Date.now();
    if (!info) {
      if (storyCounter) { storyCounter = ""; if (now > (storyBtn._flashUntil || 0)) setLabel(storyBtn, STORY_LABEL); }
      return;
    }
    if (now - lastStoryTick < 400) return;
    lastStoryTick = now;
    const list = storyListNow(info);
    let c = "";
    if (list.length > 1) {
      const cur = currentStoryItem(list, info);
      if (cur) storyLast = { idx: list.indexOf(cur), t: now };
      else if (now - storyLast.t > 1500) storyLast.idx = -1;
      if (storyLast.idx >= 0 && storyLast.idx < list.length) c = (storyLast.idx + 1) + "/" + list.length;
    } else storyLast.idx = -1;
    storyCounter = c;
    if (now > (storyBtn._flashUntil || 0)) setLabel(storyBtn, storyLabel());
  }

  async function downloadStoryItem(item, info, fl) {
    const user = (item.user && item.user.username) || info.user || "hikaye";
    const tag = "story_" + user + "_" + (itemId(item) || Date.now());
    if (isVideoItem(item)) {
      // en yüksek kalite; ses varsa video ile birleştirilir, yoksa sessiz video iner
      const list = buildQualities(item, item.video_duration || 0);
      if (!list.length) { fl("❌ Video bulunamadı"); return false; }
      return startDownload(list[0], tag, fl);
    }
    const url = bestImage(item);
    if (!url) { fl("❌ Görsel bulunamadı"); return false; }
    return new Promise((res) =>
      sendDownload(url, "instagram_" + tag + "." + extOf(url, "jpg"), (ok) => {
        fl(ok ? "✅ Görsel indiriliyor" : "❌ İndirilemedi");
        res(ok);
      }));
  }

  async function downloadStoryItems(items, info) {
    closeStoryMenu();
    let okCount = 0;
    for (const it of items) {
      if (await downloadStoryItem(it, info, flashStory)) okCount++;
      if (items.length > 1) await sleep(300);
    }
    if (items.length > 1) flashStory(okCount === items.length ? "✅ " + okCount + " dosya" : "⚠ " + okCount + "/" + items.length, 3500);
    return okCount;
  }

  function showStoryMenu(items, info) {
    while (sCol.firstChild) sCol.removeChild(sCol.firstChild);
    sCol.appendChild(menuRow("Hepsini indir", "En yüksek", items.length + " dosya", () => downloadStoryItems(items, info)));
    const grid = el("div", { class: "grid" });
    items.forEach((it, i) => grid.appendChild(el("button", {
      class: "nbtn", text: (i + 1) + (isVideoItem(it) ? " ▶" : ""),
      title: (i + 1) + ". " + (isVideoItem(it) ? "video" : "fotoğraf"),
      onclick: () => downloadStoryItems([it], info),
    })));
    sCol.appendChild(grid);
    sPath = location.pathname;
    sWrap.classList.add("open");
  }
  function closeStoryMenu() { sWrap.classList.remove("open"); sPath = undefined; }

  // ----- Yedek yol: veri hiçbir yerden gelmediyse ekrandakini kullan -----
  // Fotoğraf hikaye: ekrandaki büyük görselin adresi
  function domStoryImageUrl() {
    let best = null, area = 0;
    for (const img of document.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 300) continue;          // hikaye görseli büyük ve dikeydir; profil resimleri küçük
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > area) { area = w * h; best = img; }
    }
    const u = best && (best.currentSrc || best.src);
    return u && /^https?:/.test(u) ? u : null;
  }

  // Video hikaye: oynatıcının indirdiği DASH parçalarından (bytestart/byteend'siz tam dosya adresi)
  async function perfStoryVideo(v, tag, fl) {
    const ents = performance.getEntriesByType("resource")
      .filter((e) => /\.mp4(\?|$)/.test(e.name) && /(cdninstagram|fbcdn)\./.test(e.name));
    if (!ents.length) throw new Error("parça yok");
    const last = new Map();
    ents.forEach((e, i) => {
      const u = new URL(e.name);
      u.searchParams.delete("bytestart"); u.searchParams.delete("byteend");
      last.set(u.toString(), i);
    });
    const cands = [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0]);
    const want = isFinite(v.duration) ? v.duration : 0;
    let video = null, audioUrl = null;
    for (const url of cands) {
      let inf;
      try {
        const r = await fetch(url, { headers: { Range: "bytes=0-65535" }, credentials: "omit" });
        inf = self.IVCMux.info(new Uint8Array(await r.arrayBuffer()));
      } catch (e) { continue; }
      if (want && inf.duration && Math.abs(inf.duration - want) > 0.8) continue;   // başka hikayenin parçası
      if (inf.kind === "video" && !video) video = url;
      else if (inf.kind === "audio" && !audioUrl) audioUrl = url;
      if (video && audioUrl) break;
    }
    if (!video) throw new Error("video parçası yok");
    fl("⏳ İndiriliyor...", 120000);
    const [vb, ab] = await Promise.all([fetchBuf(video), audioUrl ? fetchBuf(audioUrl) : Promise.resolve(null)]);
    const out = self.IVCMux.mux(new Uint8Array(vb), ab ? new Uint8Array(ab) : null);
    saveBlob(new Blob([out], { type: "video/mp4" }), "instagram_" + tag + "_izlenen.mp4");
    fl("✅ Kaydedildi", 3000);
    return true;
  }

  async function domStoryDownload(info, attempts) {
    const tag = "story_" + (info.user || "hikaye") + "_" + (info.id || Date.now());
    const v = getActiveVideo();
    if (v && !v.paused && v.readyState > 0) {
      const r = v.getBoundingClientRect();
      if (r.width > 150 && r.height > 250) {
        try { if (await perfStoryVideo(v, tag, flashStory)) { attempts.push("sayfa:video"); return true; } }
        catch (e) { attempts.push("sayfa-video:" + e.message); }
      }
    }
    const url = domStoryImageUrl();
    if (url) {
      attempts.push("sayfa:görsel");
      return new Promise((res) =>
        sendDownload(url, "instagram_" + tag + "." + extOf(url, "jpg"), (ok) => {
          flashStory(ok ? "✅ Görsel indiriliyor" : "❌ İndirilemedi");
          res(ok);
        }));
    }
    attempts.push("sayfa:yok");
    return false;
  }

  async function onStoryClick() {
    if (sWrap.classList.contains("open")) { closeStoryMenu(); return; }
    const info = parseStoryUrl();
    if (!info) { flashStory("Hikaye açık değil"); return; }
    flashStory("⏳ Hazırlanıyor...", 120000);
    const attempts = [];
    try {
      const { items, current } = await getStoryItems(info, attempts);
      if (items.length) {
        const cur = current || currentStoryItem(items, info);       // şu an izlenen öğe
        if (cur) {
          if (await downloadStoryItems([cur], info)) return;
          attempts.push("indirme:başarısız");
        } else {
          attempts.push("hangisi:belirlenemedi");                      // son çare: yalnızca bu akıştakiler
          flashStory(storyLabel(), 10);
          showStoryMenu(items, info);
          return;
        }
      }
    } catch (e) { attempts.push("hata:" + e.message); }
    try { if (await domStoryDownload(info, attempts)) return; }
    catch (e) { attempts.push("sayfa:" + e.message); }
    console.warn("[IVC] hikaye bulunamadı. Denemeler:", attempts.join(" | "));
    const code = (attempts.join(" ").match(/\b(?:API|HTTP) \d{3}/) || [""])[0];
    flashStory("❌ Veri yok" + (code ? " · " + code : ""), 6000);
  }

  // ---------- Resim içinde resim (PiP) ----------
  // PiP açıkken reels değişirse (otomatik kaydırma ya da elle) pencere yeni videoyu izler; böylece otomatik kaydırma çalışmaya devam eder.
  const PIP_LABEL = "Resim içinde resim";
  const flashPip = (t, ms) => flashBtn(pipBtn, t, PIP_LABEL, ms);
  let pipLast = 0, pipWant = 0;
  function pipPrep(v) {                                  // Instagram PiP'i kapatmışsa bu özniteliği kaldır
    try { v.disablePictureInPicture = false; v.removeAttribute("disablepictureinpicture"); } catch (e) {}
  }
  async function togglePip() {
    if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); } catch (e) {} return; }
    const v = getActiveVideo();
    if (!v) { flashPip("Video yok", 3000); return; }
    if (!document.pictureInPictureEnabled) { flashPip("Tarayıcı desteklemiyor", 4000); return; }
    try { pipPrep(v); await v.requestPictureInPicture(); }
    catch (e) { console.warn("[IVC] resim içinde resim açılamadı:", e && e.message); flashPip("❌ Açılamadı", 3500); }
  }
  // PiP açıkken başka videoya geç (PiP penceresi zaten açık olduğundan kullanıcı hareketi gerekmez)
  async function pipSwitch(nv) {
    const cur = document.pictureInPictureElement;
    if (!cur || !nv || cur === nv) return false;
    try {
      pipPrep(nv);
      await nv.requestPictureInPicture();
      if (nv.paused) nv.play().catch(() => {});
      return true;
    } catch (e) { console.warn("[IVC] PiP yeni videoya geçemedi:", e && e.message); return false; }
  }
  // Reels sayfasında etkin video değişirse PiP onu izlesin (kısa bir bekleme ile; kaydırma sırasında zıplamasın)
  function pipTick() {
    pipBtn.classList.toggle("on", !!document.pictureInPictureElement);
    const cur = document.pictureInPictureElement;
    if (!cur || !/^\/reels?(\/|$)/.test(location.pathname)) { pipWant = 0; return; }
    const v = getActiveVideo();
    if (!v || v === cur) { pipWant = 0; return; }
    const now = Date.now();
    if (!pipWant) { pipWant = now; return; }
    if (now - pipWant > 400 && now - pipLast > 1500) { pipLast = now; pipWant = 0; pipSwitch(v); }
  }
  ["enterpictureinpicture", "leavepictureinpicture"].forEach((ev) =>
    document.addEventListener(ev, () => { if (typeof pipBtn !== "undefined") pipBtn.classList.toggle("on", !!document.pictureInPictureElement); }, true));

  // ---------- Simgeler (SVG; innerHTML yok) ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICONS = {
    play:    { p: ["M8 5v14l11-7z"], fill: true },
    pause:   { p: ["M7 5h3.5v14H7z", "M13.5 5H17v14h-3.5z"], fill: true },
    back5:   { p: ["M3.5 12a8.5 8.5 0 1 0 2.9-6.4L3.5 8.5", "M3.5 3.5v5h5"], t: "5" },
    fwd5:    { p: ["M20.5 12a8.5 8.5 0 1 1-2.9-6.4L20.5 8.5", "M20.5 3.5v5h-5"], t: "5" },
    up:      { p: ["M12 19V5", "M6 11l6-6 6 6"] },
    down:    { p: ["M12 5v14", "M6 13l6 6 6-6"] },
    download:{ p: ["M12 4v11", "M7.5 11.5L12 16l4.5-4.5", "M5 20h14"] },
    image:   { p: ["M4 5.5h16v13H4z", "M4 16l5-5 4 4 2.5-2.5L20 17"], c: [[9, 9.5, 1.4]] },
    full:    { p: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"] },
    exitfull:{ p: ["M9 4v5H4", "M15 4v5h5", "M9 20v-5H4", "M15 20v-5h5"] },
    eq:      { p: ["M6 20v-9", "M12 20V4", "M18 20v-6"] },
    vol:     { p: ["M5 9.5v5h3.5L13 18V6L8.5 9.5H5z", "M16.5 9.5a4 4 0 0 1 0 5", "M19 7a7.5 7.5 0 0 1 0 10"] },
    mute:    { p: ["M5 9.5v5h3.5L13 18V6L8.5 9.5H5z", "M16.5 9.5l5 5", "M21.5 9.5l-5 5"] },
    minus:   { p: ["M6 12h12"] },
    plus:    { p: ["M12 6v12", "M6 12h12"] },
    chevD:   { p: ["M6 9l6 6 6-6"] },
    chevR:   { p: ["M9 6l6 6-6 6"] },
    story:   { p: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 7.5v7", "M9 12l3 3 3-3"] },
    speed:   { p: ["M4 17a8.5 8.5 0 1 1 16 0", "M12 16l4.2-5.2"], c: [[12, 16, 1.4]] },
    pip:     { p: ["M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z", "M12.5 12.5h5.5V16h-5.5z"] },
    repeat:  { p: ["M17 3l4 4-4 4", "M3 11V9.5A2.5 2.5 0 0 1 5.5 7H21", "M7 21l-4-4 4-4", "M21 13v1.5a2.5 2.5 0 0 1-2.5 2.5H3"] },
    grip:    { p: ["M20 11L11 20", "M20 16.5L16.5 20"] },
  };

  function icon(name) {
    const d = ICONS[name];
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "ic");
    (d.p || []).forEach((pd) => {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", pd);
      if (d.fill) p.setAttribute("class", "f");
      svg.appendChild(p);
    });
    (d.c || []).forEach(([cx, cy, r]) => {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
      c.setAttribute("class", "f");
      svg.appendChild(c);
    });
    if (d.t) {
      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("x", "12"); t.setAttribute("y", "15"); t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "tt");
      t.textContent = d.t;
      svg.appendChild(t);
    }
    return svg;
  }
  function setIcon(btn, name) {
    if (btn._ic === name) return;
    btn._ic = name;
    const old = btn.querySelector(".ic");
    const n = icon(name);
    if (old) btn.replaceChild(n, old); else btn.insertBefore(n, btn.firstChild);
  }
  const setLabel = (btn, text) => { if (btn.tx) btn.tx.textContent = text; };

  function ibtn(iconName, opts = {}) {
    const b = el("button", { class: "btn " + (opts.cls || ""), title: opts.title || opts.label || "",
      "aria-label": opts.title || opts.label || "" });
    if (opts.onclick) b.addEventListener("click", opts.onclick);
    b.appendChild(icon(iconName));
    b._ic = iconName;
    if (opts.label !== undefined) { b.tx = el("span", { class: "tx", text: opts.label }); b.appendChild(b.tx); }
    return b;
  }

  // kaydırıcının dolu kısmını boya
  function paint(input) {
    const min = parseFloat(input.min) || 0, max = parseFloat(input.max) || 100;
    const val = parseFloat(input.value) || 0;
    input.style.setProperty("--p", (max > min ? ((val - min) / (max - min)) * 100 : 0) + "%");
  }

  const DL_LABEL = "Video indir", IMG_LABEL = "Görsel indir", STORY_LABEL = "Hikaye indir";

  const CSS = `
    *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    button{all:unset;box-sizing:border-box;cursor:pointer}
    button:focus-visible{outline:2px solid rgba(255,255,255,.6);outline-offset:2px}
    .panel{--a1:#e1306c;--a2:#f77737;--a3:#833ab4;
      --grad:linear-gradient(135deg,#833ab4 0%,#e1306c 55%,#f77737 100%);
      position:relative;width:300px;padding:12px 14px 18px;color:#f5f5f7;font-size:12.5px;
      user-select:none;border-radius:22px;
      background:linear-gradient(180deg,rgba(34,34,44,.84),rgba(14,14,20,.9));
      backdrop-filter:blur(20px) saturate(1.6);-webkit-backdrop-filter:blur(20px) saturate(1.6);
      border:1px solid rgba(255,255,255,.1);
      box-shadow:0 22px 56px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.07)}
    .panel.collapsed{width:auto;padding:8px 12px;border-radius:999px;cursor:pointer}
    .panel.collapsed .body,.panel.collapsed .rz{display:none}
    .head{display:flex;align-items:center;gap:8px;cursor:grab;touch-action:none}
    .head:active{cursor:grabbing}
    .logo{position:relative;flex:none;width:20px;height:20px;border-radius:6.5px;
      background:linear-gradient(45deg,#fcb045 0%,#f77737 24%,#e1306c 56%,#7a3bd6 100%);
      box-shadow:0 2px 9px rgba(225,48,108,.5),inset 0 1px 0 rgba(255,255,255,.35)}
    .logo::before{content:"";position:absolute;left:5.5px;top:3.5px;width:9px;height:9px;background:#fff;
      clip-path:polygon(8% 0,100% 50%,8% 100%)}
    .logo::after{content:"";position:absolute;left:4.5px;bottom:3px;width:11px;height:2.2px;border-radius:2px;
      background:linear-gradient(90deg,#fff 0 62%,rgba(255,255,255,.45) 62% 100%)}
    .title{flex:1;min-width:0;display:flex;align-items:baseline;gap:5px;white-space:nowrap;overflow:hidden}
    .tn{font-weight:650;font-size:12.5px;letter-spacing:.1px;overflow:hidden;text-overflow:ellipsis}
    .by{font-size:10px;font-weight:650;font-style:italic;letter-spacing:.3px;
      background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
    .body{margin-top:10px}
    .scroll{overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.28) transparent}
    .ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;
      stroke-linecap:round;stroke-linejoin:round}
    .ic .f{fill:currentColor}
    .ic .tt{fill:currentColor;stroke:none;font-size:8px;font-weight:700}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 12px;
      border-radius:12px;background:rgba(255,255,255,.07);color:#f5f5f7;white-space:nowrap;
      transition:background .15s,transform .1s,box-shadow .15s,filter .15s}
    .btn:hover{background:rgba(255,255,255,.16)}
    .btn:active{transform:scale(.95)}
    .btn.on{background:var(--grad);box-shadow:0 5px 16px rgba(225,48,108,.38)}
    .btn.open:not(.on){background:rgba(255,255,255,.2)}
    .btn.sm{width:28px;height:28px;padding:0;border-radius:9px}
    .btn.ghost{background:transparent}
    .btn.ghost:hover{background:rgba(255,255,255,.12)}
    .btn.icon{width:38px;height:38px;padding:0;border-radius:12px}
    .btn.primary{width:52px;height:52px;padding:0;border-radius:50%;background:var(--grad);
      box-shadow:0 8px 24px rgba(225,48,108,.5)}
    .btn.primary:hover{filter:brightness(1.12);background:var(--grad)}
    .btn.primary .ic{width:22px;height:22px}
    .btn .tx{overflow:hidden;text-overflow:ellipsis;max-width:92px}
    .seekwrap{margin-top:2px}
    .times{display:flex;justify-content:space-between;font-size:10.5px;opacity:.6;
      margin-top:-3px;font-variant-numeric:tabular-nums}
    .transport{display:flex;align-items:center;justify-content:center;gap:24px;margin-top:12px}
    .navrow{margin-top:10px}
    .card{margin-top:12px;padding:11px 12px;border-radius:16px;background:rgba(255,255,255,.045);
      border:1px solid rgba(255,255,255,.06)}
    .line{display:flex;align-items:center;gap:8px}
    .line + .line{margin-top:10px}
    .lab{width:30px;opacity:.65;font-size:11.5px}
    .rowic{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;opacity:.8}
    .chip{width:52px;min-width:52px;flex:none;height:28px;border-radius:9px;background:rgba(255,255,255,.09);
      display:inline-flex;align-items:center;justify-content:center;font-weight:650;
      font-variant-numeric:tabular-nums;transition:background .15s}
    .chip:hover{background:rgba(255,255,255,.18)}
    .pctbox{position:relative;display:inline-flex;align-items:center;width:52px;flex:none}
    .pctin{box-sizing:border-box;width:100%;height:28px;padding:0 16px 0 4px;border:0;border-radius:9px;
      background:rgba(255,255,255,.09);color:#f5f5f7;font:inherit;font-weight:650;font-size:12.5px;text-align:right;
      font-variant-numeric:tabular-nums;user-select:text;-moz-appearance:textfield;transition:background .15s}
    .pctin:hover{background:rgba(255,255,255,.15)}
    .pctin:focus{background:rgba(255,255,255,.18);outline:2px solid rgba(225,48,108,.75);outline-offset:0}
    .pctin::-webkit-inner-spin-button,.pctin::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
    .pcts{position:absolute;right:6px;opacity:.65;font-size:11px;pointer-events:none}
    .spacer{flex:1}
    input[type=range]{-webkit-appearance:none;appearance:none;flex:1;min-width:0;width:100%;height:20px;
      margin:0;background:transparent;cursor:pointer;--p:0%}
    input[type=range]::-webkit-slider-runnable-track{height:5px;border-radius:99px;
      background:linear-gradient(90deg,#e1306c,#f77737) 0 0/var(--p) 100% no-repeat,rgba(255,255,255,.17)}
    input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;
      background:#fff;margin-top:-4.5px;box-shadow:0 1px 7px rgba(0,0,0,.55);transition:transform .12s}
    input[type=range]:hover::-webkit-slider-thumb{transform:scale(1.25)}
    .toggle{display:flex;align-items:center;gap:10px;width:100%;height:50px;padding:0 12px;margin-top:12px;
      border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);
      transition:background .15s}
    .toggle:hover{background:rgba(255,255,255,.09)}
    .toggle .lbl{flex:1;display:flex;flex-direction:column;gap:1px;font-weight:550}
    .toggle .sub{font-size:10px;opacity:.55;font-weight:450}
    .track{width:40px;height:23px;border-radius:99px;background:rgba(255,255,255,.2);position:relative;
      transition:background .2s}
    .knob{position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;
      box-shadow:0 1px 5px rgba(0,0,0,.45);transition:transform .2s}
    .toggle.on .track{background:var(--grad)}
    .toggle.on .knob{transform:translateX(17px)}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
    .grid2 .btn{width:100%;justify-content:flex-start;padding:0 11px}
    .grid2 .span2{grid-column:1 / -1}
    .grid2 .span2 .tx{max-width:none}
    .menu{display:none;margin-top:10px;padding:10px;border-radius:16px;background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.08)}
    .menu.open{display:block}
    .cap{font-size:10px;text-transform:uppercase;letter-spacing:.7px;opacity:.55;margin-bottom:8px}
    .col{display:flex;flex-direction:column;gap:6px}
    .rowbtn{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:11px;
      background:rgba(255,255,255,.07);transition:background .15s}
    .rowbtn:hover{background:rgba(255,255,255,.16)}
    .rl{font-weight:650}
    .badge{font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--grad)}
    .rs{margin-left:auto;opacity:.65;font-size:11px}
    .grid{display:flex;flex-wrap:wrap;gap:6px}
    .nbtn{min-width:36px;height:32px;padding:0 8px;border-radius:10px;background:rgba(255,255,255,.08);
      display:inline-flex;align-items:center;justify-content:center;font-weight:650;transition:background .15s}
    .nbtn:hover{background:rgba(255,255,255,.18)}
    .eq{display:none;margin-top:10px;padding:10px;border-radius:16px;background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.08)}
    .eq.open{display:block}
    .presets{display:flex;gap:6px}
    .pre{flex:1;height:28px;border-radius:9px;background:rgba(255,255,255,.08);display:inline-flex;
      align-items:center;justify-content:center;font-size:11px;font-weight:600;transition:background .15s}
    .pre:hover{background:rgba(255,255,255,.18)}
    .pre.on{background:var(--grad)}
    .eqrow{display:flex;align-items:center;gap:8px;margin-top:8px}
    .eqrow .n{width:32px;opacity:.7}
    .eqrow .v{width:48px;text-align:right;font-size:11px;opacity:.85;font-variant-numeric:tabular-nums}
    .note{font-size:10.5px;color:#ffb347;margin-top:6px}
    .rz{position:absolute;right:6px;bottom:6px;width:20px;height:20px;display:flex;align-items:center;
      justify-content:center;cursor:nwse-resize;opacity:.4;touch-action:none;transition:opacity .15s}
    .rz:hover{opacity:1}
    .rz .ic{width:14px;height:14px}
  `;

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(c);
    return e;
  }

  const host = document.createElement("div");
  const setHostStyle = (k, v) => host.style.setProperty(k, v, "important");
  setHostStyle("position", "fixed");
  setHostStyle("z-index", "2147483647");
  setHostStyle("top", "16px");
  setHostStyle("right", "16px");
  const root = host.attachShadow({ mode: "open" });

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch (e) {
    const st = document.createElement("style");
    st.textContent = CSS;
    root.appendChild(st);
  }
  // kaydırıcı boyaması için
  root.addEventListener("input", (e) => { if (e.target && e.target.type === "range") paint(e.target); }, true);

  let seeking = false;
  let qCode, iCode;

  const seekEl = el("input", { type: "range", min: "0", max: "100", step: "0.1", value: "0" });
  const curEl = el("span", { text: "0:00" });
  const durEl = el("span", { text: "0:00" });

  const playBtn = ibtn("pause", { cls: "primary", title: "Oynat / Duraklat (Alt+P)", onclick: togglePlay });
  const backBtn = ibtn("back5", { cls: "icon", title: "5 sn geri (←)", onclick: () => seek(-SEEK_STEP) });
  const fwdBtn = ibtn("fwd5", { cls: "icon", title: "5 sn ileri (→)", onclick: () => seek(SEEK_STEP) });
  const prevBtn = ibtn("up", { label: "Önceki reels", title: "Önceki reels (↑)", onclick: () => gotoVideo(-1) });
  const nextBtn = ibtn("down", { label: "Sonraki reels", title: "Sonraki reels (↓)", onclick: () => gotoVideo(1) });

  const speedLbl = el("button", { class: "chip", text: "1x", title: "1x'e sıfırla", onclick: () => setSpeed(1) });
  const speedEl = el("input", { type: "range", min: String(SPEED_MIN), max: String(SPEED_MAX), step: String(SPEED_STEP), value: "1", title: "Oynatma hızı",
    oninput: (e) => setSpeed(parseFloat(e.target.value)) });
  const speedIcon = el("span", { class: "rowic", title: "Oynatma hızı" }, [icon("speed")]);
  const speedMinus = ibtn("minus", { cls: "sm", title: "Yavaşlat (Alt+[)", onclick: () => setSpeed(state.speed - SPEED_STEP) });
  const speedPlus = ibtn("plus", { cls: "sm", title: "Hızlandır (Alt+])", onclick: () => setSpeed(state.speed + SPEED_STEP) });

  const muteBtn = ibtn("vol", { cls: "sm ghost", title: "Sessiz (Alt+M)", onclick: toggleMute });
  const volMinus = ibtn("minus", { cls: "sm", title: "Sesi 1 azalt", onclick: () => stepVolume(-1) });
  const volPlus = ibtn("plus", { cls: "sm", title: "Sesi 1 artır", onclick: () => stepVolume(1) });
  const volEl = el("input", { type: "range", min: "0", max: "100", step: "1", value: "100",
    oninput: (e) => setVolume(parseInt(e.target.value, 10) / 100) });
  const volNum = el("input", { type: "number", min: "0", max: "100", step: "1", value: "100", class: "pctin",
    title: "Ses yüzdesi (0-100): yazıp Enter'a bas", "aria-label": "Ses yüzdesi" });
  const volLbl = el("span", { class: "pctbox" }, [volNum, el("span", { class: "pcts", text: "%" })]);
  volNum.addEventListener("input", () => {
    const n = parseInt(volNum.value, 10);
    if (!isNaN(n)) setVolume(clamp(n, 0, 100) / 100);
  });
  volNum.addEventListener("change", () => { volNum.value = currentPercent(); });        // boş / sınır dışı değeri düzelt
  volNum.addEventListener("blur", () => { volNum.value = currentPercent(); });
  ["keydown", "keyup", "keypress"].forEach((t) => volNum.addEventListener(t, (e) => {
    if (t === "keydown" && e.key === "Enter") volNum.blur();
    e.stopPropagation();                                                              // yazarken Instagram kısayolları tetiklenmesin
  }));
  const setVolText = (p) => { if (root.activeElement !== volNum) volNum.value = p; };

  const autoBtn = el("button", { class: "toggle", role: "switch", "aria-checked": "false",
    title: "Video bitince sonraki reels'e geç (Alt+A)", onclick: toggleAuto }, [
    icon("repeat"),
    el("span", { class: "lbl" }, [
      el("span", { class: "main", text: "Otomatik kaydır" }),
      el("span", { class: "sub", text: "Video bitince sonrakine geçer" }),
    ]),
    el("span", { class: "track" }, [el("span", { class: "knob" })]),
  ]);

  const dlBtn = ibtn("download", { label: DL_LABEL, title: "Videoyu indir (Alt+D: en yüksek kalite)", onclick: onDownloadClick });
  const imgBtn = ibtn("image", { label: IMG_LABEL, title: "Görseli indir (Alt+I)", onclick: onImageClick });
  const storyBtn = ibtn("story", { cls: "span2", label: STORY_LABEL,
    title: "Açık hikayeyi indir (Alt+S): video sesiyle, fotoğraf görsel olarak", onclick: onStoryClick });
  const fsBtn = ibtn("full", { label: "Tam ekran (F)", title: "Tam ekran (F)", onclick: toggleFullscreen });
  const pipBtn = ibtn("pip", { cls: "span2", label: PIP_LABEL, title: "Resim içinde resim (Alt+R): küçük yüzen pencerede izle; otomatik kaydırma çalışmaya devam eder", onclick: togglePip });
  const eqBtn = ibtn("eq", { label: "Ekolayzer", title: "Ekolayzer / bass boost (Alt+B)" });

  const qCol = el("div", { class: "col" });
  const qWrap = el("div", { class: "menu" }, [el("div", { class: "cap", text: "Video kalitesi" }), qCol]);
  const iCol = el("div", { class: "col" });
  const iWrap = el("div", { class: "menu" }, [el("div", { class: "cap", text: "Görsel seç" }), iCol]);

  const sCol = el("div", { class: "col" });
  const sWrap = el("div", { class: "menu" }, [el("div", { class: "cap", text: "Hikaye seç" }), sCol]);

  const eqInputs = {};
  const presetBtns = PRESETS.map((p) => el("button", { class: "pre", text: p.name, onclick: () => setEq(p.eq) }));
  function eqRow(label, key, min, max) {
    const val = el("span", { class: "v", text: "0 dB" });
    const input = el("input", { type: "range", min: String(min), max: String(max), step: "1", value: "0" });
    input.addEventListener("input", () => setEq({ [key]: parseInt(input.value, 10) }));
    eqInputs[key] = { input, val };
    return el("div", { class: "eqrow" }, [el("span", { class: "n", text: label }), input, val]);
  }
  const eqNote = el("div", { class: "note" });
  const eqSection = el("div", { class: "eq" }, [
    el("div", { class: "presets" }, presetBtns),
    eqRow("Bass", "bass", -12, 20),
    eqRow("Orta", "mid", -12, 12),
    eqRow("Tiz", "treble", -12, 12),
    eqNote,
  ]);
  eqBtn.addEventListener("click", () => {
    const open = eqSection.classList.toggle("open");
    eqBtn.classList.toggle("open", open);          // pembe değil; pembe = bir ayar aktif
  });

  seekEl.addEventListener("pointerdown", () => (seeking = true));
  seekEl.addEventListener("pointerup", () => (seeking = false));
  seekEl.addEventListener("input", (e) => {
    const v = getActiveVideo();
    userSeekUntil = Date.now() + 1200;
    if (v && isFinite(v.duration)) v.currentTime = (parseFloat(e.target.value) / 100) * v.duration;
  });

  const toggleEl = ibtn("chevD", { cls: "sm ghost", title: "Küçült" });
  const headEl = el("div", { class: "head" }, [el("span", { class: "logo" }), el("span", { class: "title" }, [el("span", { class: "tn", text: "Instagram Controller" }), el("span", { class: "by", text: "by Serki" })]), toggleEl]);
  const rzEl = el("div", { class: "rz", title: "Boyutlandır (çift tıkla: sıfırla)" }, [icon("grip")]);

  const body = el("div", { class: "body" }, [
    el("div", { class: "seekwrap" }, [seekEl, el("div", { class: "times" }, [curEl, durEl])]),
    el("div", { class: "transport" }, [backBtn, playBtn, fwdBtn]),
    el("div", { class: "grid2 navrow" }, [prevBtn, nextBtn]),
    el("div", { class: "card" }, [
      el("div", { class: "line" }, [speedIcon, speedMinus, speedEl, speedPlus, speedLbl]),
      el("div", { class: "line" }, [muteBtn, volMinus, volEl, volPlus, volLbl]),
    ]),
    autoBtn,
    el("div", { class: "grid2" }, [dlBtn, imgBtn, storyBtn, fsBtn, eqBtn, pipBtn]),
    qWrap,
    iWrap,
    sWrap,
    eqSection,
  ]);

  const scrollEl = el("div", { class: "scroll" }, [body]);
  const panel = el("div", { class: "panel" }, [headEl, scrollEl, rzEl]);

  // ----- Konum: sürükleyerek taşıma -----
  let drag = null, dragMoved = false;
  function setPos(x, y) {
    const r = host.getBoundingClientRect();
    const maxX = Math.max(0, innerWidth - (r.width || 300));
    const maxY = Math.max(0, innerHeight - (r.height || 40));
    x = clamp(x, 0, maxX); y = clamp(y, 0, maxY);
    state.pos = { x, y };
    setHostStyle("left", x + "px");
    setHostStyle("top", y + "px");
    host.style.removeProperty("right");
  }
  headEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || toggleEl.contains(e.target)) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
    dragMoved = false;
    if (headEl.setPointerCapture) { try { headEl.setPointerCapture(e.pointerId); } catch (_) {} }
  });
  headEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!dragMoved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    dragMoved = true;
    setPos(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    if (dragMoved) { save(); setTimeout(() => (dragMoved = false), 80); }
  };
  headEl.addEventListener("pointerup", endDrag);
  headEl.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", () => { fitHeight(); if (state.pos) setPos(state.pos.x, state.pos.y); });

  // ----- Boyut: sağ alt köşeden tutup sürükle -----
  // Panel ekran yüksekliğinden uzunsa iç alanı kaydırılabilir yap (tutamak ve başlık ekranda kalsın)
  function fitHeight() {
    const sc = state.scale || 1;
    const avail = (innerHeight - 24) / sc - 74;           // 74: başlık + iç boşluklar (ölçeksiz px)
    scrollEl.style.maxHeight = Math.max(160, avail) + "px";
  }
  function setScale(s) {
    s = round2(clamp(parseFloat(s) || 1, 0.6, 2));
    state.scale = s;
    panel.style.setProperty("zoom", String(s));
    panel.setAttribute("data-scale", String(s));
    fitHeight();
  }
  let rz = null;
  rzEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = host.getBoundingClientRect();
    setPos(r.left, r.top);                       // sol üst köşeye sabitle: büyüme sağa/aşağı olsun
    rz = { sx: e.clientX, sy: e.clientY, scale: state.scale || 1, w: r.width || 300, h: r.height || 300 };
    if (rzEl.setPointerCapture) { try { rzEl.setPointerCapture(e.pointerId); } catch (_) {} }
  });
  rzEl.addEventListener("pointermove", (e) => {
    if (!rz) return;
    const f = ((rz.w + (e.clientX - rz.sx)) / rz.w + (rz.h + (e.clientY - rz.sy)) / rz.h) / 2;
    setScale(rz.scale * f);
    if (state.pos) setPos(state.pos.x, state.pos.y);
  });
  const endRz = () => { if (!rz) return; rz = null; save(); };
  rzEl.addEventListener("pointerup", endRz);
  rzEl.addEventListener("pointercancel", endRz);
  rzEl.addEventListener("dblclick", () => { setScale(1); if (state.pos) setPos(state.pos.x, state.pos.y); save(); });

  panel.addEventListener("click", () => {
    if (state.collapsed && !dragMoved) { state.collapsed = false; save(); syncUI(); }
  });
  toggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    state.collapsed = !state.collapsed; save(); syncUI();
  });

  root.appendChild(panel);
  (document.body || document.documentElement).appendChild(host);

  function setPlayIcon(paused) { setIcon(playBtn, paused ? "play" : "pause"); }
  function updatePlayBtn() {
    const v = getActiveVideo();
    setPlayIcon(!!(v && v.paused));
  }
  function syncEqUI() {
    const e = state.eq;
    for (const k of ["bass", "mid", "treble"]) {
      eqInputs[k].input.value = e[k];
      paint(eqInputs[k].input);
      eqInputs[k].val.textContent = (e[k] > 0 ? "+" : "") + e[k] + " dB";
    }
    PRESETS.forEach((p, i) => {
      const same = p.eq.bass === e.bass && p.eq.mid === e.mid && p.eq.treble === e.treble;
      presetBtns[i].classList.toggle("on", same);
    });
    eqBtn.classList.toggle("on", eqActive());      // herhangi bir ekolayzer ayarı açıksa pembe
  }
  function syncUI() {
    panel.classList.toggle("collapsed", !!state.collapsed);
    setIcon(toggleEl, state.collapsed ? "chevR" : "chevD");
    toggleEl.title = state.collapsed ? "Genişlet" : "Küçült";
    speedLbl.textContent = state.speed + "x";
    speedEl.value = state.speed; paint(speedEl);
    const on = !!state.auto;
    autoBtn.classList.toggle("on", on);
    autoBtn.setAttribute("aria-checked", String(on));
    // inject.js: Instagram sekmeyi hep görünür sanır (arka planda durmaz); otomatik kaydırmadan bağımsız
    document.documentElement.setAttribute("data-ivc-keepalive", "1");
    const p = Math.round((state.muted ? 0 : state.volume) * 100);
    volEl.value = p; paint(volEl);
    setVolText(p);
    setIcon(muteBtn, p === 0 ? "mute" : "vol");
    setScale(state.scale);
    syncEqUI();
  }

  try {
    chrome.storage.local.get("ivc", (r) => {
      if (r && r.ivc) {
        Object.assign(state, r.ivc);
        state.eq = Object.assign({ bass: 0, mid: 0, treble: 0 }, state.eq);
      }
      syncUI();
      if (state.pos) setPos(state.pos.x, state.pos.y);
    });
  } catch (e) {}

  // Önceki bir sürümden kalmış olabilecek eski kayıtları (kaydedilmiş API anahtarı vb.) temizle; ayarlara dokunma
  try {
    chrome.storage.local.get(null, (all) => {
      const stale = Object.keys(all || {}).filter((k) =>
        k === "ivc_key" || k === "ivc_models" || k === "ivc_api_base" || k === "ivcs_index" || k.startsWith("ivcs:"));
      if (stale.length) chrome.storage.local.remove(stale);
    });
  } catch (e) {}

  // ---------- Döngü ----------
  setInterval(() => {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    if (sWrap.classList.contains("open") && location.pathname !== sPath) closeStoryMenu();
    storyTick();
    pipTick();
    if (state.pos) {                                    // içerik büyüyüp ekran dışına taşarsa geri çek
      const hr = host.getBoundingClientRect();
      if (hr.height && (hr.bottom > innerHeight + 1 || hr.right > innerWidth + 1)) setPos(state.pos.x, state.pos.y);
    }

    const v = getActiveVideo();
    if (!v) return;
    setPlayIcon(v.paused);

    if (Math.abs(v.playbackRate - state.speed) > 0.001) v.playbackRate = state.speed;

    // Yeni videoya kullanıcının son ses ayarını uygula
    if (!volumeApplied.has(v)) {
      const m = desired.muted !== null ? desired.muted : state.muted;
      const vol = desired.volume !== null ? desired.volume : state.volume;
      v.volume = vol;
      v.muted = m;
      volumeApplied.add(v);
    }

    // Tam ekranda Instagram'ın stili geri getirirse tekrar uygula
    if (fsVideo && fsVideo.style.getPropertyValue("object-fit") !== "contain") applyFsStyle(fsVideo);

    // Ekolayzer
    if (audio && audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
    if (eqActive() && !attached.has(v) && !unsupported.has(v)) {
      const ok = (audio && audio.ctx.state === "running") ||
                 (navigator.userActivation && navigator.userActivation.hasBeenActive);
      if (ok) attachAudio(v);
    }
    eqNote.textContent = unsupported.has(v) ? "⚠ Bu video için ekolayzer desteklenmiyor." : "";

    // Menüler başka videoya/gönderiye geçince kapansın
    if (qWrap.classList.contains("open") && getShortcode(v) !== qCode) closeQualityMenu();
    if (iWrap.classList.contains("open")) {
      const p = getActivePost();
      if (!p || p.code !== iCode) closeImageMenu();
    }

    if (!seeking && isFinite(v.duration) && v.duration > 0) {
      seekEl.value = (v.currentTime / v.duration) * 100;
      paint(seekEl);
      curEl.textContent = fmt(v.currentTime);
      durEl.textContent = fmt(v.duration);
    }

    const real = Math.round((v.muted ? 0 : v.volume) * 100);
    volEl.value = real; paint(volEl);
    setVolText(real);
    setIcon(muteBtn, real === 0 ? "mute" : "vol");
  }, 250);

  // ---------- Klavye kısayolları ----------
  const isTyping = (e) => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;      // panel gölge DOM'unun içinden de doğru hedef
    return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
  };

  // F: tam ekran aç / kapat (Alt gerekmez; yazı yazarken çalışmaz)
  document.addEventListener("keydown", (e) => {
    if (e.code !== "KeyF" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
    if (isTyping(e)) return;
    if (!document.fullscreenElement && !getActiveVideo()) return;
    toggleFullscreen();
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Reels sayfasında Alt'sız yön tuşları: ← / → 5 sn geri / ileri, ↑ / ↓ önceki / sonraki reels
  // (hikaye, ana sayfa gibi yerlerde Instagram'ın kendi yön tuşu davranışına dokunmaz)
  let navCool = 0;
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const k = e.code;
    if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "ArrowUp" && k !== "ArrowDown") return;
    if (isTyping(e)) return;
    const fs = document.fullscreenElement;
    const fsVideo = !!(fs && fs.tagName === "VIDEO");
    const reels = /^\/reels?(\/|$)/.test(location.pathname);
    if (!reels && !fsVideo) return;
    if (!getActiveVideo()) return;
    if (k === "ArrowLeft") seek(-SEEK_STEP);
    else if (k === "ArrowRight") seek(SEEK_STEP);
    else if (reels) {
      const now = Date.now();
      if (now >= navCool) { navCool = now + 350; gotoVideo(k === "ArrowUp" ? -1 : 1); }   // tuşa basılı tutunca reels atlamasın
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTyping(e)) return;
    const step = e.shiftKey ? 5 : 1;
    let handled = true;
    switch (e.code) {
      case "ArrowLeft":  seek(-SEEK_STEP); break;
      case "ArrowRight": seek(SEEK_STEP); break;
      case "ArrowUp":    stepVolume(step); break;
      case "ArrowDown":  stepVolume(-step); break;
      case "BracketLeft":  setSpeed(state.speed - SPEED_STEP); break;
      case "BracketRight": setSpeed(state.speed + SPEED_STEP); break;
      case "KeyM": toggleMute(); break;
      case "KeyP": togglePlay(); break;
      case "KeyD": quickDownload(); break;
      case "KeyI": onImageClick(); break;
      case "KeyS": onStoryClick(); break;
      case "KeyR": togglePip(); break;
      case "KeyF": toggleFullscreen(); break;
      case "KeyA": toggleAuto(); break;
      case "PageUp": gotoVideo(-1); break;
      case "PageDown": gotoVideo(1); break;
      case "KeyB": {
        const bass = PRESETS[1].eq;
        const isBass = state.eq.bass === bass.bass && state.eq.mid === bass.mid && state.eq.treble === bass.treble;
        setEq(isBass ? PRESETS[0].eq : bass);
        break;
      }
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  syncUI();
})();
