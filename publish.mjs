#!/usr/bin/env node
/* One-command release: bump version -> sign with Mozilla -> publish xpi + updates.json -> git push.
   Firefox on the phone then updates itself from updates.json (manifest update_url).

   Usage:  node publish.mjs            (bumps the patch version, e.g. 1.0.2 -> 1.0.3)
           node publish.mjs 1.1.0      (sets an explicit version)
           node publish.mjs --no-push  (everything except git push)

   Needs:  C:\Claude_Storage\Authentication\amo_api.json  ->  { "issuer": "user:123:456", "secret": "..." }
           from https://addons.mozilla.org/developers/addon/api/key/ */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ext = path.join(root, 'extension');
const manifestPath = path.join(ext, 'manifest.json');
const keysPath = 'C:/Claude_Storage/Authentication/amo_api.json';
const RAW_BASE = 'https://raw.githubusercontent.com/tomshomelab/send-to-jdownloader/main';

const args = process.argv.slice(2);
const noPush = args.includes('--no-push');
const explicit = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const run = (cmd, opts = {}) => { console.log(`> ${cmd}`); return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts }); };

// 0. preflight
if (!existsSync(keysPath)) {
  console.error(`Missing ${keysPath}\nCreate API keys at https://addons.mozilla.org/developers/addon/api/key/ and save them as {"issuer":"user:...","secret":"..."}`);
  process.exit(1);
}
const keys = JSON.parse(readFileSync(keysPath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const addonId = manifest.browser_specific_settings.gecko.id;

// 1. bump version
const [maj, min, pat] = manifest.version.split('.').map(Number);
const version = explicit || `${maj}.${min}.${pat + 1}`;
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Version ${version}`);

// 2. lint + sign (unlisted channel = self-distributed, nothing is published on AMO)
run('npx --yes web-ext lint --source-dir extension --self-hosted');
const signedDir = path.join(root, 'dist', 'signed');
mkdirSync(signedDir, { recursive: true });
run(`npx --yes web-ext sign --source-dir extension --artifacts-dir "${signedDir}" --channel unlisted --api-key "${keys.issuer}" --api-secret "${keys.secret}"`);

// 3. pick the freshly signed xpi
const xpi = readdirSync(signedDir).filter((f) => f.endsWith('.xpi') && f.includes(version))
  .map((f) => path.join(signedDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!xpi) { console.error('No signed xpi found'); process.exit(1); }

// 4. publish into releases/ + updates.json
const relDir = path.join(root, 'releases');
mkdirSync(relDir, { recursive: true });
const outName = `send_to_jdownloader-${version}.xpi`;
copyFileSync(xpi, path.join(relDir, outName));
const hash = createHash('sha256').update(readFileSync(xpi)).digest('hex');

const updatesPath = path.join(root, 'updates.json');
const updates = existsSync(updatesPath) ? JSON.parse(readFileSync(updatesPath, 'utf8')) : { addons: {} };
const entry = updates.addons[addonId] || (updates.addons[addonId] = { updates: [] });
entry.updates = entry.updates.filter((u) => u.version !== version);
entry.updates.push({ version, update_link: `${RAW_BASE}/releases/${outName}`, update_hash: `sha256:${hash}` });
entry.updates = entry.updates.slice(-5);               // keep the last five
writeFileSync(updatesPath, JSON.stringify(updates, null, 2) + '\n');
console.log(`releases/${outName} + updates.json written`);

// 5. commit + push
run('git add -A');
run(`git commit -m "Release ${version}"`);
if (!noPush) run('git push');
console.log(`\nDone. Phones with ${addonId} will pick up ${version} on their next update check.`);
