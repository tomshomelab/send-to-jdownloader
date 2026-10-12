/* Settings form logic. Used by options.html on its own and by the settings view inside popup.html. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const msg = (m) => browser.runtime.sendMessage(m);

  function fillDevices(devices, selectedId) {
    const sel = $('myjd-device');
    sel.innerHTML = '';
    if (!devices.length) {
      const o = document.createElement('option');
      o.textContent = 'No JDownloader linked to this account';
      o.value = '';
      sel.appendChild(o);
      return;
    }
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.name}${d.status && d.status !== 'ONLINE' ? ` (${d.status})` : ''}`;
      o.dataset.name = d.name;
      if (d.id === selectedId) o.selected = true;
      sel.appendChild(o);
    }
  }

  function backend() {
    const r = document.querySelector('input[name=backend]:checked');
    return r ? r.value : 'myjd';
  }

  function toggleCards() {
    $('myjd-card').style.opacity = backend() === 'myjd' ? '1' : '.5';
    $('cnl-card').style.opacity = backend() === 'cnl' ? '1' : '.5';
  }

  async function load() {
    const s = await msg({ type: 'getSettings' });
    const radio = document.querySelector(`input[name=backend][value=${s.backend}]`);
    if (radio) radio.checked = true;
    $('myjd-email').value = s.myjd.email || '';
    $('cnl-host').value = s.cnl.host || '';
    $('cnl-port').value = s.cnl.port || 9666;
    $('autostart').checked = !!s.autostart;
    $('packageFromTitle').checked = s.packageFromTitle !== false;
    $('myjd-state').textContent = s.myjd.loginSecret ? `Connected as ${s.myjd.email}.` : 'Not connected yet.';
    if (s.myjd.deviceId) fillDevices([{ id: s.myjd.deviceId, name: s.myjd.deviceName || s.myjd.deviceId }], s.myjd.deviceId);
    else fillDevices([], '');
    $('save-state').textContent = '';
    toggleCards();
  }

  async function saveGeneral() {
    const sel = $('myjd-device');
    const opt = sel.options[sel.selectedIndex];
    const s = await msg({ type: 'getSettings' });
    const settings = {
      backend: backend(),
      cnl: { host: $('cnl-host').value.trim(), port: Number($('cnl-port').value) || 9666 },
      autostart: $('autostart').checked,
      packageFromTitle: $('packageFromTitle').checked,
      myjd: { ...s.myjd, deviceId: opt && opt.value ? opt.value : s.myjd.deviceId, deviceName: opt && opt.value ? opt.dataset.name : s.myjd.deviceName },
    };
    await msg({ type: 'saveSettings', settings });
    $('save-state').textContent = 'Saved.';
    document.dispatchEvent(new CustomEvent('settings-saved'));
  }

  async function connectMyJD() {
    const email = $('myjd-email').value.trim();
    const password = $('myjd-password').value;
    if (!email || !password) { $('myjd-state').textContent = 'Enter email and password first.'; return; }
    $('myjd-connect').disabled = true;
    $('myjd-state').textContent = 'Connecting…';
    const res = await msg({ type: 'myjdSetup', email, password });
    $('myjd-connect').disabled = false;
    if (!res.ok) { $('myjd-state').textContent = `Failed: ${res.message}`; return; }
    $('myjd-password').value = '';
    document.querySelector('input[name=backend][value=myjd]').checked = true;
    toggleCards();
    fillDevices(res.devices, res.deviceId);
    $('myjd-state').textContent = `Connected as ${email}. ${res.devices.length} JDownloader${res.devices.length === 1 ? '' : 's'} found. Press Save.`;
  }

  async function refreshDevices() {
    $('myjd-state').textContent = 'Loading devices…';
    const res = await msg({ type: 'myjdDevices' });
    if (!res.ok) { $('myjd-state').textContent = `Failed: ${res.message}`; return; }
    const s = await msg({ type: 'getSettings' });
    fillDevices(res.devices, s.myjd.deviceId);
    $('myjd-state').textContent = `${res.devices.length} JDownloader${res.devices.length === 1 ? '' : 's'} found. Pick one and press Save.`;
  }

  async function testCNL() {
    $('cnl-state').textContent = 'Testing…';
    const res = await msg({ type: 'cnlTest', cnl: { host: $('cnl-host').value.trim(), port: Number($('cnl-port').value) || 9666 } });
    $('cnl-state').textContent = res.message;
  }

  for (const r of document.querySelectorAll('input[name=backend]')) r.addEventListener('change', toggleCards);
  $('myjd-connect').addEventListener('click', connectMyJD);
  $('myjd-refresh').addEventListener('click', refreshDevices);
  $('cnl-test').addEventListener('click', testCNL);
  $('save').addEventListener('click', saveGeneral);

  window.SettingsForm = { load };
  load();
})();
