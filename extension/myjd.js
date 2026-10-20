/* My.JDownloader API client. WebCrypto only, no dependencies.
   Runs in the extension background page and in Node 20+ (globalThis.crypto).
   Protocol as implemented by the reference Python client (myjdapi). */
(function (root) {
  'use strict';

  const API = 'https://api.jdownloader.org';
  const APPKEY = 'send_to_jdownloader_firefox_android';
  const te = new TextEncoder();
  const td = new TextDecoder();

  function concat(...arrs) {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8));

  async function hmacHex(keyBytes, str) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(str))));
  }
  async function encrypt(token, str) {
    const iv = token.slice(0, 16), keyBytes = token.slice(16, 32);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    return b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, te.encode(str))));
  }
  async function decrypt(token, b64str) {
    const iv = token.slice(0, 16), keyBytes = token.slice(16, 32);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
    return td.decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, unb64(b64str)));
  }

  /* Derive the two long-lived secrets from email + password. Only these are stored;
     the password itself is never kept. */
  async function makeSecrets(email, password) {
    const e = String(email).trim().toLowerCase();
    return {
      email: e,
      loginSecret: hex(await sha256(te.encode(e + password + 'server'))),
      deviceSecret: hex(await sha256(te.encode(e + password + 'device'))),
    };
  }

  class MyJDError extends Error {
    constructor(src, type, status, detail) {
      super(`${src || 'MYJD'}: ${type || 'UNKNOWN'}${status ? ` (HTTP ${status})` : ''}`);
      this.name = 'MyJDError';
      this.src = src; this.type = type; this.status = status; this.detail = detail;
    }
  }

  const FRIENDLY = {
    AUTH_FAILED: 'My.JDownloader rejected the email/password.',
    TOKEN_INVALID: 'Session expired.',
    TOO_MANY_REQUESTS: 'My.JDownloader rate limit hit. Wait a minute and try again.',
    OFFLINE: 'That JDownloader is not connected to My.JDownloader right now. Check JDownloader > Settings > My.JDownloader on the PC.',
    MAINTENANCE: 'My.JDownloader is down for maintenance.',
    UNKNOWN_DEVICE: 'Device not found. Open the extension settings and pick your JDownloader again.',
    EMAIL_INVALID: 'That email address is not valid.',
  };
  const friendly = (err) => (err instanceof MyJDError && FRIENDLY[err.type]) || err.message;

  class MyJD {
    constructor({ email, loginSecret, deviceSecret }) {
      this.email = String(email).trim().toLowerCase();
      this.loginSecret = unhex(loginSecret);
      this.deviceSecret = unhex(deviceSecret);
      this.sessiontoken = null;
      this.regaintoken = null;
      this.serverToken = null;
      this.deviceToken = null;
      this._n = 0;
    }

    rid() { return Date.now() * 1000 + (this._n = (this._n + 1) % 1000); }

    get session() { return this.sessiontoken ? { sessiontoken: this.sessiontoken, regaintoken: this.regaintoken } : null; }

    async restore(session) {
      if (!session || !session.sessiontoken) return false;
      this.sessiontoken = session.sessiontoken;
      this.regaintoken = session.regaintoken || null;
      await this._deriveTokens();
      return true;
    }

    async _deriveTokens() {
      const st = unhex(this.sessiontoken);
      this.serverToken = await sha256(concat(this.loginSecret, st));
      this.deviceToken = await sha256(concat(this.deviceSecret, st));
    }

    async _fail(res, token) {
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) {
        try { body = JSON.parse(await decrypt(token, text)); } catch (_2) { /* leave null */ }
      }
      throw new MyJDError(body && body.src, body && body.type, res.status, text.slice(0, 200));
    }

    async _signedGet(path, params, key) {
      const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
      qs.push(`rid=${this.rid()}`);
      const query = `${path}?${qs.join('&')}`;
      const url = `${API}${query}&signature=${await hmacHex(key, query)}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) await this._fail(res, key);
      return JSON.parse(await decrypt(key, await res.text()));
    }

    async connect() {
      const data = await this._signedGet('/my/connect', { email: this.email, appkey: APPKEY }, this.loginSecret);
      this.sessiontoken = data.sessiontoken;
      this.regaintoken = data.regaintoken;
      await this._deriveTokens();
      return this.session;
    }

    async disconnect() {
      if (!this.sessiontoken) return;
      try { await this._signedGet('/my/disconnect', { sessiontoken: this.sessiontoken }, this.serverToken); } catch (_) { /* ignore */ }
      this.sessiontoken = this.regaintoken = this.serverToken = this.deviceToken = null;
    }

    async listDevices() {
      if (!this.sessiontoken) await this.connect();
      const data = await this._signedGet('/my/listdevices', { sessiontoken: this.sessiontoken }, this.serverToken);
      return data.list || [];
    }

    /* Call a device API method, e.g. call(deviceId, '/linkgrabberv2/addLinks', {links: '...'}) */
    async call(deviceId, action, ...params) {
      if (!this.sessiontoken) await this.connect();
      const body = JSON.stringify({
        url: action,
        params: params.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))),
        rid: this.rid(),
        apiVer: 1,
      });
      const url = `${API}/t_${this.sessiontoken}_${encodeURIComponent(deviceId)}${action}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/aesjson-jd; charset=utf-8' },
        body: await encrypt(this.deviceToken, body),
      });
      if (!res.ok) await this._fail(res, this.deviceToken);
      const data = JSON.parse(await decrypt(this.deviceToken, await res.text()));
      return data.data !== undefined ? data.data : data;
    }

    /* Returns the collecting job, e.g. { id: 1700000000123 }. With assignJobID the crawled links
       carry that id, so queryJobLinks() can find exactly this batch. sourceUrl becomes the
       referrer JDownloader uses when it requests the links. */
    async addLinks(deviceId, { links, packageName = null, autostart = false, destinationFolder = null, downloadPassword = null, extractPassword = null, sourceUrl = null, assignJobID = false, deepDecrypt = false }) {
      const list = Array.isArray(links) ? links : [links];
      const query = {
        links: list.join('\n'),
        packageName,
        autostart,
        destinationFolder,
        downloadPassword,
        extractPassword,
        priority: 'DEFAULT',
        overwritePackagizerRules: false,
      };
      if (sourceUrl) query.sourceUrl = sourceUrl;
      if (assignJobID) query.assignJobID = true;
      // Deep link analysis: JDownloader opens the page itself and collects every link inside it.
      if (deepDecrypt) query.deepDecrypt = true;
      return this.call(deviceId, '/linkgrabberv2/addLinks', query);
    }

    /* LinkGrabber links that came from one or more addLinks jobs, with their online status.
       Each link carries jobUUID so callers can tell which job it came from. */
    async queryJobLinks(deviceId, jobIds) {
      const links = await this.call(deviceId, '/linkgrabberv2/queryLinks', {
        jobUUIDs: Array.isArray(jobIds) ? jobIds : [jobIds],
        jobUUID: true,
        availability: true,
        bytesTotal: true,
        url: true,
        host: true,
        status: true,
        maxResults: -1,
        startAt: 0,
      });
      return Array.isArray(links) ? links : [];
    }

    /* Crawler state for a job: [{ jobId, crawling, checking, crawled, broken, ... }] */
    async queryCrawlerJobs(deviceId, jobIds) {
      const jobs = await this.call(deviceId, '/linkgrabberv2/queryLinkCrawlerJobs', { jobIds: Array.isArray(jobIds) ? jobIds : [jobIds], collectorInfo: true });
      return Array.isArray(jobs) ? jobs : [];
    }

    /* JDownloader's default download folder, e.g. "/output" in the Docker image. */
    async getDefaultDownloadFolder(deviceId) {
      return this.call(deviceId, '/config/get', 'org.jdownloader.settings.GeneralSettings', null, 'DefaultDownloadFolder');
    }

    async removeLinks(deviceId, linkIds, packageIds = []) {
      return this.call(deviceId, '/linkgrabberv2/removeLinks', linkIds, packageIds);
    }

    async moveToDownloadlist(deviceId, linkIds, packageIds = []) {
      return this.call(deviceId, '/linkgrabberv2/moveToDownloadlist', linkIds, packageIds);
    }
  }

  const api = { MyJD, MyJDError, makeSecrets, friendly, _internal: { encrypt, decrypt, hmacHex, sha256, hex, unhex } };
  root.MyJDClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
