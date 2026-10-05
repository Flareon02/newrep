# Extension 9.3.0 — AV / trust static audit

Goal: remove the legitimate reasons for antivirus heuristics, not evade detection. No behaviour was changed to bypass
an AV; the changes below are least-privilege and packaging hygiene.

| Item | Value |
|---|---|
| Artifact | `dist/Esports-Monitor-extension-9.3.0.zip` |
| SHA256 | `b95bc782f70b5fd8fb72697e155cc71fd2a6394b4328d274e729b319aed9f789` |
| Build commit | `beed4b6` (branch `extension-9.3.0`) |
| Build | `python3 tools/package-release.py --extension-only` from a clean worktree: tracked files only, fixed timestamps, sorted entries — two independent builds gave the identical SHA256 |
| Audit tool | `python3 tools/release-audit.py <zip>` (static: no network, no execution) |
| Optional helper (separate, not part of the extension) | `dist/Esports-Monitor-browser-host-9.3.0-optional.zip`, SHA256 `3b8702caa1a776458b01c1cb46931c0fdb2320900cdb3c8dadf14c043b93a01f` |

## 1. Leading false-positive candidate and what changed
The 9.2.0 production ZIP (and the 9.3 UX candidate) contained `browser-host/`: a PowerShell installer that, run with
`-ExecutionPolicy Bypass`, compiles C# source (`Add-Type -OutputAssembly … .exe`) into `%LOCALAPPDATA%`, writes three
`HKCU\…\NativeMessagingHosts` registry keys, and a host that calls `Process.Start`. All legitimate (Windows native
messaging, "open links in another browser"), but it is the classic script-dropper pattern AV heuristics look for, and
it is not runtime extension code.

- Not required for normal operation: the default link setting is "current browser" (`chrome.tabs.create`); with
  another browser chosen, any failure already falls back to the current browser.
- **REMOVED from the extension ZIP**; packaged separately as an optional helper. Its README now uses
  `Unblock-File` + `-ExecutionPolicy RemoteSigned` (one process only, no `Bypass`) and documents every registry write.
  It still compiles its included, readable C# source at install time; a signed prebuilt installer is recommended if
  the feature stays.
- `nativeMessaging` moved to `optional_permissions` (verified in Chromium 153: accepted as optional) and is requested
  only when the user selects another browser in Settings.

## 2. Findings diff (release-audit.py)
| Finding | A) 9.2.0 production | B) 9.3 UX candidate | C) 9.3.0 final |
|---|---|---|---|
| Result | FAIL | FAIL | **PASS** |
| Files | 200 | 207 | 193 |
| PowerShell scripts (.ps1) | 2 | 2 | **0** |
| Source to compile (.cs) | 1 | 1 | **0** |
| Registry modification code | 8 occurrences | 8 | **0** |
| Unexpected executables (.exe/.dll/.bat/.cmd/.msi, MZ/ELF) | 0 | 0 | **0** |
| Nested archives | 0 | 0 | **0** |
| Dynamic code (eval, new Function, string timers, WebAssembly, remote scripts, chrome.scripting) | 0 | 0 | **0** |
| Secrets (tokens, keys, cookies, auth headers, credential URLs, WireGuard, Cloudflare) | 0 | 0 | **0** |
| Local/private addresses (localhost, 127.0.0.1, RFC1918) | 0 | 0 | **0** |
| Plain-HTTP destinations | 0 | 0 | **0** |
| Source maps | 0 | 0 | **0** |
| Docs / dev files (.md, .txt, test/) | 11 | 11 | **0** |
| Required permissions | 7 | 7 | **4** |

## 3. Manifest permissions (least privilege)
| Permission | Why | Where | Removable? |
|---|---|---|---|
| `storage` | prefs, last-known feeds, logos | everywhere (`chrome.storage.local`, `session`) | no |
| `unlimitedStorage` | last-known LIVE/line/results/History copies can exceed the 10 MB quota; no install warning | `store.js` persist, `app.js` | kept (data loss risk otherwise) |
| `alarms` | background feed refresh while notifications are on | `background.js` `configureBackgroundAlarm` | no |
| `notifications` | "new match" notifications | `background.js` `notifyNew` | no (feature) |
| ~~`tabs`~~ | was used for `tabs.query({url})` on own pages | replaced by `runtime.getContexts` (Chrome 116+, verified) | **removed** |
| ~~`clipboardWrite`~~ | copies run inside user clicks; verified to work without it | `app.js` `copy()`, `app-admin.js` | **removed** |
| `nativeMessaging` (optional) | optional "open links in Chrome/Edge/Firefox" helper | `background.js` `openExternal`, Settings request | **now optional** |
| host `https://api.esportsdata.online/*` | the default server (fetch + SSE) | `server-config.js` | no |
| optional hosts `http://*/*`, `https://*/*` | a user-configured server address (staging/self-hosted); requested at runtime for that one origin, revoked when changed | `app-settings.js` | kept optional (no install warning) |
| Not used: `webRequest`, `scripting`, `downloads`, `cookies`, `history`, `<all_urls>`, content scripts | — | — | — |

Install-time warnings drop from "read your browsing history" (tabs) + "modify data you copy and paste"
(clipboardWrite) + "communicate with cooperating native applications" (nativeMessaging) to the two that
remain: "display notifications" and "read and change your data on api.esportsdata.online".

## 4. Network allowlist (what the release contacts)
| Destination | Protocol | Purpose |
|---|---|---|
| `api.esportsdata.online` (or the user's configured server) | HTTPS (fetch, SSE `EventSource`) | every data request: feeds, History, results, details, statistics, team-logo copies |
| `v2l.traincdn.com`, `cdn.gin.bet`, `cdn.cross.bet`, `hawk.live` | HTTPS images only | team logos when the server passes a bookmaker CDN URL (same allowlist as the server) |
| bookmaker / stream URLs from the data | HTTPS/HTTP, opened in a tab only on a user click | never fetched by the extension |
No WebSocket, no telemetry, no third-party analytics, no remote code. `http://www.w3.org` occurs only as the SVG
namespace. `https://host` is a comment. HLTV references parse files the user imports; nothing is fetched from HLTV.

## 5. Bundled file types (C)
`.js` 49 · `.css` 8 · `.html` 3 · `.json` 1 (manifest) · `.png` 4 (icons) · `.svg` 1 (brand mark) · `.webp` 127 (local Dota
hero images). Workers / `importScripts` load packaged files only. Base64 blobs: none (icons are URL-encoded SVG in
CSS). Code is hand-written, not minified or obfuscated.

## 6. Suspicious API scan (C)
`eval`/`new Function`/string timers/`document.write`/WebAssembly/`chrome.scripting`/remote `<script>`: none.
`URL.createObjectURL`: used only to let the user download their own settings/diagnostics/odds JSON (REQUIRED).
`new Worker('hltv-import-worker.js')`: local file for parsing an imported HLTV page (REQUIRED).
`chrome.runtime.sendNativeMessage`: only with the optional permission granted (REQUIRED for the optional feature).

## 7. False-positive reproduction (to do on Windows with Trellix — not available on this Linux host)
Run each and record the exact detection name, engine/DAT version and file:
- A. the ZIP as downloaded (9.2.0 vs 9.3.0)
- B. each extracted file (expectation: 9.2.0 hits on `browser-host/*.ps1`/`.cs`, 9.3.0 none)
- C. `manifest.json` alone
- D. the unpacked folder loaded in Chrome/Edge
- E. runtime (behaviour monitoring while the extension runs)
If 9.3.0 is still flagged: submit the ZIP and SHA256 to Trellix as a false positive (do not disable Trellix).

## 8. Distribution recommendation
| Channel | Publisher reputation | Updates | False-positive risk | Friction |
|---|---|---|---|---|
| Chrome Web Store (unlisted/private) | high (Google review, signed CRX) | automatic | lowest | one-time review; account fee |
| Edge Add-ons | high (Microsoft) | automatic | lowest on Windows/Trellix fleets | review |
| Enterprise policy (ExtensionInstallForcelist / self-hosted CRX + update URL) | your org's | automatic | low (signed CRX, IT-trusted) | needs managed browsers |
| Manual ZIP ("load unpacked") | none | manual | highest (unsigned archive, developer mode) | developer mode warning each start |
Recommendation: publish 9.3.0 as an **unlisted** Chrome Web Store / Edge Add-ons item (or enterprise force-install for
managed PCs); keep the manual ZIP only as a fallback. Keep the optional helper out of store packages; if it stays,
ship it as a signed installer.
