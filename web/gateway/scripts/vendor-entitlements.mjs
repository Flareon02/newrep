// Copies the monitor server's entitlement rules (server/src/entitlements.js) into the gateway.
//
// The gateway must decide "who may see what" exactly like the server does, so it runs the server's own code instead
// of a re-implementation. The only change is the import of ./utils.js (file storage for UserStore), which would pull
// the whole collector configuration into the gateway; the gateway never uses UserStore's file storage.
//
//   node web/gateway/scripts/vendor-entitlements.mjs           write src/vendor/entitlements.js
//   node web/gateway/scripts/vendor-entitlements.mjs --check   exit 1 when the vendored copy is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = new URL('../../../server/src/entitlements.js', import.meta.url);
const target = new URL('../src/vendor/entitlements.js', import.meta.url);
const IMPORT = "import { readJson, writeJson } from './utils.js';";
const STUB = "// [gateway] vendored from server/src/entitlements.js by web/gateway/scripts/vendor-entitlements.mjs - do not edit.\n"
  + "const readJson = async () => { throw new Error('UserStore file storage is not available in the gateway'); };\n"
  + "const writeJson = readJson;";

export function vendored() {
  const text = fs.readFileSync(source, 'utf8');
  if (!text.includes(IMPORT)) throw new Error('server/src/entitlements.js changed its utils import; update vendor-entitlements.mjs');
  return text.replace(IMPORT, STUB);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const expected = vendored();
  if (process.argv.includes('--check')) {
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (actual !== expected) { console.error('web/gateway/src/vendor/entitlements.js is out of date: run node web/gateway/scripts/vendor-entitlements.mjs'); process.exit(1); }
    console.log('vendored entitlements up to date');
  } else {
    fs.writeFileSync(target, expected);
    console.log('wrote', fileURLToPath(target));
  }
}
