/* Shared page analysis, injected into pages (and used on fetched / framed documents).
   Defines globalThis.__jdDetect = { detect, findNext, scanHtml }.
   Pure functions of (document, baseUrl): nothing is stored or sent anywhere from here. */
(function () {
  'use strict';
  if (globalThis.__jdDetect) return;

  const MEDIA_FILE = /\.(mp4|m4v|webm|mkv|mov|avi|ts|m3u8|mpd)(\?|#|$)/i;
  const DURATION = /(^|\s)\d{1,2}:\d{2}(:\d{2})?(\s|$)/;
  const VIDEO_SEGMENTS = new Set(['watch', 'video', 'videos', 'vid', 'v', 'embed', 'clip', 'clips', 'shorts', 'reel', 'reels',
    'movie', 'movies', 'player', 'episode', 'episodes']);
  const EMBED_HOSTS = /youtube(-nocookie)?\.com\/embed|youtu\.be|player\.vimeo\.com|dailymotion\.com\/embed|streamable\.com|twitch\.tv|\/embed\/|\/player\//i;
  const PLAYLIST_PARAMS = ['list', 'index', 'start_radio', 'pp', 'playnext', 'feature'];
  const NEXT_TEXT = /^(next|next page|next ›|next »|›|»|>|>>|older|older posts|load more|more|show more)$/i;

  /* querySelectorAll that also looks inside open (and, for extensions, closed) shadow roots,
     because many sites render their result grids inside web components. */
  function deepAll(root, selector, out = [], depth = 0) {
    if (!root || depth > 12) return out;
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      let sr = null;
      try { sr = el.openOrClosedShadowRoot || el.shadowRoot; } catch (_) { sr = null; }
      if (sr) deepAll(sr, selector, out, depth + 1);
    }
    return out;
  }

  function closestAcrossShadow(el, selector) {
    let node = el;
    while (node) {
      if (node.nodeType === 1 && node.matches && node.matches(selector)) return node;
      node = node.parentNode || (node.host ? node.host : null);
      if (node && node.nodeType === 11 && node.host) node = node.host;
    }
    return null;
  }

  function absolute(url, base) {
    try { return new URL(url, base).href; } catch (_) { return null; }
  }

  /* Media URLs that appear anywhere in raw HTML or inline JSON (players often keep them there). */
  function scanHtml(html, base) {
    const out = [];
    if (!html) return out;
    const text = String(html).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/&amp;/g, '&');
    const re = /https?:\/\/[^\s"'<>()\\]+?\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)(?:\?[^\s"'<>()\\]*)?(?=[\s"'<>()\\]|$)/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) && out.length < 40) {
      const u = absolute(m[0], base);
      if (u && !seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
  }

  /* Main analysis: candidates for "the main video" plus "items" = links to individual videos. */
  function detect(doc, baseUrl, isTop, opts = {}) {
    const out = { page: baseUrl, title: (doc && doc.title) || '', top: !!isTop, blob: false, candidates: [], items: [], itemsKind: '' };
    if (!doc) return out;
    const seen = new Set();
    const add = (url, kind, score) => {
      if (!url || typeof url !== 'string') return;
      const abs = absolute(url, baseUrl);
      if (!abs) return;
      if (/^blob:/i.test(abs)) { out.blob = true; return; }
      if (!/^https?:/i.test(abs) || seen.has(abs)) return;
      seen.add(abs);
      out.candidates.push({ url: abs, kind, score });
    };

    // 1. <video> elements: biggest / playing one wins.
    for (const v of deepAll(doc, 'video')) {
      let score = 0;
      try {
        const r = v.getBoundingClientRect();
        score = Math.min(r.width * r.height, 4e6) / 1000;
        if (!v.paused && !v.ended) score += 5000;
        if (v.currentTime > 0) score += 1000;
      } catch (_) { /* detached document */ }
      add(v.currentSrc || v.getAttribute('src'), 'video', score + 500);
      for (const s of v.querySelectorAll('source')) add(s.getAttribute('src'), 'video', score + (/^video\//i.test(s.type) ? 400 : 200));
    }

    // 2. Open Graph / Twitter player metadata.
    for (const sel of ['meta[property="og:video:secure_url"]', 'meta[property="og:video:url"]', 'meta[property="og:video"]',
      'meta[name="twitter:player:stream"]', 'meta[property="twitter:player:stream"]']) {
      for (const m of doc.querySelectorAll(sel)) add(m.getAttribute('content'), 'meta', 3000);
    }

    // 3. JSON-LD VideoObject.
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const walk = (o, depth) => {
          if (!o || typeof o !== 'object' || depth > 6) return;
          if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
          if (/VideoObject/i.test(String(o['@type']))) { add(o.contentUrl, 'jsonld', 2800); add(o.embedUrl, 'embed', 1500); }
          for (const k of ['@graph', 'itemListElement', 'video', 'mainEntity', 'hasPart', 'item']) walk(o[k], depth + 1);
        };
        walk(JSON.parse(s.textContent), 0);
      } catch (_) { /* ignore bad JSON */ }
    }

    // 4. Direct links to media files.
    for (const a of deepAll(doc, 'a[href]')) {
      const href = absolute(a.getAttribute('href'), baseUrl);
      if (href && MEDIA_FILE.test(href)) add(href, 'link', 800);
    }

    // 5. Embedded players.
    for (const f of deepAll(doc, 'iframe[src]')) {
      const src = absolute(f.getAttribute('src'), baseUrl);
      if (src && EMBED_HOSTS.test(src)) add(src, 'embed', 1200);
    }

    // 6. A sub-frame with a video in it: the frame URL itself is a good candidate.
    if (!isTop && deepAll(doc, 'video').length) add(baseUrl, 'frame', 900);

    // 7. Media URLs hidden in the page source (inline player config).
    if (opts.html) for (const u of scanHtml(opts.html, baseUrl)) add(u, 'source', 700);

    out.candidates.sort((a, b) => b.score - a.score).splice(8);
    if (isTop) Object.assign(out, findItems(doc, baseUrl));
    return out;
  }

  /* Group the page's links by URL "shape" and keep the group that looks like a grid of videos. */
  function findItems(doc, baseUrl) {
    const here = String(baseUrl).split('#')[0];
    let hereUrl;
    try { hereUrl = new URL(here); } catch (_) { return { items: [], itemsKind: '' }; }
    const isVideoPath = (u) => u.pathname.split('/').some((s) => VIDEO_SEGMENTS.has(s.toLowerCase())) || u.searchParams.has('v');
    const shapeOf = (u) => {
      const segs = u.pathname.split('/').filter(Boolean).map((s) => {
        if (/^\d+$/.test(s)) return '{n}';
        if (/[0-9]/.test(s) && /^[\w.-]{6,}$/.test(s)) return '{id}';
        if (s.length > 15 && /[-_.]/.test(s)) return '{slug}';
        if (s.length > 20) return '{id}';
        return s.toLowerCase();
      });
      const keys = [...u.searchParams.keys()].filter((k) => !/^(page|p|sort|order|utm_.*|ref|t|start)$/i.test(k)).sort();
      return `${u.host}/${segs.join('/')}?${keys.join('&')}`;
    };
    const groups = new Map();
    for (const a of deepAll(doc, 'a[href]')) {
      if (closestAcrossShadow(a, 'nav, header, footer, [role=navigation]')) continue;
      let u;
      try { u = new URL(a.getAttribute('href'), baseUrl); } catch (_) { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      for (const k of PLAYLIST_PARAMS) u.searchParams.delete(k);
      const url = u.href;
      if (url === here) continue;
      if (/[?&](page|p)=\d+/i.test(u.search) && u.pathname === hereUrl.pathname) continue;   // pagination
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
      if (thumbs < 0.5 && vids < 0.8) continue;   // a plain text link list
      const videoLike = durs > 0.3 || vids > 0.5;
      // A big grid of thumbnails with no video hints still counts, as "links" the user can tick.
      const genericGrid = !videoLike && thumbs >= 0.8 && list.length >= 6;
      if (!videoLike && !genericGrid) continue;
      const score = list.length * (1 + thumbs + 2 * durs + 2 * vids) * (videoLike ? 2 : 1);
      if (!best || score > best.score) best = { score, list, kind: videoLike ? 'video' : 'grid' };
    }
    if (!best) return { items: [], itemsKind: '' };
    return { items: best.list.slice(0, 200).map(({ url, title }) => ({ url, title })), itemsKind: best.kind };
  }

  /* Find the "next page" control. Returns { href } for a real link, { element } for a script button, or null. */
  function findNext(doc, baseUrl) {
    const here = String(baseUrl).split('#')[0];
    const ok = (href) => {
      const abs = absolute(href, baseUrl);
      if (!abs || !/^https?:/i.test(abs)) return null;
      return abs.split('#')[0] === here ? null : abs;
    };
    for (const l of doc.querySelectorAll('link[rel~="next"][href], a[rel~="next"][href]')) {
      const h = ok(l.getAttribute('href'));
      if (h) return { href: h };
    }
    const controls = deepAll(doc, 'a, button, [role="button"]');
    const label = (el) => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
      .map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const looksNext = (el) => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(el.className || '')) return false;
      const labels = label(el);
      if (labels.some((t) => NEXT_TEXT.test(t) || (/\bnext\b/i.test(t) && t.length <= 24))) return true;
      return /(^|[\s_-])(next|pagination-next|page-next)([\s_-]|$)/i.test(`${el.className || ''} ${el.id || ''}`);
    };
    for (const el of controls) {
      if (!looksNext(el)) continue;
      const raw = el.tagName === 'A' ? el.getAttribute('href') : null;
      if (raw && !/^(#|javascript:)/i.test(raw)) {
        const h = ok(raw);
        if (h) return { href: h };
      } else {
        return { element: el };
      }
    }
    // Numbered pagination: a link to page N+1 (?page=N+1, ?p=N+1 or /page/N+1).
    let u;
    try { u = new URL(here); } catch (_) { return null; }
    const cur = Number(u.searchParams.get('page') || u.searchParams.get('p') || (/\/page\/(\d+)/.exec(u.pathname) || [])[1] || 1);
    const want = cur + 1;
    for (const a of deepAll(doc, 'a[href]')) {
      const h = ok(a.getAttribute('href'));
      if (!h) continue;
      const v = new URL(h);
      const n = Number(v.searchParams.get('page') || v.searchParams.get('p') || (/\/page\/(\d+)/.exec(v.pathname) || [])[1]);
      if (n === want && v.pathname.replace(/\/page\/\d+/, '') === u.pathname.replace(/\/page\/\d+/, '')) return { href: h };
    }
    return null;
  }

  globalThis.__jdDetect = { detect, findNext, scanHtml, deepAll };
})();
