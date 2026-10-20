/* Video-list sessions (background). Loaded after background.js and shares its helpers.

   A session is the list of individual videos collected from a page (and its next pages).
   For each video it records what the phone found on the video's own page ("gather") and how it
   finally reached JDownloader ("send"), so the popup can show a report and the list survives
   closing and reopening the popup.

   PRIVACY: sessions live in memory only. Nothing here touches browser.storage or any log; the
   session is wiped after 60 minutes unused, by "Clear list", or when Firefox closes.

   Send order for each ticked video:
     1. site     - JDownloader's own handler for the video page            (native)
     2. deep     - JDownloader's deep link analysis of the video page      (native)
     3. phone    - video links the phone found on the page: page fetch, then hidden player frame */
'use strict';

const SESSION_IDLE_MS = 60 * 60 * 1000;
const GATHER_CONCURRENCY = 2;
let listSession = null;
let sessionTimer = null;
let broadcastTimer = null;
let stopRequested = false;

const METHOD_LABEL = {
  site: "JDownloader's site handler",
  deep: "JDownloader's deep analysis",
  fetch: 'link found by the phone (page fetch)',
  frame: 'link found by the phone (player frame)',
};

function touchSession() {
  if (!listSession) return;
  listSession.updatedAt = Date.now();
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { listSession = null; broadcastSession(); }, SESSION_IDLE_MS);
}

function broadcastSession() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    try { browser.runtime.sendMessage({ type: 'session-updated' }).catch(() => {}); } catch (_) { /* no listener */ }
  }, 120);
}

function sessionProgress(text) {
  if (!listSession) return;
  listSession.progress = text;
  broadcastSession();
}

const cloneSession = () => (listSession ? JSON.parse(JSON.stringify(listSession)) : null);
const selectedItems = () => (listSession ? listSession.items.filter((i) => i.selected) : []);

/* Same idea as the popup's forJD: force direct file links through JDownloader's DirectHTTP. */
function jdLinkFor(c) {
  const direct = ['video', 'link', 'jsonld', 'meta', 'source'].includes(c.kind)
    && !/\.(m3u8|mpd)(\?|#|$)/i.test(c.url)
    && !/\/(embed|player|iframe)(\/|\?|$)/i.test(c.url);
  return direct ? `directhttp://${c.url}` : c.url;
}

/* ---------- talking to the list tab ---------- */

async function listTabReady() {
  if (!listSession) throw new Error('No list.');
  let tab;
  try { tab = await browser.tabs.get(listSession.tabId); } catch (_) { tab = null; }
  if (!tab) throw new Error('The tab with the list was closed. Open the list page again to gather or collect.');
  let origin = '';
  try { origin = new URL(tab.url).origin; } catch (_) { origin = ''; }
  if (origin !== listSession.origin) throw new Error('The tab with the list has moved to another site. Go back to the list page to gather or collect.');
  await browser.tabs.executeScript(listSession.tabId, { file: 'detect.js', runAt: 'document_idle' });
  await browser.tabs.executeScript(listSession.tabId, { file: 'gather.js', runAt: 'document_idle' });
  return listSession.tabId;
}

const tabCall = (tabId, fn, extra = {}) => browser.tabs.sendMessage(tabId, { type: '__jd-gather', fn, ...extra }, { frameId: 0 });

async function gatherItems(items, settings) {
  const tabId = await listTabReady();
  const opts = { allowFrame: settings.allowFrame !== false, settleMs: 6000 };
  let done = 0;
  const queue = items.slice();
  const worker = async () => {
    while (queue.length && !stopRequested) {
      const item = queue.shift();
      sessionProgress(`Looking inside video pages on the phone… ${done + 1} of ${items.length}`);
      try {
        const r = await tabCall(tabId, 'resolveItem', { url: item.url, opts });
        item.gather = r && r.candidates && r.candidates.length
          ? { status: 'found', method: r.method, candidates: r.candidates, note: '' }
          : { status: 'none', method: '', candidates: [], note: (r && r.note) || 'nothing found' };
      } catch (_) {
        item.gather = { status: 'error', method: '', candidates: [], note: 'the list tab stopped responding' };
      }
      done += 1;
      touchSession();
      broadcastSession();
    }
  };
  await Promise.all(Array.from({ length: Math.min(GATHER_CONCURRENCY, items.length) }, worker));
}

/* ---------- JDownloader stages ---------- */

async function waitForJobs(client, deviceId, jobIds, label) {
  const started = Date.now();
  const timeoutMs = Math.min(SMART.timeoutMs + jobIds.length * SMART.perLinkMs, SMART.maxMs);
  let links = [];
  let infoByJob = new Map();
  let lastCount = -1;
  let stable = 0;
  let failures = 0;
  while (Date.now() - started < timeoutMs && !stopRequested) {
    await sleep(SMART.pollMs);
    try {
      links = await client.queryJobLinks(deviceId, jobIds);
      let busy = null;
      try {
        const jobs = await client.queryCrawlerJobs(deviceId, jobIds);
        busy = jobs.some((j) => j.crawling || j.checking);
        for (const j of jobs) infoByJob.set(j.jobId, j);
      } catch (_) { /* older JDownloader */ }
      failures = 0;
      stable = links.length === lastCount ? stable + 1 : 0;
      lastCount = links.length;
      const pending = links.filter(isPending).length;
      sessionProgress(`${label}: JDownloader found ${plural(links.length, 'link')}, ${pending} still being checked…`);
      const done = busy === null ? stable >= 2 : !busy;
      if (done && !pending && (links.length || stable >= 2)) break;
    } catch (e) {
      if (++failures >= 3) throw e;
    }
  }
  const byJob = new Map(jobIds.map((id) => [id, []]));
  for (const l of links) if (byJob.has(l.jobUUID)) byJob.get(l.jobUUID).push(l);
  return { byJob, infoByJob };
}

async function runStage(ctx, stage, items) {
  const { client, deviceId, destinationFolder, settings } = ctx;
  const label = { site: 'Step 1, site handler', deep: 'Step 2, deep analysis', phone: 'Step 3, phone links' }[stage];
  const jobOf = new Map();
  let n = 0;
  for (const item of items) {
    if (stopRequested) break;
    n += 1;
    sessionProgress(`${label}: sending ${n} of ${items.length}…`);
    let links = [item.url];
    if (stage === 'phone') links = item.gather.candidates.slice(0, 3).map(jdLinkFor);
    const job = await client.addLinks(deviceId, {
      links, packageName: listSession.folderName, destinationFolder, sourceUrl: item.url,
      assignJobID: true, autostart: false, deepDecrypt: stage === 'deep',
    });
    if (job && job.id) jobOf.set(job.id, item);
  }
  if (!jobOf.size) return { resolved: [], unresolved: items };
  const { byJob, infoByJob } = await waitForJobs(client, deviceId, [...jobOf.keys()], label);
  const resolved = [];
  const unresolved = [];
  const removeIds = [];
  for (const [jobId, item] of jobOf) {
    const found = byJob.get(jobId) || [];
    const info = infoByJob.get(jobId) || {};
    const ev = evaluateLinks(found, { videosOnly: settings.videosOnly !== false, removeOffline: true, keepOne: stage !== 'site' });
    if (ev.resolved) {
      ev.remove.forEach((l) => removeIds.push(l.uuid));
      item.send = {
        status: 'queued', method: stage === 'phone' ? (item.gather.method || 'fetch') : stage,
        files: ev.kept.map((l) => ({ name: l.name || '', size: l.bytesTotal || 0 })), note: '',
        linkIds: ev.kept.map((l) => l.uuid),
      };
      resolved.push(item);
    } else {
      found.forEach((l) => removeIds.push(l.uuid));   // junk from a failed attempt
      const dup = !found.length && info.crawled > 0 && !info.unhandled && !info.filtered;
      if (dup && stage === 'site') {
        item.send = { status: 'duplicate', method: 'site', files: [], note: 'already in JDownloader', linkIds: [] };
        resolved.push(item);
      } else {
        item.send = { status: 'failed', method: stage, files: [], note: found.length ? 'only offline or non-video results' : explainNothing(info), linkIds: [] };
        unresolved.push(item);
      }
    }
  }
  if (removeIds.length) await client.removeLinks(deviceId, removeIds);
  touchSession();
  broadcastSession();
  return { resolved, unresolved };
}

async function sendList(settings) {
  const items = selectedItems().filter((i) => !i.send || i.send.status === 'failed');
  if (!items.length) throw new Error('Tick at least one video that has not been sent yet.');
  stopRequested = false;

  if (settings.backend !== 'myjd') {
    const sent = await queueViaCNL(settings, items.map((i) => i.url), listSession.folderName, listSession.page);
    items.forEach((i) => { i.send = { status: 'queued', method: 'site', files: [], note: 'sent unchecked (Click\'n\'Load)', linkIds: [] }; });
    return `${sent}\nClick'n'Load can't check links, set a folder or use the fallbacks. Switch to My.JDownloader for that.`;
  }

  const ctx = await withSession(settings, async (client) => {
    const deviceId = await resolveDevice(settings, client);
    const base = await client.getDefaultDownloadFolder(deviceId);
    if (typeof base !== 'string' || !base) throw new Error("Could not read JDownloader's download folder.");
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    return { client, deviceId, settings, destinationFolder: base.replace(/[\\/]+$/, '') + sep + listSession.folderName };
  });
  listSession.folder = ctx.destinationFolder;

  // 1 and 2: JDownloader natively.
  let remaining = (await runStage(ctx, 'site', items)).unresolved;
  if (remaining.length && !stopRequested) remaining = (await runStage(ctx, 'deep', remaining)).unresolved;

  // 3: links found by the phone (gather the ones not gathered yet).
  if (remaining.length && !stopRequested) {
    const needGather = remaining.filter((i) => !i.gather);
    if (needGather.length) {
      try { await gatherItems(needGather, settings); } catch (e) {
        needGather.forEach((i) => { i.gather = { status: 'error', method: '', candidates: [], note: e.message }; });
      }
    }
    const withLinks = remaining.filter((i) => i.gather && i.gather.status === 'found');
    remaining.filter((i) => !withLinks.includes(i)).forEach((i) => {
      i.send = { status: 'failed', method: 'phone', files: [], note: (i.gather && i.gather.note) || 'no video link found', linkIds: [] };
    });
    if (withLinks.length && !stopRequested) await runStage(ctx, 'phone', withLinks);
  }

  // Start downloading if that is the setting.
  if (settings.autostart) {
    const ids = items.filter((i) => i.send && i.send.status === 'queued').flatMap((i) => i.send.linkIds);
    if (ids.length) await ctx.client.moveToDownloadlist(ctx.deviceId, ids);
  }
  return buildReport(items, settings);
}

function buildReport(items, settings) {
  const by = (pred) => items.filter(pred).length;
  const queued = items.filter((i) => i.send && i.send.status === 'queued');
  const r = {
    total: items.length,
    queued: queued.length,
    duplicate: by((i) => i.send && i.send.status === 'duplicate'),
    failed: by((i) => !i.send || i.send.status === 'failed'),
    byMethod: {},
    stopped: stopRequested,
    where: settings.autostart ? 'downloading' : 'in LinkGrabber',
  };
  for (const i of queued) r.byMethod[i.send.method] = (r.byMethod[i.send.method] || 0) + 1;
  listSession.report = r;
  const parts = Object.entries(r.byMethod).map(([m, n]) => `${n} via ${METHOD_LABEL[m] || m}`);
  const lines = [`${r.queued} of ${r.total} videos ${r.where}${parts.length ? ` (${parts.join(', ')})` : ''}.`];
  if (r.duplicate) lines.push(`${r.duplicate} already in JDownloader.`);
  if (r.failed) lines.push(`${r.failed} could not be found by any method. See the list for why.`);
  if (listSession.folder) lines.push(`Folder: ${listSession.folder}`);
  if (r.stopped) lines.push('Stopped before finishing.');
  return lines.join('\n');
}

/* ---------- message handlers ---------- */

async function exclusive(kind, fn) {
  if (!listSession) throw new Error('No list. Open a page with videos listed on it first.');
  if (listSession.running) throw new Error('Something is already running for this list.');
  listSession.running = kind;
  stopRequested = false;
  broadcastSession();
  try {
    const message = await fn();
    listSession.lastMessage = { ok: true, text: message };
    return { ok: true, message };
  } catch (err) {
    const message = friendly(err);
    if (listSession) listSession.lastMessage = { ok: false, text: message };
    return { ok: false, message };
  } finally {
    if (listSession) { listSession.running = null; listSession.progress = ''; touchSession(); }
    broadcastSession();
  }
}

Object.assign(handlers, {
  async getSession() { return cloneSession(); },

  async startSession(msg) {
    if (listSession && listSession.running) return { ok: false, message: 'Something is still running for the current list.' };
    let origin = '';
    let host = 'videos';
    try { const u = new URL(msg.page); origin = u.origin; host = u.hostname.replace(/^www\./, ''); } catch (_) { /* keep defaults */ }
    const selected = !!msg.preselect;
    listSession = {
      tabId: msg.tabId, page: msg.page, origin, title: msg.title || '',
      folderName: safeFolderName(msg.title, `${host} ${new Date().toISOString().slice(0, 10)}`),
      items: (msg.items || []).slice(0, 1000).map((i) => ({ url: i.url, title: i.title || '', page: 1, selected, gather: null, send: null })),
      pages: 1, pagesNote: '', running: null, progress: '', report: null, lastMessage: null, folder: '',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    touchSession();
    broadcastSession();
    return { ok: true };
  },

  async clearSession() {
    if (listSession && listSession.running) stopRequested = true;
    listSession = null;
    clearTimeout(sessionTimer);
    broadcastSession();
    return { ok: true };
  },

  async selectItems(msg) {
    if (!listSession) return { ok: false };
    const urls = msg.urls ? new Set(msg.urls) : null;
    for (const i of listSession.items) if (!urls || urls.has(i.url)) i.selected = !!msg.selected;
    touchSession();
    broadcastSession();
    return { ok: true };
  },

  async stopRun() {
    stopRequested = true;
    if (listSession) {
      try { await tabCall(listSession.tabId, 'stop'); } catch (_) { /* tab gone */ }
    }
    return { ok: true };
  },

  async collectPages() {
    const settings = await getSettings();
    return exclusive('collect', async () => {
      const tabId = await listTabReady();
      sessionProgress('Looking for the next page…');
      const before = listSession.items.length;
      const r = await tabCall(tabId, 'collectPages', { opts: { maxPages: settings.maxPages, allowFrame: settings.allowFrame !== false, known: listSession.items.map((i) => i.url) } });
      const added = listSession.items.length - before;
      listSession.pagesNote = (r && r.reason) || '';
      return `Collected ${plural(added, 'more video')} from ${plural(Math.max(0, ((r && r.pages) || 1) - 1), 'more page')}${r && r.reason ? `. Stopped because ${r.reason}` : ''}.`;
    });
  },

  /* Items reported page by page by gather.js while collectPages runs. */
  async 'gather-page'(msg, sender) {
    if (!listSession || !sender || !sender.tab || sender.tab.id !== listSession.tabId) return { ok: false };
    const known = new Set(listSession.items.map((i) => i.url));
    const selected = listSession.items.length ? listSession.items.every((i) => i.selected) : true;
    for (const i of msg.items || []) {
      if (known.has(i.url) || listSession.items.length >= 1000) continue;
      listSession.items.push({ url: i.url, title: i.title || '', page: msg.page, selected, gather: null, send: null });
    }
    listSession.pages = Math.max(listSession.pages, msg.page || 1);
    sessionProgress(`Collected page ${msg.page}: ${plural(listSession.items.length, 'video')} so far…`);
    touchSession();
    return { ok: true };
  },

  async gatherSession() {
    const settings = await getSettings();
    return exclusive('gather', async () => {
      const items = selectedItems();
      if (!items.length) throw new Error('Tick at least one video first.');
      await gatherItems(items, settings);
      const found = items.filter((i) => i.gather && i.gather.status === 'found');
      const byFrame = found.filter((i) => i.gather.method === 'frame').length;
      return `The phone found video links for ${found.length} of ${items.length}${byFrame ? ` (${byFrame} needed the player frame)` : ''}.${found.length < items.length ? ' JDownloader may still manage the rest when you send.' : ''}`;
    });
  },

  async sendSession() {
    const settings = await getSettings();
    return exclusive('send', () => sendList(settings));
  },
});
