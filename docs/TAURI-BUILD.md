# Esports Data Desktop (Tauri 2, Windows x64) — build, release, updates

## What it is

A Tauri 2 window around the **bundled** frontend `dist/tauri` — the same approved 9.3.0 UI and platform layer as the
website, built by `web/build.mjs --target tauri`. Nothing is loaded from a website: the pages come from the app
(`http://tauri.localhost`); only API/session traffic goes to `https://esportsdata.online` (enforced at build time by
`check-bundle.mjs` and at run time by the CSP).

* Sign-in: Access Key → `/auth/verify` (client `tauri`) → opaque session token, kept in the app's WebView2 profile
  (`%LOCALAPPDATA%\online.esportsdata.desktop\EBWebView`, per Windows user, separate from every browser) → sent as
  `Authorization: Bearer`. Same session system as the web: one Access Key = one active session across web and desktop.
* Compiled-in: nothing secret. No Access Key, no API token, no admin or GitHub credential, no session. The only key in
  the binary is the updater **public** key.
* Plugins: `opener` (links → default browser), `notification`, `process` (restart after update), `updater`.
  Capabilities (`desktop/src-tauri/capabilities/default.json`): no file system, shell or HTTP plugin.

## Build (GitHub Actions, `windows-latest`)

`.github/workflows/tauri-windows.yml` runs on pushes to `web-tauri-app` touching the UI/desktop, or manually.

1. LF checkout (frontend byte-identical to the Linux build) → Node 22 → Rust stable `x86_64-pc-windows-msvc` → cache
2. versions must match: `web/version.json` = `desktop/package.json` = `Cargo.toml`
3. `npm ci --prefix desktop` (Tauri CLI pinned in `desktop/package-lock.json`)
4. `node web/build.mjs --target tauri` (API base `https://esportsdata.online`, commit stamped)
5. `check-bundle.mjs dist/tauri --target tauri` — no secrets, no localhost/dev endpoints, correct origin
6. `tauri build --ci --target x86_64-pc-windows-msvc` — release exe + per-user NSIS installer + updater signature
   (signing key from secrets `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`, exposed to this step only)
7. package: `EsportsData-Desktop-Windows-x64.zip` (= `EsportsData.exe` + `README.txt`),
   `EsportsData-Desktop-Windows-x64-setup.exe` + `.sig`, `SHA256SUMS.txt`, `manifest.json`, `latest.json`, `Cargo.lock`
8. `check-release.mjs` — ZIP content exactly exe + README; no key/token/GitHub token/private key/dev endpoint in any
   file; SHA256SUMS and manifest consistent; latest.json https + signature
9. smoke test: the real portable `EsportsData.exe` is started on the runner with WebView2 remote debugging enabled for
   that run only (environment variable), and `desktop-smoke.mjs` attaches over CDP: app starts, bundled frontend
   from `tauri.localhost`, desktop target, API `https://esportsdata.online`, protocol 1, Access Key gate on first
   launch, Tauri APIs present, no request outside the app and the production origin, no key/token in storage,
   window stays up; screenshot `smoke-first-launch.png`
10. artifact `EsportsData-Desktop-Windows-x64-<version>-<sha>` (30 days)

Manual run with **publish = true** additionally creates the GitHub release `desktop-v<version>` (immutable) and moves
the update channel release `desktop-stable` (its `latest.json`) to it.

Local reproduction (Windows, Node 22, Rust stable, VS Build Tools): the same commands as steps 3–7.
Do not build on the production VPS.

## Portable vs. installed — and why

| | Portable ZIP | Per-user installer (`-setup.exe`) |
|---|---|---|
| install | unzip anywhere writable, run `EsportsData.exe` | runs without UAC, installs to `%LOCALAPPDATA%\Esports Data` (`installMode: currentUser`) |
| admin rights | no | no |
| automatic update | **detects** updates; installing one moves to the per-user installed app | yes: signed, in-app |
| session | WebView2 profile per Windows user (shared by both forms: same app identifier) | same |

Tauri 2's updater on Windows installs **NSIS/MSI installers**; it cannot replace a bare exe in an arbitrary folder.
A fake "self-replacing portable exe" was deliberately not built. The robust layout is therefore the per-user NSIS
install (HKCU only, no Program Files, no HKLM, no service, no scheduled task); the portable ZIP stays available for
"download, unzip, run", and the first accepted update converts it into the per-user install (the session is kept
because both use the same WebView2 profile). No step requires elevation.

## WebView2

System **Evergreen** runtime (preinstalled on Windows 10 21H2+/11, updated by Windows). The installer embeds the
bootstrapper mode `downloadBootstrapper` (silent, per-user if missing). A Fixed Version runtime package (+~180 MB)
is not built: it only helps machines without any WebView2 (old Windows 10 LTSC/offline) and then needs its own
updates; add it as a separate artifact only if such machines appear.

## Automatic updates

* **Channel**: `stable`. **Manifest** (Tauri v2 format) `latest.json`:
  `{ "version", "notes", "pub_date", "platforms": { "windows-x86_64": { "signature", "url" } } }`,
  `url` = the signed installer on the immutable release `desktop-v<version>`.
* **Endpoints** (tried in order): `https://esportsdata.online/downloads/desktop/latest.json` (gateway, public),
  `https://github.com/Flareon02/newrep/releases/download/desktop-stable/latest.json`.
* **Verification**: the updater plugin checks the minisign signature of the downloaded installer against the public
  key in `tauri.conf.json` **before** running it; an unsigned or tampered file is rejected.
* **Flow**: check 15 s after start and every 6 h (and «Проверить обновления» in Settings → Аккаунт) → a prompt
  «Доступна новая версия X · Обновить / Позже» → download with progress → the installer runs passively (no
  questions, no UAC) → the app restarts on the new version, still signed in.
* **Compatibility**: only a new desktop release (higher version in latest.json) triggers an update. Web and server
  releases never touch latest.json. If the gateway API ever changes incompatibly it raises `protocol.minClient`;
  older desktop builds then show «Нужна новая версия приложения».
* **Rollback**: updates only move forward. To stop a bad release, point both `latest.json` copies back to the
  previous release's file; fix forward with a higher version. Older ZIPs stay on their releases.
* **Keys**: private key `TAURI_SIGNING_PRIVATE_KEY` + password in GitHub Actions secrets; backup on the server
  `/root/esportsdata-desktop-updater.key` and `.password` (root, 600) — move them to a password manager/offline
  storage. Losing the key means existing installations cannot verify new updates (they would need a manual install).

## Code signing (Authenticode)

The first builds are **unsigned** (functional). SmartScreen shows "unknown publisher" for new unsigned binaries and
AV products with reputation scoring (Trellix, etc.) may flag them. Recommended before wide distribution: an OV or EV
code-signing certificate, or Azure Trusted Signing, applied in CI to `EsportsData.exe` and the installer
(`bundle.windows.signCommand`). The updater signature is independent and stays.

## Release record

See the table at the end of this file (filled by each release).

| Version | Commit | CI run | Portable ZIP SHA256 | Installer SHA256 |
|---|---|---|---|---|
