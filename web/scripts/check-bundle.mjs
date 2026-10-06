// Release check for a built frontend (dist/web or dist/tauri), also run in CI before the desktop app is built.
// Fails when the bundle contains anything that must never ship:
//   - credentials: Access Keys (emu_…), session tokens (eds_…), an API token literal, or the exact secrets given
//     with --secret-file (on the server: the real API token file, compared in memory and never printed);
//   - source maps, or development endpoints (localhost / 127.0.0.1 / plain http API) in a desktop build;
//   - a desktop build that does not point at the expected production origin.
//
//   node web/scripts/check-bundle.mjs dist/web [--secret-file /etc/esportsdata-web/upstream-token]
//   node web/scripts/check-bundle.mjs dist/tauri --target tauri [--api-base https://esportsdata.online]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkBundle(dir, { target = 'web', apiBase = 'https://esportsdata.online', secrets = [] } = {}) {
  const problems = [];
  const files = walk(dir);
  const text = (f) => fs.readFileSync(f, 'utf8');
  const textual = files.filter((f) => /\.(js|mjs|html|css|json|txt|svg)$/i.test(f));
  for (const f of files) {
    const rel = path.relative(dir, f);
    if (/\.map$/i.test(f)) problems.push(`${rel}: source map shipped`);
    if (!textual.includes(f)) {
      const raw = fs.readFileSync(f);
      for (const s of secrets) if (s && raw.includes(Buffer.from(s))) problems.push(`${rel}: contains a configured secret`);
      continue;
    }
    const t = text(f);
    if (/sourceMappingURL=/.test(t)) problems.push(`${rel}: sourceMappingURL reference`);
    if (/\bemu_[0-9a-f]{48}\b/i.test(t)) problems.push(`${rel}: Access Key literal`);
    if (/\beds_[A-Za-z0-9_-]{43}\b/.test(t)) problems.push(`${rel}: session token literal`);
    if (/API_TOKEN\s*[:=]\s*['"][^'"]{8,}/.test(t)) problems.push(`${rel}: API token assignment`);
    if (/Bearer\s+[A-Za-z0-9_-]{24,}/.test(t)) problems.push(`${rel}: hard-coded Bearer credential`);
    for (const s of secrets) if (s && t.includes(s)) problems.push(`${rel}: contains a configured secret`);
    if (target === 'tauri' && /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(t.replace(/tauri\.localhost/g, ''))) problems.push(`${rel}: development endpoint (localhost) in a desktop build`);
  }
  const cfgFile = path.join(dir, 'platform-config.js');
  if (!fs.existsSync(cfgFile)) problems.push('platform-config.js missing');
  else {
    const m = /__EDS_BUILD__=Object\.freeze\((.*)\);/.exec(text(cfgFile));
    const cfg = m ? JSON.parse(m[1]) : null;
    if (!cfg) problems.push('platform-config.js unreadable');
    else {
      if (cfg.target !== target) problems.push(`platform-config target ${cfg.target}, expected ${target}`);
      if (target === 'tauri' && cfg.apiBase !== apiBase) problems.push(`desktop API base ${cfg.apiBase}, expected ${apiBase}`);
      if (target === 'web' && cfg.apiBase !== '') problems.push('web build must use its own origin (apiBase "")');
      for (const s of cfg.scripts || []) if (!fs.existsSync(path.join(dir, s.split('?')[0]))) problems.push(`script ${s} listed but missing`);
    }
  }
  for (const required of ['index.html', 'platform.js', 'app.js', 'background-web.js']) if (!fs.existsSync(path.join(dir, required))) problems.push(`${required} missing`);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) problems.push('extension manifest.json shipped');
  return { files: files.length, problems };
}

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), opt = (n, d = '') => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const secrets = args.flatMap((a, i) => (a === '--secret-file' ? [fs.readFileSync(args[i + 1], 'utf8').trim()] : []));
  const target = opt('target', 'web');
  const result = checkBundle(dir, { target, apiBase: opt('api-base', 'https://esportsdata.online'), secrets });
  if (result.problems.length) { console.error(`bundle check FAILED (${dir}):\n - ` + result.problems.join('\n - ')); process.exit(1); }
  console.log(`bundle check passed: ${result.files} files in ${dir} (${target}${secrets.length ? `, ${secrets.length} secret(s) compared` : ''})`);
}
