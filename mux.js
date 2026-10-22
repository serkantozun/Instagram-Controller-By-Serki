// Parçalı (fragmented) MP4 olarak gelen ayrı video + ses dosyalarını tek MP4'te birleştirir.
(function (root) {
  "use strict";

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  const t4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function boxes(b, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = t4(b, o + 4);
      let hdr = 8;
      if (size === 1) {
        if (o + 16 > end) break;
        size = u32(b, o + 8) * 4294967296 + u32(b, o + 12);
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, size, hdr, end: o + size });
      o += size;
    }
    return out;
  }
  const kids = (b, box, type) =>
    boxes(b, box.start + box.hdr, box.end).filter((x) => !type || x.type === type);

  function mk(type, parts) {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    w32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function trackInfo(b, trak) {
    const tkhd = kids(b, trak, "tkhd")[0];
    if (!tkhd) throw new Error("tkhd yok");
    const idOff = tkhd.start + (b[tkhd.start + 8] === 1 ? 28 : 20);
    const mdia = kids(b, trak, "mdia")[0];
    const mdhd = mdia && kids(b, mdia, "mdhd")[0];
    if (!mdhd) throw new Error("mdhd yok");
    const timescale = u32(b, mdhd.start + (b[mdhd.start + 8] === 1 ? 28 : 20)) || 1;
    return { id: u32(b, idOff), idOff: idOff - trak.start, timescale };
  }

  function parseFile(b) {
    const top = boxes(b, 0, b.length);
    const moov = top.find((x) => x.type === "moov");
    if (!moov) throw new Error("moov yok");
    const mvex = kids(b, moov, "mvex")[0];
    if (!mvex) throw new Error("parçalı (fragmented) MP4 değil");
    const trak = kids(b, moov, "trak")[0];
    const mvhd = kids(b, moov, "mvhd")[0];
    if (!trak || !mvhd) throw new Error("trak/mvhd yok");
    const info = trackInfo(b, trak);
    const trexes = kids(b, mvex, "trex");
    const trex = trexes.find((t) => u32(b, t.start + 12) === info.id) || trexes[0];
    if (!trex) throw new Error("trex yok");

    const frags = [];
    let moof = null;
    for (const bx of top) {
      if (bx.type === "moof") moof = bx;
      else if (bx.type === "mdat" && moof) {
        const mfhd = kids(b, moof, "mfhd")[0];
        const trafs = kids(b, moof, "traf");
        if (!mfhd || !trafs.length) throw new Error("moof yapısı beklenmedik");
        const tfhdOffs = [];
        let time = 0;
        trafs.forEach((traf, i) => {
          const tfhd = kids(b, traf, "tfhd")[0];
          if (!tfhd) throw new Error("tfhd yok");
          const flags = (b[tfhd.start + 9] << 16) | (b[tfhd.start + 10] << 8) | b[tfhd.start + 11];
          if (flags & 1) throw new Error("base_data_offset desteklenmiyor");
          tfhdOffs.push(tfhd.start + 12 - moof.start);
          if (i === 0) {
            const tfdt = kids(b, traf, "tfdt")[0];
            if (tfdt) {
              time = b[tfdt.start + 8] === 1
                ? u32(b, tfdt.start + 12) * 4294967296 + u32(b, tfdt.start + 16)
                : u32(b, tfdt.start + 12);
            }
          }
        });
        frags.push({
          start: moof.start, end: bx.end,
          mfhdOff: mfhd.start + 12 - moof.start, tfhdOffs, time: time / info.timescale,
        });
        moof = null;
      }
    }
    if (!frags.length) throw new Error("fragment yok");
    return { b, top, moov, mvhd, trak, trex, info, frags };
  }

  function mux(videoBytes, audioBytes) {
    if (!audioBytes || !audioBytes.length) return videoBytes;
    const V = parseFile(videoBytes);
    const A = parseFile(audioBytes);

    const vId = V.info.id;
    const aId = A.info.id === vId ? vId + 1 : A.info.id;

    // ses trak + trex kopyaları (track id yamalı)
    const aTrak = A.b.slice(A.trak.start, A.trak.end);
    w32(aTrak, A.info.idOff, aId);
    const aTrex = A.b.slice(A.trex.start, A.trex.end);
    w32(aTrex, 12, aId);
    const vTrex = V.b.slice(V.trex.start, V.trex.end);
    const vTrak = V.b.slice(V.trak.start, V.trak.end);

    const mvhd = V.b.slice(V.mvhd.start, V.mvhd.end);
    w32(mvhd, mvhd[8] === 1 ? 116 : 104, Math.max(vId, aId) + 1);

    const mvex = mk("mvex", [vTrex, aTrex]);
    const moov = mk("moov", [mvhd, vTrak, aTrak, mvex]);

    const ftypBox = V.top.find((x) => x.type === "ftyp");
    const ftyp = ftypBox ? V.b.slice(ftypBox.start, ftypBox.end) : mk("ftyp", [
      new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x36, 0x6d, 0x70, 0x34, 0x31]),
    ]);

    // parçaları zamana göre sırala (video önce)
    const all = [];
    V.frags.forEach((f) => all.push({ f, src: V.b, audio: false }));
    A.frags.forEach((f) => all.push({ f, src: A.b, audio: true }));
    all.forEach((x, i) => (x.i = i));
    all.sort((x, y) => (x.f.time - y.f.time) || (x.audio - y.audio) || (x.i - y.i));

    const out = [ftyp, moov];
    let seq = 1;
    for (const x of all) {
      const bytes = x.src.slice(x.f.start, x.f.end);
      w32(bytes, x.f.mfhdOff, seq++);
      if (x.audio) for (const off of x.f.tfhdOffs) w32(bytes, off, aId);
      out.push(bytes);
    }

    let total = 0;
    for (const p of out) total += p.length;
    const res = new Uint8Array(total);
    let o = 0;
    for (const p of out) { res.set(p, o); o += p.length; }
    return res;
  }

  // Dosyanın ilk baytlarından (moov + sidx) iz türü ve süresi: {kind: video|audio|unknown, duration: sn}
  function info(b) {
    const top = boxes(b, 0, b.length);
    let kind = "unknown";
    const moov = top.find((x) => x.type === "moov");
    if (moov) {
      const trak = kids(b, moov, "trak")[0];
      const mdia = trak && kids(b, trak, "mdia")[0];
      const hdlr = mdia && kids(b, mdia, "hdlr")[0];
      if (hdlr) { const t = t4(b, hdlr.start + 16); kind = t === "vide" ? "video" : t === "soun" ? "audio" : "unknown"; }
    }
    let duration = 0;
    const sidx = top.find((x) => x.type === "sidx");
    if (sidx) {
      const ver = b[sidx.start + 8];
      const ts = u32(b, sidx.start + 16);
      let o = sidx.start + 20 + (ver === 1 ? 16 : 8) + 2;
      const cnt = (b[o] << 8) | b[o + 1];
      o += 2;
      let sum = 0;
      for (let i = 0; i < cnt && o + 12 <= sidx.end; i++, o += 12) sum += u32(b, o + 4);
      duration = ts ? sum / ts : 0;
    }
    return { kind, duration };
  }

  const api = { mux, info };
  root.IVCMux = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
