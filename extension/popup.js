'use strict';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

let page = null;          // { url, title }
let candidates = [];      // [{url, kind, score}]
let backend = 'myjd';
let smartRunning = false;
let items = [];          // [{url, title}] individual videos listed on the page

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${ok === undefined ? '' : ok ? 'ok' : 'err'}`;
  show(el, true);
}

function setBusy(busy) {
  for (const id of ['send-page', 'send-video', 'send-both']) $(id).disabled = busy || (id !== 'send-page' && !candidates.length);
  $('send-smart').disabled = busy;
  $('send-list').disabled = busy || !selectedItems().length;
}

async function inspectTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  page = { url: tab.url, title: tab.title || '' };

  let frames = [];
  try {
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
  // Video lists only come from the top frame.
  const top = frames.find((f) => f && f.top && Array.isArray(f.items));
  items = top ? top.items.filter((it) => it.url !== page.url) : [];
  return { blob };
}

function render(info) {
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
  // Only worth it when there is something to choose between, and only My.JDownloader can report back.
  const smart = backend === 'myjd' && candidates.length > 0;
  show($('send-smart'), smart);
  show($('smart-hint'), smart);
  renderList();
  setBusy(false);
}

function selectedItems() {
  return [...document.querySelectorAll('#list-items input:checked')].map((cb) => cb.value);
}

function updateListCount() {
  const n = selectedItems().length;
  $('list-count').textContent = `(${n} of ${items.length} selected)`;
  $('send-list').textContent = n ? `Send ${n} video${n === 1 ? '' : 's'} to their own folder` : 'Select videos to send';
  $('send-list').disabled = !n || smartRunning;
}

function renderList() {
  const box = $('list-items');
  box.innerHTML = '';
  show($('list-card'), items.length > 0);
  if (!items.length) return;
  // On a watch page the list is usually "related videos", so start unticked there.
  // On a gallery or channel page with no main video, start with everything ticked.
  const preselect = candidates.length === 0;
  for (const it of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.url;
    cb.checked = preselect;
    cb.addEventListener('change', updateListCount);
    const txt = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = it.title || '(untitled)';
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = it.url;
    txt.append(t, u);
    label.append(cb, txt);
    box.appendChild(label);
  }
  updateListCount();
}

function selectAll(on) {
  for (const cb of document.querySelectorAll('#list-items input')) cb.checked = on;
  updateListCount();
}

async function sendList() {
  const links = selectedItems();
  if (!links.length) return;
  smartRunning = true;
  setBusy(true);
  setStatus(`Sending ${links.length} videos for JDownloader to check…`);
  const res = await browser.runtime.sendMessage({ type: 'smartQueue', mode: 'list', links, packageName: page.title, source: page.url });
  smartRunning = false;
  setStatus(res.message, !!res.ok);
  setBusy(false);
  updateListCount();
}

async function send(kind) {
  const links = [];
  if (kind === 'page' || kind === 'both') links.push(page.url);
  if (kind === 'video' || kind === 'both') {
    const v = $('video-select').value;
    if (v) links.push(v);
  }
  if (!links.length) return;
  setBusy(true);
  setStatus('Sending…');
  const res = await browser.runtime.sendMessage({ type: 'queue', links, packageName: page.title, source: page.url });
  setStatus(res.message, !!res.ok);
  setBusy(false);
}

async function sendSmart() {
  const links = [page.url, ...candidates.map((c) => c.url)];
  smartRunning = true;
  setBusy(true);
  setStatus('Sending links for JDownloader to check…');
  const res = await browser.runtime.sendMessage({ type: 'smartQueue', links, packageName: page.title, source: page.url });
  smartRunning = false;
  setStatus(res.message, !!res.ok);
  setBusy(false);
}

/* Live progress from the background while JDownloader checks the links. */
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'progress' && smartRunning) setStatus(msg.text);
});

/* If the popup was closed during a check, show how it ended (for this page, within 10 minutes). */
async function showLastResult() {
  const { lastResult } = await browser.storage.local.get('lastResult');
  if (!lastResult || lastResult.page !== page.url || Date.now() - lastResult.at > 10 * 60 * 1000) return;
  setStatus(`Last check on this page:
${lastResult.message}`, !!lastResult.ok);
}

/* Settings live inside the popup: opening a separate options tab is unreliable on Firefox for Android. */
const MAIN_VIEWS = ['notconfigured', 'private-hint', 'main'];
let hidden = {};

function showSettings(e) {
  if (e) e.preventDefault();
  hidden = {};
  for (const id of MAIN_VIEWS) { hidden[id] = !$(id).classList.contains('hidden'); show($(id), false); }
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
  const settings = await browser.runtime.sendMessage({ type: 'getSettings' });
  backend = settings.backend;
  const configured = settings.backend === 'cnl' ? !!settings.cnl.host : !!settings.myjd.loginSecret;
  if (!configured) { show($('notconfigured')); return; }

  const info = await inspectTab();
  if (!page) { show($('private-hint')); return; }
  show($('main'));
  render(info);
  await showLastResult();
}

async function init() {
  $('settings').addEventListener('click', toggleSettings);
  $('setup').addEventListener('click', showSettings);
  $('back').addEventListener('click', hideSettings);
  document.addEventListener('settings-saved', hideSettings);
  $('send-page').addEventListener('click', () => send('page'));
  $('send-video').addEventListener('click', () => send('video'));
  $('send-both').addEventListener('click', () => send('both'));
  $('send-smart').addEventListener('click', sendSmart);
  $('send-list').addEventListener('click', sendList);
  $('list-all').addEventListener('click', () => selectAll(true));
  $('list-none').addEventListener('click', () => selectAll(false));
  await start();
}

init().catch((e) => { show($('main')); setStatus(`Error: ${e.message}`, false); });
