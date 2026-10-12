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

async function queueViaMyJD(settings, links, packageName) {
  return withSession(settings, async (client) => {
    const deviceId = await resolveDevice(settings, client);
    await client.addLinks(deviceId, { links, packageName, autostart: settings.autostart });
    const where = settings.autostart ? 'downloads' : 'LinkGrabber';
    return `Sent ${links.length} link${links.length === 1 ? '' : 's'} to ${settings.myjd.deviceName || 'JDownloader'} (${where}).`;
  });
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
      : await queueViaMyJD(settings, links, packageName);
    return { ok: true, message };
  },
};

browser.runtime.onMessage.addListener((msg) => {
  const h = handlers[msg && msg.type];
  if (!h) return Promise.resolve({ ok: false, message: `Unknown message ${msg && msg.type}` });
  return h(msg).catch((err) => ({ ok: false, message: friendly(err), detail: err && err.detail }));
});
