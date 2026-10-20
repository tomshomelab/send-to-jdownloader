# Send to JDownloader (Firefox for Android)

A tiny Firefox extension for your phone. Open any page, tap the extension, and it queues
the **page URL** and/or the **main video URL** on that page into JDownloader 2 on your PC.

It works in Firefox's **Private Browsing** once you flip one switch (see step 4).

> Why Firefox? Samsung Internet only allows Galaxy Store content blockers, Chrome for
> Android has no extensions at all, and Kiwi is dead. Firefox for Android is the only
> mainstream Android browser that lets you sideload your own extension.

## Folder layout

| Path | What |
|---|---|
| `extension/` | The extension source (load this with `web-ext run`, or zip it) |
| `build.ps1` | Zips `extension/` into `dist/send-to-jdownloader-<version>.zip` |
| `dist/` | Built zip, ready to upload to Mozilla for signing |
| `test/` | Node tests: crypto + live My.JDownloader probe, and a background harness |

## 1. Build the zip

```powershell
powershell -ExecutionPolicy Bypass -File C:\Claude_Storage\Send_to_JDownloader\build.ps1
```

(A built `dist/send-to-jdownloader-1.0.0.zip` is already included.)

## 2. Get it signed by Mozilla (one-off, free, ~5 minutes)

Firefox for Android will not keep an unsigned extension installed, so the zip has to be
signed by Mozilla. Unlisted ("self-distribution") signing is automatic and does not
publish anything.

1. Go to <https://addons.mozilla.org/developers/> and sign in (free Firefox account).
2. **Submit a New Add-on** → choose **On your own** (unlisted).
3. Upload `dist/send-to-jdownloader-1.0.0.zip`. It should pass validation with 0 errors.
4. Pick **Firefox and Firefox for Android** as compatible apps, no source code upload needed.
5. After a minute or two the status becomes *Approved*. Download the signed `.xpi`
   (Manage Status & Versions → the version → download).
6. Put the `.xpi` on the phone (Nextcloud, email to yourself, USB — anything).

To re-sign after a change, bump `"version"` in `manifest.json` first; AMO refuses
duplicate version numbers for the same add-on ID.

Alternative without the website, if you have AMO API keys:

```bash
npx web-ext sign --source-dir extension --channel unlisted --api-key <JWT issuer> --api-secret <JWT secret>
```

## 3. Install on the S23 Ultra

1. Install **Firefox** from the Play Store (release is fine for a signed xpi; Nightly or Beta
   also work and additionally accept unsigned zips). Needs Firefox 142 or newer, which any
   current install is.
2. Firefox → ⋮ → **Settings** → **About Firefox** → tap the Firefox logo **5 times** until it
   says *Debug menu enabled*.
3. Go back to Settings. Near the bottom there is now a **Secret Settings / Debug menu**
   section with **Install extension from file**. Pick the signed `.xpi`.
4. **Private browsing:** Settings → **Extensions** → **Send to JDownloader** → turn on
   **Run in private browsing**. Mozilla does not let an extension switch this on itself.

Development alternative (temporary install over USB, no signing): enable USB debugging and
remote debugging in Firefox on the phone, then on the PC run
`npx web-ext run --source-dir extension --target firefox-android --android-device <adb id> --firefox-apk org.mozilla.firefox`.
The extension disappears when Firefox closes, which is why the signed route above is the real one.

## 4. Connect it to JDownloader

### Option A: My.JDownloader (recommended; works on mobile data, no port forwarding)

1. On the PC: JDownloader → **Settings → My.JDownloader** → enter your My.JDownloader
   email + password → **Connect**. (Create an account at <https://my.jdownloader.org> if needed.)
2. On the phone: open the extension (⋮ → Extensions → Send to JDownloader → ⚙) and enter the
   same email + password → **Save & connect**. It lists your JDownloaders; pick one, **Save**.

The password is only used once to derive the two API secrets the protocol needs
(SHA-256 hashes). Only those hashes and the session token are stored on the phone.

### Option B: Local Click'n'Load (same Wi-Fi or Tailscale only)

1. On the PC: JDownloader → Settings → **Advanced Settings** → search `localhostonly` →
   untick **DeprecatedAPI: Localhost Only** (the Click'n'Load / port 9666 one) → restart JDownloader.
   Allow port 9666 through Windows Firewall for your private network.
2. On the phone: extension settings → choose *Local Click'n'Load* → enter the PC's LAN IP →
   **Test connection** → **Save**.
3. The first time links arrive, JDownloader may pop up a Click'n'Load permission dialog on the PC.
   Tick *remember* and allow it.

## Updating without touching the phone (after the first install)

The manifest has an `update_url` pointing at `updates.json` in the public GitHub repo
`tomshomelab/send-to-jdownloader`. Firefox on the phone checks it on its own and installs
new signed versions automatically. Releasing a change is then one command on the PC:

```bash
node C:\Claude_Storage\Send_to_JDownloader\publish.mjs
```

It bumps the patch version, lints, signs through Mozilla's API, drops the signed xpi into
`releases/`, rewrites `updates.json` with the version and SHA-256, commits and pushes.

One-off prerequisites:

1. API keys: <https://addons.mozilla.org/developers/addon/api/key/> → *Generate new credentials*.
   Save them as `C:\Claude_Storage\Authentication\amo_api.json`:
   `{ "issuer": "user:1234567:890", "secret": "..." }`
2. The public repo must exist and this folder must be pushed to it (`git remote add origin ...`).
3. The phone needs one manual install of the first version that contains `update_url`
   (1.0.2 or later). Versions before that have no idea where to look for updates.

Firefox checks for extension updates roughly once a day. To force it sooner, toggle the
extension off and on in Settings → Extensions, or restart Firefox.

## 5. Using it

On any page: ⋮ → **Extensions** → **Send to JDownloader**. The popup shows:

- **Page**: the current URL. *Queue page URL* is the right choice for YouTube, Twitter/X,
  Reddit, Vimeo, most tube sites and so on, because JDownloader's own site plugins resolve
  the page into the best quality stream.
- **Main video**: the extension scans every frame of the page for `<video>` elements
  (largest / currently playing wins), Open Graph and Twitter player tags, JSON-LD
  VideoObject data, direct `.mp4/.webm/.m3u8` links and known embed players. If it finds
  more than one it shows a dropdown, best guess first. *Queue video URL* sends that.
- *Queue both* sends page and video together in one package.

**Find the working link** (My.JDownloader only) sends the page plus every video candidate to
JDownloader in one batch, with the page as the source/referrer. JDownloader checks each one;
the extension then removes the offline ones (and bare `.html` page results when a real file was
found), so only links that will actually download are left.

**Videos listed on this page** appears on galleries, channels, search results and playlists.
The extension groups the page's links by URL shape and keeps the group that looks like a
video grid (thumbnails, durations, `/video/`, `/watch?v=` and similar). Playlist parameters are
stripped so each entry is exactly one video. Tick the ones you want (everything is ticked on a
gallery page; nothing is ticked on a watch page, where the list is usually "related videos") and
**Send to their own folder**: each video is checked by JDownloader, broken ones are removed, and
the rest download into `<JDownloader download folder>/<page title>`.

Every My.JDownloader send waits for JDownloader's verdict before reporting. The popup lists
what actually landed, or explains why nothing did: no handler for that link, already in the
list, hidden by a Link Filter rule, or broken. Direct video file links are sent as
`directhttp://…` so JDownloader treats them as files instead of silently ignoring them.
With **Videos only** (on by default), thumbnails, description text files, subtitles and web
pages that arrive alongside a video are removed. When no video is found, nothing is removed.

## Privacy

The extension stores **nothing about the sites you visit or what you download**:

- Storage on the phone holds only settings, the two derived My.JDownloader keys and the
  session token. Page addresses, titles and file names are never written to storage and
  never logged.
- The result of the last send is held in memory only, for the popup, and is wiped after
  10 minutes or when Firefox closes.
- Links travel to your JDownloader through My.JDownloader's relay, encrypted with a key
  derived from your password, so the relay can't read them. With Click'n'Load they go
  straight to your server on your own network.
- Tests and fixtures in this repo use invented pages on example.com only.

Links land in JDownloader's **LinkGrabber** (queued, not started) unless you tick
*Start downloading immediately* in settings. The page title becomes the package name.

### Known limits

- Sites that stream through MSE/DRM expose only a `blob:` source. The popup says so; send the
  page URL and let JDownloader's plugin handle it.
- Pages Firefox will not let extensions touch (about:, addons.mozilla.org, the PDF viewer)
  still let you send the page URL, just without video detection.
- My.JDownloader rate-limits logins. The extension caches the session and reconnects only
  when it expires, so this only bites if you hammer *Save & connect*.

## Tests

```bash
node test/myjd-test.mjs                      # crypto vectors + live probe with bogus creds
node test/myjd-test.mjs you@mail pw [url]    # real creds: lists devices, optionally queues url
node test/background-test.mjs                # background handlers against a fake Click'n'Load server
npx web-ext lint --source-dir extension      # Mozilla's validator (0 errors expected)
```
