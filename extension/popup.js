'use strict';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const send = (msg) => browser.runtime.sendMessage(msg);
const countOf = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let page = null;          // { url, title, tabId }
let candidates = [];      // [{url, kind, score}]
let pageItems = [];       // [{url, title}] videos listed on the current page
let pageItemsKind = '';   // 'video' | 'grid'
let backend = 'myjd';
let busy = false;         // a single-page send is running
let session = null;       // the in-memory video list held by the background

/* JDownloader silently ignores plain links it has no plugin for, which is typical of a video
   server URL without a file extension. "directhttp://" tells it to treat the link as a file.
   Streams (m3u8/mpd) and embed/player pages are left alone so JDownloader's plugins handle them. */
function forJD(c) {
  if (!c) return null;
  const direct = ['video', 'link', 'jsonld', 'meta', 'source'].includes(c.kind)
    && !/\.(m3u8|mpd)(\?|#|$)/i.test(c.url)
    && !/\/(embed|player|iframe)(\/|\?|$)/i.test(c.url)
    && !/(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv)/i.test(c.url);
  return direct ? `directhttp://${c.url}` : c.url;
}

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${ok === undefined ? '' : ok ? 'ok' : 'err'}`;
  show(el, true);
}

function setBusy(on) {
  busy = on;
  for (const id of ['send-page', 'send-video', 'send-both']) $(id).disabled = on || (id !== 'send-page' && !candidates.length);
  $('send-smart').disabled = on;
}

async function inspectTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  page = { url: tab.url, title: tab.title || '', tabId: tab.id };
  let frames = [];
  try {
    await browser.tabs.executeScript(tab.id, { file: 'detect.js', allFrames: true, runAt: 'document_idle' });
    frames = await browser.tabs.executeScript(tab.id, { file: 'content.js', allFrames: true, runAt: 'document_idle' });
  } catch (e) {
    // Restricted page (about:, addons.mozilla.org, PDF viewer...). Page URL still works.
    frames = [];
  }
  const all = [];
  let blob = false;
  for (const f of frames) {
    if (!f || !Array.isArray(f.candidates)) continue;
    if (f.top && f.title) page.title = f.title;
    blob = blob || !!f.blob;
    all.push(...f.candidates);
  }
  const seen = new Set();
  candidates = all
    .filter((c) => c.url !== page.url && !seen.has(c.url) && seen.add(c.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const top = frames.find((f) => f && f.top && Array.isArray(f.items));
  pageItems = top ? top.items.filter((it) => it.url !== page.url) : [];
  pageItemsKind = top ? top.itemsKind : '';
  return { blob };
}

function renderPage(info) {
  $('page-url').textContent = page.url;
  const sel = $('video-select');
  sel.innerHTML = '';
  for (const c of candidates) {
    const o = document.createElement('option');
    o.value = c.url;
    o.textContent = `[${c.kind}] ${c.url}`;
    sel.appendChild(o);
  }
  show(sel, candidates.length > 0);
  $('video-count').textContent = candidates.length > 1 ? `(${candidates.length} found, best first)` : '';
  show($('video-none'), candidates.length === 0 && !info.blob);
  show($('video-blob'), candidates.length === 0 && info.blob);
  const smart = backend === 'myjd' && candidates.length > 0;
  show($('send-smart'), smart);
  show($('smart-hint'), smart);
  setBusy(false);
}

/* ---------- single-page sends ---------- */

async function sendPage(kind) {
  const links = [];
  if (kind === 'page' || kind === 'both') links.push(page.url);
  if (kind === 'video' || kind === 'both') {
    const v = $('video-select').value;
    const c = candidates.find((x) => x.url === v);
    if (v) links.push(forJD(c) || v);
  }
  if (!links.length) return;
  setBusy(true);
  setStatus('Sending…');
  const res = await send({ type: 'queue', links, packageName: page.title, source: page.url });
  setStatus(res.message, !!res.ok);
  setBusy(false);
}

async function sendSmart() {
  setBusy(true);
  setStatus('Sending links for JDownloader to check…');
  const res = await send({ type: 'smartQueue', links: [page.url, ...candidates.map(forJD)], packageName: page.title, source: page.url });
  setStatus(res.message, !!res.ok);
  setBusy(false);
}

/* ---------- video list (session) ---------- */

const METHOD = {
  site: 'site handler', deep: 'deep analysis', fetch: 'phone, page source', frame: 'phone, player frame',
};

function sizeText(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return ` (${n.toFixed(i ? 1 : 0)} ${u[i]})`;
}

function itemStatus(it) {
  const lines = [];
  if (it.send) {
    if (it.send.status === 'queued') {
      const files = it.send.files.slice(0, 2).map((f) => `${f.name}${sizeText(f.size)}`).join(', ');
      lines.push({ cls: 'ok', text: `✓ Queued via ${METHOD[it.send.method] || it.send.method}${files ? `: ${files}` : ''}${it.send.files.length > 2 ? ` +${it.send.files.length - 2}` : ''}` });
    } else if (it.send.status === 'duplicate') {
      lines.push({ cls: 'ok', text: '= Already in JDownloader' });
    } else {
      lines.push({ cls: 'err', text: `✗ Not sent: ${it.send.note}` });
    }
  }
  if (it.gather) {
    if (it.gather.status === 'found') {
      lines.push({ cls: 'ok', text: `Phone found ${countOf(it.gather.candidates.length, 'link')} (${METHOD[it.gather.method] || it.gather.method})` });
    } else {
      lines.push({ cls: 'err', text: `Phone found nothing: ${it.gather.note}` });
    }
  }
  return lines;
}

function renderSession() {
  const card = $('list-card');
  const haveOther = pageItems.length > 0 && (!session || session.page !== page.url);
  show(card, !!session);
  if (!session) return;

  const running = session.running;
  const ticked = session.items.filter((i) => i.selected).length;
  $('list-count').textContent = `(${ticked} of ${session.items.length} ticked${session.pages > 1 ? `, ${session.pages} pages` : ''})`;
  $('list-source').textContent = session.page === page.url ? 'From this page.' : `From another page: ${session.title || session.page}`;
  show($('list-other'), haveOther && !running);
  $('other-count').textContent = String(pageItems.length);

  const prog = $('list-progress');
  prog.textContent = session.progress || '';
  show(prog, !!(running && session.progress));
  const rep = $('list-report');
  const last = session.lastMessage;
  rep.textContent = last ? last.text : '';
  rep.className = `status ${last ? (last.ok ? 'ok' : 'err') : ''}`;
  show(rep, !!last && !running);

  for (const id of ['list-collect', 'list-gather', 'send-list', 'list-all', 'list-none', 'list-clear']) $(id).disabled = !!running;
  show($('list-stop'), !!running);
  $('send-list').textContent = ticked ? `Send ${countOf(ticked, 'ticked video')} to their own folder` : 'Tick videos to send';
  if (!ticked) $('send-list').disabled = true;
  $('list-gather').disabled = !!running || !ticked;
  $('list-collect').textContent = session.pagesNote ? `Collect next pages (last stop: ${session.pagesNote})` : 'Collect next pages';

  const box = $('list-items');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  for (const it of session.items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.url;
    cb.checked = !!it.selected;
    cb.disabled = !!running;
    cb.addEventListener('change', () => send({ type: 'selectItems', urls: [it.url], selected: cb.checked }));
    const txt = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = `${session.pages > 1 ? `p${it.page} · ` : ''}${it.title || '(untitled)'}`;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = it.url;
    txt.append(t, u);
    for (const s of itemStatus(it)) {
      const d = document.createElement('div');
      d.className = `s ${s.cls}`;
      d.textContent = s.text;
      txt.appendChild(d);
    }
    label.append(cb, txt);
    box.appendChild(label);
  }
  box.scrollTop = scroll;
}

async function refreshSession() {
  session = await send({ type: 'getSession' });
  renderSession();
}

async function startListFromPage() {
  await send({
    type: 'startSession', tabId: page.tabId, page: page.url, title: page.title, items: pageItems,
    // Gallery-style pages start fully ticked; on a single video's page the list is usually "related videos".
    preselect: pageItemsKind === 'video' && candidates.length === 0,
  });
  await refreshSession();
}

async function listAction(type) {
  const res = await send({ type });
  await refreshSession();
  if (res && res.ok === false && res.message && !(session && session.lastMessage)) setStatus(res.message, false);
}

/* Live updates from the background (single-page progress and list changes). */
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'progress' && busy) setStatus(msg.text);
  if (msg.type === 'session-updated') refreshSession();
});

async function showLastResult() {
  const last = await send({ type: 'getLastResult', page: page.url });
  if (last) setStatus(`Last check on this page:\n${last.message}`, !!last.ok);
}

/* ---------- settings view (inside the popup; separate tabs are unreliable on Android) ---------- */

const MAIN_VIEWS = ['notconfigured', 'private-hint', 'main'];

function showSettings(e) {
  if (e) e.preventDefault();
  for (const id of MAIN_VIEWS) show($(id), false);
  show($('settings-view'), true);
  $('heading').textContent = 'Settings';
  $('settings').textContent = '✕';
  window.scrollTo(0, 0);
  if (window.SettingsForm) window.SettingsForm.load();
}

async function hideSettings() {
  show($('settings-view'), false);
  $('heading').textContent = 'Send to JDownloader';
  $('settings').textContent = '⚙';
  for (const id of MAIN_VIEWS) show($(id), false);
  await start();
}

function toggleSettings(e) {
  if (e) e.preventDefault();
  if ($('settings-view').classList.contains('hidden')) showSettings(); else hideSettings();
}

async function start() {
  const settings = await send({ type: 'getSettings' });
  backend = settings.backend;
  $('target').textContent = settings.backend === 'cnl'
    ? `Sending to Click'n'Load at ${settings.cnl.host}`
    : `Sending to ${settings.myjd.deviceName || 'your JDownloader'}`;
  const configured = settings.backend === 'cnl' ? !!settings.cnl.host : !!settings.myjd.loginSecret;
  if (!configured) { show($('notconfigured')); return; }

  const info = await inspectTab();
  if (!page) { show($('private-hint')); return; }
  show($('main'));
  renderPage(info);
  session = await send({ type: 'getSession' });
  // No list yet and this page has one: start it, so it is still here when you come back.
  if (!session && pageItems.length) await startListFromPage();
  else renderSession();
  await showLastResult();
}

async function init() {
  $('settings').addEventListener('click', toggleSettings);
  $('setup').addEventListener('click', showSettings);
  $('back').addEventListener('click', hideSettings);
  document.addEventListener('settings-saved', hideSettings);
  $('send-page').addEventListener('click', () => sendPage('page'));
  $('send-video').addEventListener('click', () => sendPage('video'));
  $('send-both').addEventListener('click', () => sendPage('both'));
  $('send-smart').addEventListener('click', sendSmart);
  $('list-all').addEventListener('click', () => send({ type: 'selectItems', selected: true }));
  $('list-none').addEventListener('click', () => send({ type: 'selectItems', selected: false }));
  $('list-collect').addEventListener('click', () => listAction('collectPages'));
  $('list-gather').addEventListener('click', () => listAction('gatherSession'));
  $('send-list').addEventListener('click', () => listAction('sendSession'));
  $('list-stop').addEventListener('click', () => send({ type: 'stopRun' }));
  $('list-clear').addEventListener('click', () => listAction('clearSession'));
  $('use-this-page').addEventListener('click', startListFromPage);
  await start();
}

init().catch((e) => { show($('main')); setStatus(`Error: ${e.message}`, false); });
