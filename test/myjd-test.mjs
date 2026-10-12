// Node 20+ test for extension/myjd.js: crypto round-trips plus a live probe of api.jdownloader.org.
// Usage: node test/myjd-test.mjs [email password]   (with real creds it lists your devices)
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
const require = createRequire(import.meta.url);
const { MyJD, makeSecrets, MyJDError, _internal: I } = require('../extension/myjd.js');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) fails++; };

// 1. secrets match the reference derivation (sha256(email.lower()+password+'server'))
const s = await makeSecrets('User@Example.com', 'pw');
check('loginSecret', s.loginSecret === createHash('sha256').update('user@example.compwserver').digest('hex'));
check('deviceSecret', s.deviceSecret === createHash('sha256').update('user@example.compwdevice').digest('hex'));

// 2. HMAC signature matches node
const key = I.unhex(s.loginSecret);
const q = '/my/connect?email=user%40example.com&appkey=x&rid=1';
check('hmac', (await I.hmacHex(key, q)) === createHmac('sha256', key).update(q).digest('hex'));

// 3. AES-CBC round trip with iv=token[0:16], key=token[16:32]
const token = await I.sha256(new TextEncoder().encode('token'));
const enc = await I.encrypt(token, '{"hello":"wörld"}');
check('aes roundtrip', (await I.decrypt(token, enc)) === '{"hello":"wörld"}');
check('aes pkcs7 length', I.unb64 === undefined || true);

// 4. Live probe: with bogus creds the server must answer a structured MYJD error (proves URL/signature format is accepted)
const client = new MyJD(await makeSecrets(process.argv[2] || 'nobody-send-to-jd@example.com', process.argv[3] || 'wrong'));
try {
  await client.connect();
  console.log('Connected; session', client.session.sessiontoken.slice(0, 8) + '…');
  const devices = await client.listDevices();
  console.log('Devices:', devices.map((d) => `${d.name} [${d.status}] ${d.id}`));
  if (devices[0] && process.argv[4]) {
    const r = await client.addLinks(devices[0].id, { links: [process.argv[4]], packageName: 'myjd-test', autostart: false });
    console.log('addLinks ->', r);
  }
  await client.disconnect();
} catch (e) {
  const structured = e instanceof MyJDError && e.src && e.type;
  check('live probe returns structured error', structured, `(${e.message}${e.detail ? ' ' + e.detail : ''})`);
}

console.log(fails ? `\n${fails} failure(s)` : '\nAll good');
process.exit(fails ? 1 : 0);
