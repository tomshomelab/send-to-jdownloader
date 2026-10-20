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

  // 7. Pages that list many videos (galleries, channels, search results, playlists).
  //    Group same-site links by URL "shape" and keep the shape that looks like a video grid:
  //    many links with thumbnails, durations or video-ish paths.
  out.items = [];
  if (out.top) {
    const here = location.href.split('#')[0];
    // Whole path segments only, so a slug like "my-blog-post-title" doesn't count.
    const VIDEO_SEGMENTS = new Set(['watch', 'video', 'videos', 'vid', 'v', 'embed', 'clip', 'clips', 'shorts', 'reel', 'reels', 'movie', 'movies', 'player', 'episode', 'episodes']);
    const isVideoPath = (u) => u.pathname.split('/').some((s) => VIDEO_SEGMENTS.has(s.toLowerCase())) || u.searchParams.has('v');
    const MEDIA_FILE = /\.(mp4|m4v|webm|mkv|mov|avi|m3u8|mpd)(\?|#|$)/i;
    const DURATION = /(^|\s)\d{1,2}:\d{2}(:\d{2})?(\s|$)/;
    const shapeOf = (u) => {
      const segs = u.pathname.split('/').filter(Boolean).map((s) => {
        if (/^\d+$/.test(s)) return '{n}';
        if (/[0-9]/.test(s) && /^[\w-]{6,}$/.test(s)) return '{id}';
        if (s.length > 15 && s.includes('-')) return '{slug}';
        return s.toLowerCase();
      });
      const keys = [...u.searchParams.keys()].filter((k) => !/^(page|p|sort|order|utm_.*|ref|t|start)$/i.test(k)).sort();
      return `${u.host}/${segs.join('/')}?${keys.join('&')}`;
    };
    const groups = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest('nav, header, footer, [role=navigation]')) continue;
      let u;
      try { u = new URL(a.href, location.href); } catch (_) { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      // Each entry must mean exactly one video: drop playlist/position parameters,
      // otherwise JDownloader may expand every link into the whole playlist.
      for (const k of ['list', 'index', 'start_radio', 'pp', 'playnext', 'feature']) u.searchParams.delete(k);
      const url = u.href;
      if (url === here) continue;
      if (/[?&](page|p)=\d+/i.test(u.search) && u.pathname === location.pathname) continue;   // pagination
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const img = a.querySelector('img, picture, video, [style*="background-image"]');
      const sig = {
        thumb: !!img || /background-image/.test(a.getAttribute('style') || ''),
        duration: DURATION.test(text) || !!a.querySelector('[class*="duration" i], [class*="time" i]'),
        videoPath: isVideoPath(u) || MEDIA_FILE.test(url),
      };
      const shape = shapeOf(u);
      if (!groups.has(shape)) groups.set(shape, new Map());
      const g = groups.get(shape);
      const prev = g.get(url);
      const title = (a.getAttribute('title') || a.getAttribute('aria-label') || (img && img.getAttribute && img.getAttribute('alt')) || text.replace(DURATION, ' '))
        .replace(/\s+/g, ' ').trim().slice(0, 120);
      if (prev) {
        prev.thumb = prev.thumb || sig.thumb;
        prev.duration = prev.duration || sig.duration;
        if (!prev.title && title) prev.title = title;
      } else {
        g.set(url, { url, title, ...sig });
      }
    }
    let best = null;
    for (const g of groups.values()) {
      const list = [...g.values()];
      if (list.length < 3) continue;
      const thumbs = list.filter((x) => x.thumb).length / list.length;
      const durs = list.filter((x) => x.duration).length / list.length;
      const vids = list.filter((x) => x.videoPath).length / list.length;
      if (thumbs < 0.5 && vids < 0.8) continue;   // a plain text link list, not a video grid
      const score = list.length * (1 + thumbs + 2 * durs + 2 * vids);
      if (!best || score > best.score) best = { score, list, durs, vids };
    }
    if (best && (best.durs > 0.3 || best.vids > 0.5)) {
      out.items = best.list.slice(0, 200).map(({ url, title }) => ({ url, title }));
    }
  }
  return out;
})();
