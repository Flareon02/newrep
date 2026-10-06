// Scans the packaged desktop release (CI, after packaging) for anything that must not ship.
//
//   node web/scripts/check-release.mjs <out-dir> <unzipped-portable-dir>
//
// - the portable ZIP holds exactly EsportsData.exe + README.txt (no PDB, no nested archive, no dev config);
// - no binary contains an Access Key, a session token, a GitHub token, a private signing key, or the gateway's
//   development endpoints (the frontend inside the exe is compressed; it is checked before the build by
//   check-bundle.mjs, which also enforces https://esportsdata.online as the API origin);
// - latest.json points at an https URL for windows-x86_64 with a signature, and manifest.json matches SHA256SUMS.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [outDir, portableDir] = process.argv.slice(2).map((p) => path.resolve(p));
const problems = [];
const expected = ['EsportsData.exe', 'README.txt'];
const portable = fs.readdirSync(portableDir).sort();
if (JSON.stringify(portable) !== JSON.stringify(expected.slice().sort())) problems.push(`portable ZIP content: ${portable.join(', ')} (expected ${expected.join(', ')})`);

const PATTERNS = [
  [/emu_[0-9a-f]{48}/, 'Access Key literal'],
  [/eds_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, 'session token literal'],
  [/gh[pousr]_[A-Za-z0-9]{36}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{40,}/, 'GitHub token'],
  [/rsign encrypted secret key|minisign encrypted secret key/i, 'updater private key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/TAURI_SIGNING_PRIVATE_KEY\s*=/, 'signing key assignment'],
  [/(?:localhost|127\.0\.0\.1):(?:8090|1420|5173|3000)\b/, 'development endpoint'],
  [/http:\/\/(?:api\.)?esportsdata\.online/, 'plain-HTTP production endpoint'],
];
const scan = (file, label) => {
  const text = fs.readFileSync(file).toString('latin1');
  for (const [re, what] of PATTERNS) if (re.test(text)) problems.push(`${label}: ${what}`);
};
scan(path.join(portableDir, 'EsportsData.exe'), 'EsportsData.exe');
for (const f of fs.readdirSync(outDir)) if (/\.(exe|zip|json|txt|sig)$/i.test(f)) scan(path.join(outDir, f), f);
if (fs.readdirSync(outDir).some((f) => /\.pdb$|\.map$/i.test(f))) problems.push('debug symbols or source maps in the release directory');

const latest = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
const win = latest.platforms?.['windows-x86_64'];
if (!win?.signature || !/^https:\/\//.test(win?.url || '')) problems.push('latest.json: windows-x86_64 needs an https url and a signature');
const sums = Object.fromEntries(fs.readFileSync(path.join(outDir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/).reverse()));
for (const [name, sum] of Object.entries(sums)) {
  const actual = createHash('sha256').update(fs.readFileSync(path.join(outDir, name))).digest('hex');
  if (actual !== sum) problems.push(`${name}: SHA256 mismatch`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
if (manifest.sha256 !== sums[manifest.file]) problems.push('manifest.json sha256 does not match the ZIP');
if (problems.length) { console.error('release check FAILED:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log(`release check passed: ${Object.keys(sums).length} files, portable ZIP = ${portable.join(' + ')}`);
