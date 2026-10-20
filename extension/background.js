/* Background: owns the settings and talks to JDownloader. */
'use strict';

const { MyJD, MyJDError, makeSecrets, friendly } = globalThis.MyJDClient;

const DEFAULTS = {
  backend: 'myjd',              // 'myjd' | 'cnl'
  myjd: { email: '', loginSecret: '', deviceSecret: '', deviceId: '', deviceName: '' },
  myjdSession: null,            // { sessiontoken, regaintoken }
  cnl: { host: '192.168.0.10', port: 9666 },
  autostart: false,             // false = LinkGrabber (queue), true = start download
  videosOnly: true,             // drop thumbnails/text/pages that come along with a video
  maxPages: 10,                 // how many "next" pages a list collection may follow
  allowFrame: true,             // load a video page in a hidden same-site frame when its source has no video
  packageFromTitle: true,
};

async function getSettings() {
  const stored = await browser.storage.local.get(null);
  return {
    ...DEFAULTS, ...stored,
    myjd: { ...DEFAULTS.myjd, ...(stored.myjd || {}) },
    cnl: { ...DEFAULTS.cnl, ...(stored.cnl || {}) },
  };
}

/* fetch with a timeout, so an unreachable host fails in seconds rather than minutes on mobile */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  return realFetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
};

/* ---------- My.JDownloader backend ---------- */

async function myjdClient(settings) {
  const m = settings.myjd;
  if (!m.email || !m.loginSecret || !m.deviceSecret) {
    throw new Error('My.JDownloader is not set up yet. Open the extension settings.');
  }
  const client = new MyJD(m);
  await client.restore(settings.myjdSession);
  return client;
}

async function withSession(settings, fn) {
  const client = await myjdClient(settings);
  const run = async () => {
    if (!client.session) {
      await client.connect();
      await browser.storage.local.set({ myjdSession: client.session });
    }
    return fn(client);
  };
  try {
    return await run();
  } catch (err) {
    // Session probably stale: reconnect once and retry.
    const retryable = err instanceof MyJDError && (err.src === 'MYJD' || err.status === 403 || err.status === 401 || !err.type);
    if (!retryable) throw err;
    await browser.storage.local.set({ myjdSession: null });
    client.sessiontoken = client.regaintoken = client.serverToken = client.deviceToken = null;
    return run();
  }
}

async function resolveDevice(settings, client) {
  if (settings.myjd.deviceId) return settings.myjd.deviceId;
  const devices = await client.listDevices();
  if (!devices.length) throw new Error('No JDownloader is linked to this My.JDownloader account.');
  const d = devices[0];
  await browser.storage.local.set({ myjd: { ...settings.myjd, deviceId: d.id, deviceName: d.name } });
  return d.id;
}

/* ---------- My.JDownloader sends: add, wait for JDownloader's verdict, tidy up ---------- */

const SMART = { pollMs: 1500, timeoutMs: 60000, perLinkMs: 2000, maxMs: 5 * 60000, ...(globalThis.__SMART_TEST || {}) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateOf = (l) => String(l.availability || l.availableLinkState || 'UNKNOWN').toUpperCase();
const isPending = (l) => /UNKNOWN|UNKOWN/.test(stateOf(l));
const extOf = (l) => { const m = /\.([a-z0-9]{1,11})$/i.exec(String(l.name || '')); return m ? m[1].toLowerCase() : ''; };
const MEDIA_EXT = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ogv', 'ts', 'm2ts', 'mts', 'vob',
  'mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'flac', 'wav']);
const EXTRA_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'txt', 'nfo', 'json', 'xml', 'srt', 'vtt', 'ass',
  'lrc', 'description', 'info', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'url']);
const isMedia = (l) => MEDIA_EXT.has(extOf(l));
const isExtra = (l) => EXTRA_EXT.has(extOf(l));
const isWebPage = (l) => /^(html?|php|aspx?|jsp)$/.test(extOf(l));
const FORMAT_PREF = ['mp4', 'mkv', 'webm', 'mov', 'm4v'];

/* "show.mp4", "show.ogv" and "show_512kb.mp4" are the same video in different formats. */
function videoStem(l) {
  let s = String(l.name || '').toLowerCase().replace(/\.[a-z0-9]{1,11}$/, '');
  for (let i = 0; i < 3; i++) s = s.replace(/[._ -](\d{3,4}p|\d{2,5}kb|h\.?26[45]|hevc|x26[45]|hq|lq|sd|hd|mpeg4|ia|original|source)$/, '');
  return s;
}

function biggest(list) {
  return list.slice().sort((a, b) => (b.bytesTotal || 0) - (a.bytesTotal || 0)
    || FORMAT_PREF.indexOf(extOf(a)) + 1 - (FORMAT_PREF.indexOf(extOf(b)) + 1) || 0)[0];
}

/* Decide what to keep from the links one send produced.
   videosOnly: drop thumbnails/text/pages next to a video, and keep one copy per video when the same
   video arrives in several formats. keepOne: a fallback method that may also have picked up other
   videos from the page (previews, related clips), so keep only the largest video. */
function evaluateLinks(found, { videosOnly = true, removeOffline = true, keepOne = false } = {}) {
  const online = found.filter((l) => stateOf(l) === 'ONLINE');
  const offline = found.filter((l) => stateOf(l) === 'OFFLINE');
  const pending = found.filter(isPending);
  const alive = online.concat(pending);
  const media = alive.filter(isMedia);
  const drop = new Set();
  if (videosOnly && media.length) alive.filter(isExtra).forEach((l) => drop.add(l));
  if (alive.some((x) => !isWebPage(x))) alive.filter(isWebPage).forEach((l) => drop.add(l));
  if (media.length > 1 && (videosOnly || keepOne)) {
    const groups = keepOne ? [media] : Object.values(media.reduce((g, l) => { (g[videoStem(l)] = g[videoStem(l)] || []).push(l); return g; }, {}));
    for (const g of groups) {
      if (g.length < 2) continue;
      const best = biggest(g);
      g.forEach((l) => { if (l !== best) drop.add(l); });
    }
  }
  const kept = alive.filter((l) => !drop.has(l));
  const resolved = kept.some((l) => !isExtra(l) && !isWebPage(l));
  const remove = [...drop].concat(removeOffline ? offline : []);
  return { kept, remove, offline, extras: [...drop], resolved };
}

function fmtSize(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return ` (${n.toFixed(i ? 1 : 0)} ${u[i]})`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function progress(text) {
  try {
    browser.runtime.sendMessage({ type: 'progress', text }).catch(() => { /* popup closed */ });
  } catch (_) { /* no listener context */ }
}

/* Folder names must be valid on Windows and Linux. */
function safeFolderName(name, fallback) {
  const clean = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return clean || fallback;
}

/* Explain an empty result using the crawler's own counters. */
function explainNothing(info) {
  if (info && info.unhandled > 0) return "JDownloader doesn't recognise that link as something it can download, so it added nothing. Try Find the working link, or Queue page URL.";
  if (info && info.filtered > 0) return 'JDownloader found the link but one of your Link Filter rules hid it (JDownloader → Settings → Linkgrabber Filter).';
  if (info && info.broken > 0) return 'JDownloader could not open that link (broken or blocked).';
  if (info && info.crawled > 0) return 'JDownloader found it, but it is already in LinkGrabber or the download list, so nothing new was added.';
  return 'JDownloader added nothing. The link may already be in LinkGrabber or the download list, or JDownloader has no handler for it.';
}

/* opts.mode: 'plain' (Queue buttons), 'find' (page + candidates), 'list' (many videos, own folder).
   Returns { ok, message }; never reports success until JDownloader has shown what it actually added. */
async function trackedQueueViaMyJD(settings, links, packageName, source, opts = {}) {
  const mode = opts.mode || 'plain';
  const removeOffline = mode !== 'plain';
  const videosOnly = settings.videosOnly !== false;
  const target = settings.myjd.deviceName || 'JDownloader';
  progress(`Sending ${plural(links.length, 'link')} to ${target}…`);
  const { client, deviceId, job, folder } = await withSession(settings, async (c) => {
    const id = await resolveDevice(settings, c);
    let destinationFolder = null;
    if (opts.folderName) {
      const base = await c.getDefaultDownloadFolder(id);
      if (typeof base !== 'string' || !base) throw new Error("Could not read JDownloader's download folder.");
      const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
      destinationFolder = base.replace(/[\\/]+$/, '') + sep + opts.folderName;
    }
    const j = await c.addLinks(id, { links, packageName, autostart: false, sourceUrl: source, assignJobID: true, destinationFolder });
    return { client: c, deviceId: id, job: j, folder: destinationFolder };
  });
  const timeoutMs = Math.min(SMART.timeoutMs + links.length * SMART.perLinkMs, SMART.maxMs);
  const jobId = job && job.id;
  if (!jobId) throw new Error('JDownloader did not return a job id. Update JDownloader and try again.');

  // Poll until the crawler has finished and every link has a definite online/offline state.
  const started = Date.now();
  let found = [];
  let info = null;             // last crawler counters seen for this job
  let lastCount = -1;
  let stableRounds = 0;
  let failures = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(SMART.pollMs);
    try {
      found = await client.queryJobLinks(deviceId, jobId);
      let crawlerBusy = null;
      try {
        const jobs = await client.queryCrawlerJobs(deviceId, jobId);
        if (jobs.length) {
          crawlerBusy = jobs.some((j) => j.crawling || j.checking);
          info = jobs.reduce((a, j) => ({
            crawled: a.crawled + (j.crawled || 0), unhandled: a.unhandled + (j.unhandled || 0),
            filtered: a.filtered + (j.filtered || 0), broken: a.broken + (j.broken || 0),
          }), { crawled: 0, unhandled: 0, filtered: 0, broken: 0 });
        } else {
          crawlerBusy = false;   // crawler finished and was discarded
        }
      } catch (_) { /* older JDownloader: fall back to link states only */ }
      failures = 0;
      stableRounds = found.length === lastCount ? stableRounds + 1 : 0;
      lastCount = found.length;
      const pending = found.filter(isPending).length;
      progress(`${target} found ${plural(found.length, 'link')}, ${pending} still being checked…`);
      const crawlerDone = crawlerBusy === null ? stableRounds >= 2 : !crawlerBusy;
      if (crawlerDone && found.length && !pending) break;
      if (crawlerDone && !found.length && stableRounds >= 2) break;
    } catch (e) {
      if (++failures >= 3) throw e;
    }
  }

  if (!found.length) return { ok: false, message: explainNothing(info) };

  const { kept, remove, offline, extras } = evaluateLinks(found, { videosOnly, removeOffline });

  if (remove.length) await client.removeLinks(deviceId, remove.map((l) => l.uuid));
  const startNow = !!(settings.autostart && kept.length);
  if (startNow) await client.moveToDownloadlist(deviceId, kept.map((l) => l.uuid));

  const lines = [];
  if (!kept.length) {
    lines.push(`None of the ${plural(found.length, 'link')} JDownloader found will download${removeOffline ? ', so they were removed' : ''}.`);
    lines.push('The site may need you logged in. Add your account in JDownloader → Settings → Account Manager, or update JDownloader.');
    return { ok: false, message: lines.join('\n') };
  }
  lines.push(`${target}: ${plural(kept.length, 'file')} ${startNow ? 'downloading' : 'in LinkGrabber'}:`);
  for (const l of kept.slice(0, 5)) lines.push(`• ${l.name || l.url}${fmtSize(l.bytesTotal)}${isPending(l) ? ' (still checking)' : ''}`);
  if (kept.length > 5) lines.push(`• …and ${kept.length - 5} more`);
  const removedBits = [];
  if (removeOffline && offline.length) removedBits.push(`${offline.length} offline`);
  if (extras.length) removedBits.push(`${plural(extras.length, 'extra')} (thumbnails, text, pages or duplicate formats)`);
  if (removedBits.length) lines.push(`Removed ${removedBits.join(' and ')}.`);
  if (!removeOffline && offline.length) lines.push(`${plural(offline.length, 'link')} came back offline and ${offline.length === 1 ? 'is' : 'are'} still in LinkGrabber.`);
  if (folder) lines.push(`Folder: ${folder}`);
  return { ok: true, message: lines.join('\n') };
}

/* ---------- Local Click'n'Load backend (port 9666) ---------- */

function cnlBase(cnl) {
  const host = String(cnl.host || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `http://${host}:${Number(cnl.port) || 9666}`;
}

async function queueViaCNL(settings, links, packageName, source) {
  const body = new URLSearchParams();
  body.set('urls', links.join('\r\n'));
  if (source) body.set('source', source);
  if (packageName) body.set('package', packageName);
  if (settings.autostart) body.set('autostart', '1');
  let res;
  try {
    res = await fetch(`${cnlBase(settings.cnl)}/flash/add`, { method: 'POST', body });
  } catch (e) {
    throw new Error(`Could not reach JDownloader at ${cnlBase(settings.cnl)}. Is the PC on, on the same network, and is "localhost only" disabled in JDownloader?`);
  }
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`JDownloader answered HTTP ${res.status}: ${text.slice(0, 120)}`);
  return `Sent ${links.length} link${links.length === 1 ? '' : 's'} to JDownloader at ${settings.cnl.host}.`;
}

async function testCNL(cnl) {
  try {
    const res = await fetch(`${cnlBase(cnl)}/jdcheck.js`);
    const text = await res.text();
    if (/jdownloader\s*=\s*true/i.test(text)) return { ok: true, message: `JDownloader found at ${cnlBase(cnl)}.` };
    return { ok: false, message: `Something answered at ${cnlBase(cnl)} but it does not look like JDownloader.` };
  } catch (e) {
    return { ok: false, message: `Nothing reachable at ${cnlBase(cnl)}.` };
  }
}

/* ---------- Privacy ----------
   Nothing about pages, sites or files is ever written to storage or logged. The last result is
   kept in memory only, so the popup can show it if it was closed during a check, and is wiped
   after 10 minutes or when Firefox closes. */

let lastResult = null;
let lastResultTimer = null;

function rememberInMemory(page, result) {
  lastResult = { page: page || '', ok: result.ok, message: result.message };
  clearTimeout(lastResultTimer);
  lastResultTimer = setTimeout(() => { lastResult = null; }, 10 * 60 * 1000);
}

// Version 1.0.3 wrote the last result to disk. Remove it on every start.
browser.storage.local.remove('lastResult').catch(() => {});

/* ---------- Message handlers ---------- */

const handlers = {
  async getSettings() { return getSettings(); },

  async getLastResult(msg) {
    return lastResult && lastResult.page === msg.page ? { ok: lastResult.ok, message: lastResult.message } : null;
  },

  async saveSettings(msg) {
    await browser.storage.local.set(msg.settings);
    return { ok: true };
  },

  /* Options page: derive secrets from email+password, connect, list devices. Password is discarded. */
  async myjdSetup(msg) {
    const secrets = await makeSecrets(msg.email, msg.password);
    const client = new MyJD(secrets);
    await client.connect();
    const devices = await client.listDevices();
    const settings = await getSettings();
    const keep = devices.find((d) => d.id === settings.myjd.deviceId);
    const chosen = keep || devices[0] || null;
    await browser.storage.local.set({
      backend: 'myjd',
      myjd: { ...secrets, deviceId: chosen ? chosen.id : '', deviceName: chosen ? chosen.name : '' },
      myjdSession: client.session,
    });
    return { ok: true, devices, deviceId: chosen ? chosen.id : '' };
  },

  async myjdDevices() {
    const settings = await getSettings();
    const devices = await withSession(settings, (client) => client.listDevices());
    return { ok: true, devices };
  },

  async cnlTest(msg) { return testCNL(msg.cnl); },

  async queue(msg) {
    const settings = await getSettings();
    const links = [...new Set((msg.links || []).filter((u) => /^(directhttp:\/\/)?https?:\/\//i.test(u)))];
    if (!links.length) throw new Error('Nothing to send.');
    const packageName = settings.packageFromTitle && msg.packageName ? String(msg.packageName).slice(0, 120) : null;
    if (settings.backend === 'cnl') return { ok: true, message: await queueViaCNL(settings, links, packageName, msg.source) };
    return trackedQueueViaMyJD(settings, links, packageName, msg.source, { mode: 'plain' });
  },

  /* msg.mode: 'find' (default) = page + video candidates, keep what works.
              'list' = many individual videos, into their own folder. */
  async smartQueue(msg) {
    const settings = await getSettings();
    const list = msg.mode === 'list';
    const links = [...new Set((msg.links || []).filter((u) => /^(directhttp:\/\/)?https?:\/\//i.test(u)))].slice(0, list ? 200 : 12);
    if (!links.length) throw new Error('Nothing to send.');
    let packageName = settings.packageFromTitle && msg.packageName ? String(msg.packageName).slice(0, 120) : null;
    let folderName = null;
    if (list) {
      let host = 'videos';
      try { host = new URL(msg.source).hostname.replace(/^www\./, ''); } catch (_) { /* keep default */ }
      folderName = safeFolderName(msg.packageName, `${host} ${new Date().toISOString().slice(0, 10)}`);
      packageName = folderName;
    }
    if (settings.backend !== 'myjd') {
      if (!list) throw new Error('Finding the working link needs the My.JDownloader connection.');
      // Click'n'Load can't check links or choose a folder: send them as one named package.
      const sent = await queueViaCNL(settings, links, packageName, msg.source);
      return { ok: true, message: `${sent}\nClick'n'Load can't set a folder or remove broken links. Switch to My.JDownloader for that.` };
    }
    let result;
    try {
      result = await trackedQueueViaMyJD(settings, links, packageName, msg.source, { mode: list ? 'list' : 'find', folderName });
    } catch (err) {
      result = { ok: false, message: friendly(err) };
    }
    rememberInMemory(msg.source, result);
    return result;
  },
};

browser.runtime.onMessage.addListener((msg, sender) => {
  const h = handlers[msg && msg.type];
  if (!h) return Promise.resolve({ ok: false, message: `Unknown message ${msg && msg.type}` });
  return h(msg, sender).catch((err) => ({ ok: false, message: friendly(err), detail: err && err.detail }));
});
