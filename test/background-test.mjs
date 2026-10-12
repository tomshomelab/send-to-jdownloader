// Exercises background.js message handlers in Node with a stubbed `browser` API and a fake
// Click'n'Load server, so the plumbing is verified without a phone.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) fails++; };

// --- fake JDownloader CNL server ---
const hits = [];
const jd = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    hits.push({ url: req.url, body });
    if (req.url === '/jdcheck.js') { res.end('jdownloader=true;'); return; }
    if (req.url === '/flash/add') { res.end('success\r\n'); return; }
    res.statusCode = 404; res.end('nope');
  });
});
await new Promise((r) => jd.listen(0, '127.0.0.1', r));
const port = jd.address().port;

// --- stubbed WebExtension API ---
const store = {};
let listener = null;
const browser = {
  storage: { local: {
    get: async () => ({ ...store }),
    set: async (obj) => { Object.assign(store, obj); },
  } },
  runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
};

// load myjd.js then background.js into one sandbox, like the background page does
const sandbox = { browser, fetch, crypto, TextEncoder, TextDecoder, btoa, atob, console, URLSearchParams, Date, JSON, Promise, Error, Set, Object, Array, String, Number, Math, AbortController, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../extension/myjd.js', import.meta.url), 'utf8'), sandbox);
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), sandbox);
const send = (msg) => listener(msg);

// 1. defaults
let s = await send({ type: 'getSettings' });
check('default backend is myjd', s.backend === 'myjd');

// 2. unknown message
check('unknown message rejected', (await send({ type: 'bogus' })).ok === false);

// 3. queue before setup -> friendly error
let r = await send({ type: 'queue', links: ['https://example.com/a'] });
check('queue before setup fails cleanly', r.ok === false && /not set up/.test(r.message), r.message);

// 4. CNL test + queue
await send({ type: 'saveSettings', settings: { backend: 'cnl', cnl: { host: '127.0.0.1', port }, packageFromTitle: true } });
r = await send({ type: 'cnlTest', cnl: { host: '127.0.0.1', port } });
check('cnlTest detects JD', r.ok === true, r.message);
r = await send({ type: 'cnlTest', cnl: { host: '127.0.0.1', port: port + 1 } });
check('cnlTest reports unreachable', r.ok === false, r.message);

r = await send({ type: 'queue', links: ['https://example.com/page', 'https://example.com/v.mp4', 'https://example.com/page', 'ftp://x'], packageName: 'My Page', source: 'https://example.com/page' });
check('queue via CNL ok', r.ok === true, r.message);
const add = hits.find((h) => h.url === '/flash/add');
const params = new URLSearchParams(add.body);
check('CNL urls deduped and http-only', params.get('urls') === 'https://example.com/page\r\nhttps://example.com/v.mp4', JSON.stringify(params.get('urls')));
check('CNL package name', params.get('package') === 'My Page');
check('CNL no autostart by default', params.get('autostart') === null);

// 5. myjdSetup with bogus creds -> structured failure, nothing stored
r = await send({ type: 'myjdSetup', email: 'nobody-send-to-jd@example.com', password: 'wrong' });
check('myjdSetup bogus creds fails', r.ok === false, r.message);
s = await send({ type: 'getSettings' });
check('no secrets stored after failed setup', !s.myjd.loginSecret);

// 6. queue with myjd backend but no secrets
await send({ type: 'saveSettings', settings: { backend: 'myjd' } });
r = await send({ type: 'queue', links: ['https://example.com/a'] });
check('myjd queue without setup fails cleanly', r.ok === false && /not set up/.test(r.message), r.message);

jd.close();
console.log(fails ? `\n${fails} failure(s)` : '\nAll good');
process.exit(fails ? 1 : 0);
