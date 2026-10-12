'use strict';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

let page = null;          // { url, title }
let candidates = [];      // [{url, kind, score}]

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${ok === undefined ? '' : ok ? 'ok' : 'err'}`;
  show(el, true);
}

function setBusy(busy) {
  for (const id of ['send-page', 'send-video', 'send-both']) $(id).disabled = busy || (id !== 'send-page' && !candidates.length);
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
  setBusy(false);
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
  const configured = settings.backend === 'cnl' ? !!settings.cnl.host : !!settings.myjd.loginSecret;
  if (!configured) { show($('notconfigured')); return; }

  const info = await inspectTab();
  if (!page) { show($('private-hint')); return; }
  show($('main'));
  render(info);
}

async function init() {
  $('settings').addEventListener('click', toggleSettings);
  $('setup').addEventListener('click', showSettings);
  $('back').addEventListener('click', hideSettings);
  document.addEventListener('settings-saved', hideSettings);
  $('send-page').addEventListener('click', () => send('page'));
  $('send-video').addEventListener('click', () => send('video'));
  $('send-both').addEventListener('click', () => send('both'));
  await start();
}

init().catch((e) => { show($('main')); setStatus(`Error: ${e.message}`, false); });
