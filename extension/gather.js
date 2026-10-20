/* Injected (after detect.js) into the top frame of the tab that holds a video list.
   The background asks it, via tabs.sendMessage, to:
     resolveItem(url)  - find video links on one video page:
                         1) fetch the page as the page itself would (your private session),
                         2) if that finds nothing, load it in a hidden same-site frame so its player runs.
     collectPages()    - follow "next page" links/buttons and report new list items page by page.
   Runs inside your private tab; nothing is stored, results go straight back to the extension. */
(function () {
  'use strict';
  if (globalThis.__jdGather) return;
  const D = globalThis.__jdDetect;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stopFlag = false;

  // Firefox: content.fetch() sends the request as the page would, with the page's (private) cookies.
  const pageFetch = (url, init) => (typeof content !== 'undefined' && content && typeof content.fetch === 'function'
    ? content.fetch(url, init)
    : fetch(url, init));

  async function fetchDoc(url) {
    const res = await pageFetch(url, { credentials: 'include', redirect: 'follow' });
    const finalUrl = res.url || url;
    const type = String(res.headers.get('content-type') || '');
    if (!res.ok) return { ok: false, note: `page answered ${res.status}` };
    if (/^(video|audio)\/|mpegurl|octet-stream/i.test(type)) return { ok: false, direct: true, url: finalUrl };
    if (!/html|xml/i.test(type)) return { ok: false, note: 'not a web page' };
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = doc.createElement('base');
    base.setAttribute('href', finalUrl);
    (doc.head || doc.documentElement).prepend(base);
    return { ok: true, doc, html, url: finalUrl };
  }

  /* Load a same-site page in an invisible frame so its scripts and player run. */
  async function renderFrame(url, settleMs) {
    let target;
    try { target = new URL(url, location.href); } catch (_) { return { ok: false, note: 'bad address' }; }
    if (target.origin !== location.origin) return { ok: false, note: 'on another site, so it cannot be loaded in a frame' };
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('tabindex', '-1');
    f.setAttribute('allow', "autoplay 'none'");
    f.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:720px;opacity:0;pointer-events:none;border:0;';
    const loaded = new Promise((res) => {
      const t = setTimeout(res, 20000);
      f.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
    });
    f.src = target.href;
    (document.body || document.documentElement).appendChild(f);
    await loaded;
    await sleep(settleMs);
    let doc = null;
    let finalUrl = target.href;
    try {
      doc = f.contentDocument;
      finalUrl = f.contentWindow.location.href;
    } catch (_) { doc = null; }
    if (!doc || finalUrl === 'about:blank') {
      f.remove();
      return { ok: false, note: 'the site refused to load in a frame' };
    }
    for (const v of D.deepAll(doc, 'video')) { try { v.muted = true; v.pause(); } catch (_) { /* ignore */ } }
    return { ok: true, doc, url: finalUrl, cleanup: () => f.remove() };
  }

  const plainCandidates = (list) => list.filter((c) => c.kind !== 'frame').slice(0, 6).map(({ url, kind, score }) => ({ url, kind, score }));

  async function resolveItem(url, opts = {}) {
    const r = { url, candidates: [], method: '', note: '' };
    try {
      const f = await fetchDoc(url);
      if (f.direct) return { ...r, candidates: [{ url: f.url, kind: 'link', score: 900 }], method: 'fetch' };
      if (f.ok) {
        const d = D.detect(f.doc, f.url, true, { html: f.html });
        r.candidates = plainCandidates(d.candidates);
        if (r.candidates.length) return { ...r, method: 'fetch' };
        r.note = 'no video in the page source';
      } else {
        r.note = f.note;
      }
    } catch (_) {
      r.note = 'the page could not be fetched';
    }
    if (opts.allowFrame && !stopFlag) {
      const fr = await renderFrame(url, opts.settleMs || 6000);
      if (fr.ok) {
        try {
          const d = D.detect(fr.doc, fr.url, true, { html: fr.doc.documentElement ? fr.doc.documentElement.outerHTML : '' });
          r.candidates = plainCandidates(d.candidates);
          if (r.candidates.length) return { ...r, method: 'frame', note: '' };
          r.note = 'no video even after loading the player';
        } finally {
          fr.cleanup();
        }
      } else {
        r.note = `${r.note}; ${fr.note}`;
      }
    }
    return r;
  }

  const itemKey = (items) => items.map((i) => i.url).join('\n');

  /* Walk the pagination. Each page's new items are sent to the background as they arrive,
     so nothing is lost if the page navigates away mid-way. */
  async function collectPages(opts = {}) {
    stopFlag = false;
    const maxPages = Math.max(1, Math.min(Number(opts.maxPages) || 10, 50));
    const seen = new Set(opts.known || []);
    for (const i of D.detect(document, location.href, true).items) seen.add(i.url);
    let ctx = { doc: document, url: location.href, live: true, cleanup: null };
    let pages = 1;
    let reason = '';
    while (pages < maxPages) {
      if (stopFlag) { reason = 'stopped'; break; }
      let next = D.findNext(ctx.doc, ctx.url);
      // A script-driven "next" button inside a fetched (not rendered) page: render it first.
      if (next && next.element && !ctx.live) {
        const fr = await renderFrame(ctx.url, 3000);
        if (!fr.ok) { reason = 'the next button needs the page to run, and it could not be loaded'; break; }
        if (ctx.cleanup) ctx.cleanup();
        ctx = { doc: fr.doc, url: fr.url, live: true, cleanup: fr.cleanup };
        next = D.findNext(ctx.doc, ctx.url);
      }
      if (!next) { reason = 'no next page found'; break; }

      let found = null;
      if (next.href) {
        let fetched = null;
        try { fetched = await fetchDoc(next.href); } catch (_) { fetched = null; }
        if (fetched && fetched.ok) {
          const items = D.detect(fetched.doc, fetched.url, true).items;
          if (items.length) found = { items, ctx: { doc: fetched.doc, url: fetched.url, live: false, cleanup: null } };
        }
        if (!found && opts.allowFrame) {
          const fr = await renderFrame(next.href, 3500);
          if (fr.ok) found = { items: D.detect(fr.doc, fr.url, true).items, ctx: { doc: fr.doc, url: fr.url, live: true, cleanup: fr.cleanup } };
        }
        if (!found) { reason = 'the next page had no list the extension could read'; break; }
      } else {
        // Click the button where it is and wait for the list to change.
        const doc = ctx.doc;
        const winUrl = () => { try { return doc.defaultView.location.href; } catch (_) { return ctx.url; } };
        const before = itemKey(D.detect(doc, winUrl(), true).items);
        try { next.element.click(); } catch (_) { reason = 'the next button could not be pressed'; break; }
        let items = [];
        for (let t = 0; t < 24; t++) {
          await sleep(500);
          items = D.detect(doc, winUrl(), true).items;
          if (items.length && itemKey(items) !== before) break;
        }
        found = { items, ctx: { ...ctx, url: winUrl() } };
      }

      const fresh = found.items.filter((i) => !seen.has(i.url));
      if (ctx.cleanup && found.ctx.cleanup !== ctx.cleanup) ctx.cleanup();
      ctx = found.ctx;
      if (!fresh.length) { reason = 'the next page repeated items already collected'; break; }
      fresh.forEach((i) => seen.add(i.url));
      pages += 1;
      try { await browser.runtime.sendMessage({ type: 'gather-page', page: pages, items: fresh }); } catch (_) { /* ignore */ }
    }
    if (!reason && pages >= maxPages) reason = `reached the ${maxPages}-page limit`;
    if (ctx.cleanup) ctx.cleanup();
    return { pages, reason };
  }

  globalThis.__jdGather = { resolveItem, collectPages, stop: () => { stopFlag = true; } };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== '__jd-gather') return undefined;
    if (msg.fn === 'stop') { stopFlag = true; return Promise.resolve(true); }
    if (msg.fn === 'resolveItem') return resolveItem(msg.url, msg.opts || {});
    if (msg.fn === 'collectPages') return collectPages(msg.opts || {});
    if (msg.fn === 'ping') return Promise.resolve({ origin: location.origin });
    return undefined;
  });
})();
