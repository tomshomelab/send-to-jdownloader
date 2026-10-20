/* Background: owns the settings and talks to JDownloader. */
'use strict';

const { MyJD, MyJDError, makeSecrets, friendly } = globalThis.MyJDClient;

const DEFAULTS = {
  backend: 'myjd',              // 'myjd' | 'cnl'
  myjd: { email: '', loginSecret: '', deviceSecret: '', deviceId: '', deviceName: '' },
  myjdSession: null,            // { sessiontoken, regaintoken }
  cnl: { host: '192.168.0.10', port: 9666 },
  autostart: false,             // false = LinkGrabber (queue), true = start download
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

async function queueViaMyJD(settings, links, packageName, source) {
  return withSession(settings, async (client) => {
    const deviceId = await resolveDevice(settings, client);
    await client.addLinks(deviceId, { links, packageName, autostart: settings.autostart, sourceUrl: source });
    const where = settings.autostart ? 'downloads' : 'LinkGrabber';
    return `Sent ${links.length} link${links.length === 1 ? '' : 's'} to ${settings.myjd.deviceName || 'JDownloader'} (${where}).`;
  });
}

/* ---------- "Find the working link": let JDownloader test every candidate ---------- */

const SMART = { pollMs: 1500, timeoutMs: 60000, perLinkMs: 2000, maxMs: 5 * 60000, ...(globalThis.__SMART_TEST || {}) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateOf = (l) => String(l.availability || l.availableLinkState || 'UNKNOWN').toUpperCase();
const isPending = (l) => /UNKNOWN|UNKOWN/.test(stateOf(l));
const isWebPage = (l) => /\.(html?|php|aspx?|jsp)$/i.test(String(l.name || ''));

function fmtSize(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return ` (${n.toFixed(i ? 1 : 0)} ${u[i]})`;
}

function progress(text) {
  browser.runtime.sendMessage({ type: 'progress', text }).catch(() => { /* popup closed */ });
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

async function smartQueueViaMyJD(settings, links, packageName, source, opts = {}) {
  progress(`Sending ${links.length} link${links.length === 1 ? '' : 's'} for JDownloader to check…`);
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
        crawlerBusy = jobs.some((j) => j.crawling || j.checking);
      } catch (_) { /* older JDownloader: fall back to link states only */ }
      failures = 0;
      stableRounds = found.length === lastCount ? stableRounds + 1 : 0;
      lastCount = found.length;
      const pending = found.filter(isPending).length;
      progress(`JDownloader found ${found.length} link${found.length === 1 ? '' : 's'}, ${pending} still being checked…`);
      const crawlerDone = crawlerBusy === null ? stableRounds >= 2 : !crawlerBusy;
      if (crawlerDone && found.length && !pending) break;
      if (crawlerDone && !found.length && stableRounds >= 3) break;
    } catch (e) {
      if (++failures >= 3) throw e;
    }
  }

  if (!found.length) {
    return 'JDownloader added nothing new. The links may already be in LinkGrabber, so check there or clear the old entries and try again.';
  }

  const online = found.filter((l) => stateOf(l) === 'ONLINE');
  const offline = found.filter((l) => stateOf(l) === 'OFFLINE');
  const pending = found.filter(isPending);
  const realFiles = online.filter((l) => !isWebPage(l));
  const junkPages = realFiles.length ? online.filter(isWebPage) : [];
  const kept = online.filter((l) => !junkPages.includes(l)).concat(pending);
  const remove = offline.concat(junkPages);

  if (remove.length) await client.removeLinks(deviceId, remove.map((l) => l.uuid));
  if (settings.autostart && kept.length) await client.moveToDownloadlist(deviceId, kept.map((l) => l.uuid));

  const lines = [];
  if (!kept.length) {
    lines.push(`None of the ${found.length} links worked from JDownloader, so all were removed.`);
    lines.push('The site may need you logged in. Add your account in JDownloader → Settings → Account Manager, or update JDownloader.');
  } else {
    const where = settings.autostart ? 'downloading' : 'in LinkGrabber';
    lines.push(`Kept ${kept.length} working link${kept.length === 1 ? '' : 's'} ${where}:`);
    for (const l of kept.slice(0, 5)) lines.push(`• ${l.name || l.url}${fmtSize(l.bytesTotal)}${isPending(l) ? ' (still checking)' : ''}`);
    if (kept.length > 5) lines.push(`• …and ${kept.length - 5} more`);
    if (remove.length) lines.push(`Removed ${offline.length} offline${junkPages.length ? ` and ${junkPages.length} web-page` : ''} link${remove.length === 1 ? '' : 's'}.`);
    if (folder) lines.push(`Folder: ${folder}`);
  }
  return lines.join('\n');
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

/* ---------- Message handlers ---------- */

const handlers = {
  async getSettings() { return getSettings(); },

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
    const links = [...new Set((msg.links || []).filter((u) => /^https?:\/\//i.test(u)))];
    if (!links.length) throw new Error('Nothing to send.');
    const packageName = settings.packageFromTitle && msg.packageName ? String(msg.packageName).slice(0, 120) : null;
    const message = settings.backend === 'cnl'
      ? await queueViaCNL(settings, links, packageName, msg.source)
      : await queueViaMyJD(settings, links, packageName, msg.source);
    return { ok: true, message };
  },

  /* msg.mode: 'find' (default) = page + video candidates, keep what works.
              'list' = many individual videos, into their own folder. */
  async smartQueue(msg) {
    const settings = await getSettings();
    const list = msg.mode === 'list';
    const links = [...new Set((msg.links || []).filter((u) => /^https?:\/\//i.test(u)))].slice(0, list ? 200 : 12);
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
      result = { ok: true, message: await smartQueueViaMyJD(settings, links, packageName, msg.source, { folderName }) };
    } catch (err) {
      result = { ok: false, message: friendly(err) };
    }
    // Remember the outcome so it can be shown if the popup was closed while JDownloader was checking.
    await browser.storage.local.set({ lastResult: { ...result, page: msg.source || '', at: Date.now() } });
    return result;
  },
};

browser.runtime.onMessage.addListener((msg) => {
  const h = handlers[msg && msg.type];
  if (!h) return Promise.resolve({ ok: false, message: `Unknown message ${msg && msg.type}` });
  return h(msg).catch((err) => ({ ok: false, message: friendly(err), detail: err && err.detail }));
});
