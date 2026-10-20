// Video-list sessions: collect, gather, 3-stage send (site handler -> deep analysis -> phone links),
// per-video report, and privacy (nothing written to storage). Fake JDownloader + fake list tab.
// All pages are invented example.com addresses.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) fails++; };

const V = (n) => `https://example.com/v/${n}`;
const L = (name, availability = 'ONLINE', bytesTotal = 1000) => ({ name, availability, bytesTotal });

/* What the fake JDownloader produces for each added link, by stage. */
const SCRIPT = {
  site: {
    [V(1)]: [L('one.mp4', 'ONLINE', 50e6), L('one.jpg'), L('one.txt')],          // site handler works (+ extras)
    [V(2)]: [],                                                                    // no handler
    [V(3)]: [],                                                                    // no handler
    [V(4)]: [],                                                                    // no handler
    [V(5)]: [L('five.mp4', 'ONLINE', 9e6), L('five.ogv', 'ONLINE', 8e6), L('five_512kb.mp4', 'ONLINE', 2e6)], // 3 formats
    [V(6)]: 'dup',                                                                 // already in JD
  },
  deep: {
    [V(2)]: [L('two.mp4', 'ONLINE', 30e6), L('preview.mp4', 'ONLINE', 1e6), L('thumb.jpg')], // deep finds main + preview
    [V(3)]: [L('page.html')],
    [V(4)]: [],
  },
  phone: {
    'directhttp://https://cdn.example.com/three.mp4': [L('three.mp4', 'ONLINE', 20e6)],
    'directhttp://https://cdn.example.com/four-dead.mp4': [L('four-dead.mp4', 'OFFLINE')],
  },
};

/* What the phone finds on each video page (fake gather.js in the list tab). */
const GATHER = {
  [V(3)]: { candidates: [{ url: 'https://cdn.example.com/three.mp4', kind: 'video', score: 900 }], method: 'frame', note: '' },
  [V(4)]: { candidates: [{ url: 'https://cdn.example.com/four-dead.mp4', kind: 'source', score: 700 }], method: 'fetch', note: '' },
  [V(7)]: { candidates: [], method: '', note: 'no video even after loading the player' },
};

function makeWorld(opts = {}) {
  const store = {
    backend: 'myjd', autostart: !!opts.autostart, packageFromTitle: true, videosOnly: true, allowFrame: true, maxPages: 5,
    myjd: { email: 'u@example.com', loginSecret: 'aa', deviceSecret: 'bb', deviceId: 'dev1', deviceName: 'Server JD' },
    myjdSession: { sessiontoken: 'cc' },
  };
  const calls = { adds: [], removed: [], moved: [], storageWrites: [], tabCalls: [], broadcasts: 0 };
  let nextJob = 100;
  let nextLink = 1;
  const jobs = new Map();   // jobId -> links
  class FakeMyJD {
    constructor() { this.session = { sessiontoken: 'cc' }; }
    async restore() { return true; }
    async connect() {}
    async getDefaultDownloadFolder() { return '/output'; }
    async addLinks(dev, q) {
      calls.adds.push(q);
      const id = nextJob++;
      const stage = q.deepDecrypt ? 'deep' : (q.links[0].startsWith('directhttp://') ? 'phone' : 'site');
      const out = [];
      for (const link of q.links) {
        const r = SCRIPT[stage][link];
        if (r === 'dup') { jobs.set(id, { links: [], info: { crawled: 1 } }); return { id }; }
        for (const l of r || []) out.push({ ...l, uuid: nextLink++, jobUUID: id, url: link });
      }
      jobs.set(id, { links: out, info: { crawled: out.length, unhandled: out.length ? 0 : 1 } });
      return { id };
    }
    async queryJobLinks(dev, ids) { return ids.flatMap((id) => (jobs.get(id) || { links: [] }).links); }
    async queryCrawlerJobs(dev, ids) { return ids.map((id) => ({ jobId: id, crawling: false, checking: false, ...(jobs.get(id) || {}).info })); }
    async removeLinks(dev, ids) { calls.removed.push(...ids); for (const j of jobs.values()) j.links = j.links.filter((l) => !ids.includes(l.uuid)); }
    async moveToDownloadlist(dev, ids) { calls.moved.push(...ids); }
  }
  let listener;
  const tab = { id: 7, url: 'https://example.com/list?page=1' };
  const browser = {
    storage: { local: {
      get: async () => ({ ...store }),
      set: async (o) => { calls.storageWrites.push(JSON.stringify(o)); Object.assign(store, o); },
      remove: async () => {},
    } },
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: async (m) => { if (m.type === 'session-updated') calls.broadcasts++; },
    },
    tabs: {
      get: async (id) => { if (id !== tab.id || opts.tabClosed) throw new Error('no tab'); return tab; },
      executeScript: async () => [true],
      sendMessage: async (id, m) => {
        calls.tabCalls.push(m.fn);
        if (m.fn === 'resolveItem') return GATHER[m.url] || { candidates: [], method: '', note: 'nothing' };
        if (m.fn === 'collectPages') {
          // simulate gather.js reporting two more pages while it runs
          await listener({ type: 'gather-page', page: 2, items: [{ url: V(6), title: 'Six' }, { url: V(7), title: 'Seven' }] }, { tab: { id: 7 } });
          await listener({ type: 'gather-page', page: 3, items: [{ url: V(7), title: 'dup' }] }, { tab: { id: 7 } });
          await listener({ type: 'gather-page', page: 3, items: [{ url: V(99), title: 'Spoof' }] }, { tab: { id: 8 } });   // other tab: ignored
          return { pages: 3, reason: 'no next page found' };
        }
        return true;
      },
    },
  };
  const sandbox = {
    browser, console, Date, JSON, Promise, Error, Set, Map, Object, Array, String, Number, Math, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network'); },
    __SMART_TEST: { pollMs: 2, timeoutMs: 500, perLinkMs: 0, maxMs: 1000 },
    MyJDClient: { MyJD: FakeMyJD, MyJDError: class extends Error {}, makeSecrets: async () => ({}), friendly: (e) => e.message },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['background.js', 'session.js']) vm.runInContext(readFileSync(new URL(`../extension/${f}`, import.meta.url), 'utf8'), sandbox, { filename: f });
  return { send: (m, sender) => listener(m, sender), calls, store };
}

/* ---------- 1. start, collect pages, selection ---------- */
const w = makeWorld();
await w.send({ type: 'startSession', tabId: 7, page: 'https://example.com/list?page=1', title: 'My: list / test?', preselect: true,
  items: [1, 2, 3, 4, 5].map((n) => ({ url: V(n), title: `Video ${n}` })) });
let s = await w.send({ type: 'getSession' });
check('session started, all ticked, safe folder name', s.items.length === 5 && s.items.every((i) => i.selected) && s.folderName === 'My list test', s.folderName);

let r = await w.send({ type: 'collectPages' });
s = await w.send({ type: 'getSession' });
check('collect: pages added, duplicates and other tabs ignored', r.ok && s.items.length === 7 && s.pages === 3 && !s.items.some((i) => i.url === V(99)), `${s.items.length} ${r.message}`);
check('collect: new items keep "all ticked"', s.items.filter((i) => i.page === 2).every((i) => i.selected));
check('collect: report mentions why it stopped', /no next page found/.test(r.message), r.message);

/* ---------- 2. gather (test, sends nothing) ---------- */
await w.send({ type: 'selectItems', selected: false });
await w.send({ type: 'selectItems', urls: [V(3), V(4), V(7)], selected: true });
r = await w.send({ type: 'gatherSession' });
s = await w.send({ type: 'getSession' });
const g = (n) => s.items.find((i) => i.url === V(n)).gather;
check('gather: sends nothing to JDownloader', w.calls.adds.length === 0);
check('gather: per-video results recorded', g(3).status === 'found' && g(3).method === 'frame' && g(4).method === 'fetch' && g(7).status === 'none' && /player/.test(g(7).note));
check('gather: summary', /found video links for 2 of 3/.test(r.message) && /1 needed the player frame/.test(r.message), r.message);
check('gather: untouched items not gathered', s.items.find((i) => i.url === V(1)).gather === null);

/* ---------- 3. send: site -> deep -> phone ---------- */
await w.send({ type: 'selectItems', selected: true });
r = await w.send({ type: 'sendSession' });
s = await w.send({ type: 'getSession' });
const it = (n) => s.items.find((i) => i.url === V(n)).send;
check('send ok', r.ok, r.message);
check('1: site handler resolves, extras removed', it(1).status === 'queued' && it(1).method === 'site' && it(1).files.map((f) => f.name).join() === 'one.mp4', JSON.stringify(it(1)));
check('1: duplicate formats collapse to the biggest', it(5).files.map((f) => f.name).join() === 'five.mp4', JSON.stringify(it(5).files));
check('1: already-in-JD is reported, not escalated', it(6).status === 'duplicate');
check('2: deep analysis resolves, keeps largest video only', it(2).status === 'queued' && it(2).method === 'deep' && it(2).files.map((f) => f.name).join() === 'two.mp4', JSON.stringify(it(2)));
check('3: phone link (player frame) resolves after deep fails', it(3).status === 'queued' && it(3).method === 'frame', JSON.stringify(it(3)));
check('3: dead phone link fails with a reason', it(4).status === 'failed' && /offline|non-video/.test(it(4).note), JSON.stringify(it(4)));
check('3: nothing anywhere fails with the gather reason', it(7).status === 'failed' && /player/.test(it(7).note), JSON.stringify(it(7)));
const deepAdds = w.calls.adds.filter((q) => q.deepDecrypt).map((q) => q.links[0]);
check('deep only tried for site failures', JSON.stringify(deepAdds.sort()) === JSON.stringify([V(2), V(3), V(4), V(7)].sort()), JSON.stringify(deepAdds));
const phoneAdds = w.calls.adds.filter((q) => q.links[0].startsWith('directhttp://'));
check('phone links sent as directhttp with the video page as referrer', phoneAdds.length === 2 && phoneAdds.every((q) => /^https:\/\/example\.com\/v\/\d$/.test(q.sourceUrl)));
check('every add goes to the list folder + job-tracked', w.calls.adds.every((q) => q.destinationFolder === '/output/My list test' && q.packageName === 'My list test' && q.assignJobID === true && q.autostart === false));
check('report summary', /5 of 7 videos in LinkGrabber/.test(r.message) === false && /4 of 7 videos in LinkGrabber/.test(r.message) && /1 already in JDownloader/.test(r.message) && /2 could not be found/.test(r.message), r.message);
check('report counts by method', s.report.byMethod.site === 2 && s.report.byMethod.deep === 1 && s.report.byMethod.frame === 1, JSON.stringify(s.report));

/* ---------- 4. resend only retries failures ---------- */
const before = w.calls.adds.length;
await w.send({ type: 'sendSession' });
const retried = w.calls.adds.slice(before).filter((q) => !q.deepDecrypt && !q.links[0].startsWith('directhttp://')).map((q) => q.links[0]);
check('resend retries only failed videos', JSON.stringify(retried.sort()) === JSON.stringify([V(4), V(7)].sort()), JSON.stringify(retried));

/* ---------- 5. privacy ---------- */
const written = w.calls.storageWrites.join(' ');
check('privacy: nothing about pages, titles or files in storage', !/example\.com\/v|example\.com\/list|Video \d|one\.mp4|My list/.test(written), written);
await w.send({ type: 'clearSession' });
check('clear list wipes it', (await w.send({ type: 'getSession' })) === null);

/* ---------- 6. autostart + closed tab ---------- */
const w2 = makeWorld({ autostart: true, tabClosed: true });
await w2.send({ type: 'startSession', tabId: 7, page: 'https://example.com/list', title: 'T', preselect: true, items: [{ url: V(1) }, { url: V(3) }] });
r = await w2.send({ type: 'sendSession' });
s = await w2.send({ type: 'getSession' });
check('autostart moves queued files', w2.calls.moved.length === 1, JSON.stringify(w2.calls.moved));
check('closed list tab: phone stage explains', s.items.find((i) => i.url === V(3)).send.status === 'failed' && /tab with the list was closed/.test(s.items.find((i) => i.url === V(3)).send.note));
r = await w2.send({ type: 'collectPages' });
check('collect with closed tab: clear error', r.ok === false && /closed/.test(r.message));

/* ---------- 7. guard rails ---------- */
const w3 = makeWorld();
r = await w3.send({ type: 'sendSession' });
check('no list: clear error', r.ok === false && /No list/.test(r.message));

console.log(fails ? `\n${fails} failure(s)` : '\nAll good');
process.exit(fails ? 1 : 0);
