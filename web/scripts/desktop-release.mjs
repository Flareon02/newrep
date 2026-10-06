// Release metadata for the Windows desktop build (run in CI after packaging).
//
//   node web/scripts/desktop-release.mjs <out-dir> --version 1.0.0 --commit <sha> [--download-base URL]
//
// <out-dir> must contain EsportsData-Desktop-Windows-x64.zip, EsportsData-Desktop-Windows-x64-setup.exe and its .sig.
// Writes:
//   SHA256SUMS.txt  sha256 of every shipped file
//   manifest.json   release manifest (what the website's Settings → Аккаунт shows; /downloads/desktop/manifest.json)
//   latest.json     Tauri updater manifest (windows-x86_64 → signed per-user NSIS installer)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2), opt = (n, d = '') => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const out = path.resolve(args[0]);
const version = opt('version'), commit = opt('commit');
const downloadBase = opt('download-base', `https://github.com/Flareon02/newrep/releases/download/desktop-v${version}`).replace(/\/+$/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('--version must be x.y.z');
const ZIP = 'EsportsData-Desktop-Windows-x64.zip', SETUP = 'EsportsData-Desktop-Windows-x64-setup.exe';
const sha = (f) => createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex');
for (const f of [ZIP, SETUP, SETUP + '.sig']) if (!fs.existsSync(path.join(out, f))) throw new Error(`${f} missing in ${out}`);
const signature = fs.readFileSync(path.join(out, SETUP + '.sig'), 'utf8').trim();
if (!signature) throw new Error('empty updater signature');
const releasedAt = new Date().toISOString();
const files = [ZIP, SETUP, SETUP + '.sig'].map((name) => ({ name, sha256: sha(name), size: fs.statSync(path.join(out, name)).size }));
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
const manifest = {
  name: 'Esports Data Desktop', channel: 'stable', version, commit, releasedAt,
  // The website serves these files from /downloads/desktop/ (same names); GitHub release is the canonical source.
  url: `/downloads/desktop/${ZIP}`, file: ZIP, sha256: files[0].sha256, size: files[0].size, executable: 'EsportsData.exe',
  installer: { url: `/downloads/desktop/${SETUP}`, file: SETUP, sha256: files[1].sha256, size: files[1].size, scope: 'per-user (no administrator rights)' },
  webview2: 'system (Evergreen runtime; preinstalled on Windows 10/11)', signed: { authenticode: false, updater: 'minisign (Tauri updater key)' },
  sources: { github: downloadBase },
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const latest = { version, notes: `Esports Data Desktop ${version} (${commit.slice(0, 10)})`, pub_date: releasedAt, platforms: { 'windows-x86_64': { signature, url: `${downloadBase}/${SETUP}` } } };
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(files.map((f) => `${f.sha256}  ${f.name}  (${f.size} bytes)`).join('\n'));
