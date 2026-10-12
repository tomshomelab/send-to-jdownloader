/* Injected on demand into every frame of the active tab.
   Returns the page URL plus a ranked list of likely "main video" URLs. */
(() => {
  const out = { page: location.href, title: document.title || '', top: window === window.top, blob: false, candidates: [] };
  const seen = new Set();

  const add = (url, kind, score) => {
    if (!url || typeof url !== 'string') return;
    let abs;
    try { abs = new URL(url, location.href).href; } catch (_) { return; }
    if (/^blob:/i.test(abs)) { out.blob = true; return; }
    if (/^data:/i.test(abs)) return;
    if (!/^https?:/i.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.candidates.push({ url: abs, kind, score });
  };

  // 1. <video> elements: biggest / playing one wins.
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    let score = Math.min(r.width * r.height, 4e6) / 1000;   // up to ~4000 for a full-screen player
    if (!v.paused && !v.ended) score += 5000;
    if (v.currentTime > 0) score += 1000;
    add(v.currentSrc || v.src, 'video', score + 500);
    for (const s of v.querySelectorAll('source')) add(s.src, 'video', score + (/^video\//i.test(s.type) ? 400 : 200));
  }

  // 2. Open Graph / Twitter player metadata.
  const metas = [
    'meta[property="og:video:secure_url"]', 'meta[property="og:video:url"]', 'meta[property="og:video"]',
    'meta[name="twitter:player:stream"]', 'meta[property="twitter:player:stream"]',
  ];
  for (const sel of metas) for (const m of document.querySelectorAll(sel)) add(m.content, 'meta', 3000);

  // 3. JSON-LD VideoObject.
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 6) return;
        if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
        if (/VideoObject/i.test(String(o['@type']))) { add(o.contentUrl, 'jsonld', 2800); add(o.embedUrl, 'embed', 1500); }
        for (const k of ['@graph', 'itemListElement', 'video', 'mainEntity', 'hasPart', 'item']) walk(o[k], depth + 1);
      };
      walk(JSON.parse(s.textContent), 0);
    } catch (_) { /* ignore bad JSON */ }
  }

  // 4. Direct links to media files on the page.
  for (const a of document.querySelectorAll('a[href]')) {
    if (/\.(mp4|m4v|webm|mkv|mov|avi|ts|m3u8|mpd)(\?|#|$)/i.test(a.href)) add(a.href, 'link', 800);
  }

  // 5. Embedded players (YouTube, Vimeo, Dailymotion, generic "player"/"embed" iframes).
  for (const f of document.querySelectorAll('iframe[src]')) {
    if (/youtube(-nocookie)?\.com\/embed|youtu\.be|player\.vimeo\.com|dailymotion\.com\/embed|streamable\.com|twitch\.tv|\/embed\/|\/player\//i.test(f.src)) {
      add(f.src, 'embed', 1200);
    }
  }

  // 6. If this is a sub-frame that has a video in it, the frame URL itself is a good candidate
  //    (JDownloader's site plugins usually resolve embed URLs).
  if (!out.top && document.querySelector('video')) add(location.href, 'frame', 900);

  out.candidates.sort((a, b) => b.score - a.score).splice(8);
  return out;
})();
