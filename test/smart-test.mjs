// Tests for "Find the working link":
//  1. myjd.js wire format: decrypt what the client would POST and check URLs + params.
//  2. background.js smartQueue flow against a fake JDownloader that reports online/offline links.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { MyJD, makeSecrets, _internal: I } = require('../extension/myjd.js');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) fails++; };

/* ---------- 1. wire format ---------- */
{
  const client = new MyJD(await makeSecrets('user@example.com', 'pw'));
  await client.restore({ sessiontoken: 'ab'.repeat(32), regaintoken: 'cd'.repeat(32) });
  const sent = [];
  const replies = [{ id: 1700000000123 }, [], [], {}, {}];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(await I.decrypt(client.deviceToken, opts.body));
    sent.push({ url, body });
    const enc = await I.encrypt(client.deviceToken, JSON.stringify({ data: replies.shift(), rid: body.rid }));
    return { ok: true, status: 200, text: async () => enc };
  };
  const job = await client.addLinks('dev1', { links: ['https://a/1', 'https://a/2'], packageName: 'P', sourceUrl: 'https://site/page', assignJobID: true });
  await client.queryJobLinks('dev1', job.id);
  await client.queryCrawlerJobs('dev1', job.id);
  await client.removeLinks('dev1', [11, 12]);
  await client.moveToDownloadlist('dev1', [13]);

  const add = JSON.parse(sent[0].body.params[0]);
  check('addLinks path', sent[0].url.endsWith('/t_' + 'ab'.repeat(32) + '_dev1/linkgrabberv2/addLinks'));
  check('addLinks returns job id', job.id === 1700000000123);
  check('addLinks assignJobID', add.assignJobID === true);
  check('addLinks sourceUrl', add.sourceUrl === 'https://site/page');
  check('addLinks links joined', add.links === 'https://a/1\nhttps://a/2');
  const q = JSON.parse(sent[1].body.params[0]);
  check('queryLinks path', sent[1].url.endsWith('/linkgrabberv2/queryLinks'));
  check('queryLinks filters by job', JSON.stringify(q.jobUUIDs) === '[1700000000123]' && q.availability === true);
  const j = JSON.parse(sent[2].body.params[0]);
  check('queryLinkCrawlerJobs query', sent[2].url.endsWith('/linkgrabberv2/queryLinkCrawlerJobs') && JSON.stringify(j.jobIds) === '[1700000000123]');
  check('removeLinks params', JSON.stringify(sent[3].body.params) === JSON.stringify(['[11,12]', '[]']), JSON.stringify(sent[3].body.params));
  check('moveToDownloadlist params', sent[4].url.endsWith('/moveToDownloadlist') && JSON.stringify(sent[4].body.params) === JSON.stringify(['[13]', '[]']));
  // plain add (no smart) must not send the new fields
  sent.length = 0; replies.push({ id: 1 });
  await client.addLinks('dev1', { links: ['https://a/1'] });
  const plain = JSON.parse(sent[0].body.params[0]);
  check('plain add omits assignJobID/sourceUrl', !('assignJobID' in plain) && !('sourceUrl' in plain));
}

/* ---------- 2. smartQueue flow with a fake JDownloader ---------- */
function makeBackground(fakeLinksByPoll, opts = {}) {
  const store = {
    backend: 'myjd', autostart: !!opts.autostart, packageFromTitle: true,
    myjd: { email: 'u@example.com', loginSecret: 'aa', deviceSecret: 'bb', deviceId: 'dev1', deviceName: 'JD' },
    myjdSession: { sessiontoken: 'cc' },
  };
  const calls = { add: [], removed: [], moved: [], progress: [] };
  let poll = 0;
  class FakeMyJD {
    constructor() { this.session = { sessiontoken: 'cc' }; }
    async restore() { return true; }
    async connect() {}
    async addLinks(dev, q) { calls.add.push(q); return { id: 42 }; }
    async getDefaultDownloadFolder() { return opts.baseFolder === undefined ? '/output' : opts.baseFolder; }
    async queryJobLinks(dev, id) { const r = fakeLinksByPoll[Math.min(poll, fakeLinksByPoll.length - 1)]; poll++; return r; }
    async queryCrawlerJobs() { return [{ jobId: 42, crawling: poll < 2, checking: false }]; }
    async removeLinks(dev, ids) { calls.removed.push(...ids); }
    async moveToDownloadlist(dev, ids) { calls.moved.push(...ids); }
  }
  let listener;
  const browser = {
    storage: { local: { get: async (k) => (k === 'lastResult' ? { lastResult: store.lastResult } : { ...store }), set: async (o) => Object.assign(store, o) } },
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: async (m) => { if (m.type === 'progress') calls.progress.push(m.text); },
    },
  };
  const sandbox = {
    browser, console, Date, JSON, Promise, Error, Set, Object, Array, String, Number, Math, URLSearchParams, URL,
    AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in test'); },
    __SMART_TEST: { pollMs: 5, timeoutMs: 2000 },
    MyJDClient: { MyJD: FakeMyJD, MyJDError: class extends Error {}, makeSecrets: async () => ({}), friendly: (e) => e.message },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), sandbox);
  return { send: (m) => listener(m), calls, store };
}

const L = (uuid, name, availability, bytesTotal = 0) => ({ uuid, name, availability, bytesTotal, url: `https://x/${uuid}` });
const msg = { type: 'smartQueue', links: ['https://site/page', 'https://cdn/a.mp4', 'https://cdn/b.mp4', 'https://cdn/a.mp4', 'blob:x'], packageName: 'Title', source: 'https://site/page' };

{ // mixed: one real video online, two offline, one html page online
  const final = [L(1, 'video.mp4', 'ONLINE', 50 * 1024 * 1024), L(2, 'a.mp4', 'OFFLINE'), L(3, 'b.mp4', 'OFFLINE'), L(4, 'page.html', 'ONLINE', 900)];
  const bg = makeBackground([[], [L(1, 'video.mp4', 'UNKNOWN')], final, final, final]);
  const r = await bg.send(msg);
  check('smart: ok', r.ok === true, JSON.stringify(r));
  check('smart: deduped, http-only, sourceUrl + assignJobID', JSON.stringify(bg.calls.add[0].links) === JSON.stringify(['https://site/page', 'https://cdn/a.mp4', 'https://cdn/b.mp4']) && bg.calls.add[0].assignJobID === true && bg.calls.add[0].sourceUrl === 'https://site/page' && bg.calls.add[0].autostart === false);
  check('smart: removed offline + html junk', JSON.stringify(bg.calls.removed.sort()) === '[2,3,4]', JSON.stringify(bg.calls.removed));
  check('smart: no autostart move', bg.calls.moved.length === 0);
  check('smart: message names the kept file', /Kept 1 working link/.test(r.message) && /video\.mp4 \(50\.0 MB\)/.test(r.message) && /Removed 2 offline and 1 web-page links/.test(r.message), JSON.stringify(r.message));
  check('smart: progress reported', bg.calls.progress.length > 1);
  check('smart: lastResult stored', bg.store.lastResult && bg.store.lastResult.page === 'https://site/page' && bg.store.lastResult.ok === true);
}

{ // autostart on: survivors moved to the download list
  const final = [L(1, 'video.mp4', 'ONLINE'), L(2, 'a.mp4', 'OFFLINE')];
  const bg = makeBackground([final, final, final, final], { autostart: true });
  const r = await bg.send(msg);
  check('autostart: moved survivors', JSON.stringify(bg.calls.moved) === '[1]' && JSON.stringify(bg.calls.removed) === '[2]', r.message);
}

{ // nothing works
  const final = [L(1, 'a.mp4', 'OFFLINE'), L(2, 'b.mp4', 'OFFLINE')];
  const bg = makeBackground([final, final, final, final]);
  const r = await bg.send(msg);
  check('all offline: removed all + login hint', JSON.stringify(bg.calls.removed) === '[1,2]' && /None of the 2 links worked/.test(r.message) && /Account Manager/.test(r.message));
}

{ // only an html page online: keep it (no real file to prefer)
  const final = [L(1, 'page.html', 'ONLINE')];
  const bg = makeBackground([final, final, final, final]);
  const r = await bg.send(msg);
  check('only html online: kept', bg.calls.removed.length === 0 && /Kept 1/.test(r.message));
}

{ // JDownloader added nothing (duplicates)
  const bg = makeBackground([[], [], [], [], [], []]);
  const r = await bg.send(msg);
  check('nothing added: explains duplicates', r.ok === true && /already be in LinkGrabber/.test(r.message), r.message);
}

{ // wrong backend
  const bg = makeBackground([[]]);
  bg.store.backend = 'cnl';
  const r = await bg.send(msg);
  check('cnl backend refused', r.ok === false && /My\.JDownloader/.test(r.message));
}

/* ---------- list mode: many videos into their own folder ---------- */
const many = Array.from({ length: 250 }, (_, i) => `https://site/video/${i}`);
const listMsg = { type: 'smartQueue', mode: 'list', links: many, packageName: 'Best of: "cats" / dogs?  ', source: 'https://www.site.com/channel/x' };

{ // folder = default folder + sanitised page title; package name matches; capped at 200
  const final = [L(1, 'v1.mp4', 'ONLINE'), L(2, 'v2.mp4', 'ONLINE'), L(3, 'v3.mp4', 'OFFLINE')];
  const bg = makeBackground([final, final, final, final]);
  const r = await bg.send(listMsg);
  const q = bg.calls.add[0];
  check('list: capped at 200 links', q.links.length === 200, String(q.links.length));
  check('list: folder under default folder', q.destinationFolder === '/output/Best of cats dogs', q.destinationFolder);
  check('list: package name = folder name', q.packageName === 'Best of cats dogs', q.packageName);
  check('list: checked + offline removed', JSON.stringify(bg.calls.removed) === '[3]' && /Kept 2 working links/.test(r.message));
  check('list: message shows folder', /Folder: \/output\/Best of cats dogs/.test(r.message), r.message);
}

{ // Windows-style JDownloader folder, empty title -> host + date
  const final = [L(1, 'v1.mp4', 'ONLINE')];
  const bg = makeBackground([final, final, final], { baseFolder: 'D:\\Downloads\\' });
  await bg.send({ ...listMsg, packageName: '   ' });
  const f = bg.calls.add[0].destinationFolder;
  check('list: windows separator + fallback name', /^D:\\Downloads\\site\.com \d{4}-\d{2}-\d{2}$/.test(f), f);
}

{ // single-video modes never set a folder
  const final = [L(1, 'v.mp4', 'ONLINE')];
  const bg = makeBackground([final, final, final]);
  await bg.send(msg);
  check('find mode: no folder', !bg.calls.add[0].destinationFolder);
}

console.log(fails ? `\n${fails} failure(s)` : '\nAll good');
process.exit(fails ? 1 : 0);
