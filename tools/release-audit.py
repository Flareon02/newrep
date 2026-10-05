#!/usr/bin/env python3
"""Static trust audit of a built extension ZIP (no network, no execution).

    python3 tools/release-audit.py dist/Esports-Monitor-extension-9.3.0.zip [--json out.json]

Checks: file types against a runtime allowlist, nested archives / executables / scripts, secrets and credentials,
dynamic-code and system APIs, network destinations, plain-HTTP / local / private addresses, manifest permissions.
Exit code 1 when any FAIL is found. Prints a JSON report.
"""
import hashlib, json, re, sys, zipfile, pathlib

ALLOWED_EXT = {'.js', '.css', '.html', '.json', '.png', '.webp', '.svg'}
BLOCKED_EXT = {'.exe', '.dll', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.sh', '.msi', '.jar', '.wasm', '.so', '.dylib', '.cs',
               '.zip', '.7z', '.rar', '.gz', '.tgz', '.tar', '.map', '.sqlite', '.sqlite3', '.db', '.log', '.env', '.pem', '.key', '.p12', '.pfx', '.conf'}
SECRETS = {
    'api token assignment': r'(?i)\b(api[_-]?token|access[_-]?token|auth[_-]?token|secret|password|passwd)\b\s*[:=]\s*[\'"][^\'"\s]{8,}[\'"]',
    'bearer literal': r'(?i)bearer\s+[a-z0-9._\-]{20,}',
    'authorization header literal': r'(?i)["\']authorization["\']\s*:\s*["\'](?:basic|bearer)\s+[a-z0-9]',
    'private key': r'-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'wireguard key': r'(?i)\b(PrivateKey|PresharedKey)\s*=\s*[A-Za-z0-9+/]{42,44}=',
    'cloudflare token': r'(?i)\bcf[_-]?(api[_-]?)?token\b|\bCLOUDFLARE_API_TOKEN\b',
    'aws key': r'\bAKIA[0-9A-Z]{16}\b',
    'jwt': r'\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}',
    'cookie literal': r'(?i)["\']cookie["\']\s*:\s*["\'][^"\']{10,}',
    'url with credentials': r'\b[a-z][a-z0-9+.-]*://[^/\s:@\'"]+:[^/\s@\'"]+@',
    'proxy credential': r'(?i)\bproxy[_-]?(user|pass|auth)\b\s*[:=]',
}
DYNAMIC = {
    'eval': r'\beval\s*\(', 'new Function': r'\bnew\s+Function\s*\(', 'string timer': r'set(?:Timeout|Interval)\(\s*[\'"`]',
    'document.write': r'document\.write\s*\(', 'WebAssembly': r'\bWebAssembly\b', 'chrome.scripting': r'chrome\.scripting',
    'remote script tag': r'<script[^>]+src=["\']https?:', 'remote importScripts': r'importScripts\([^)]*https?:',
    'child_process/shell': r'child_process|powershell|cmd\.exe|/bin/sh', 'registry': r'HKEY_|HKCU:|HKLM:',
}
LOCAL = r'\b(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b'

def main():
    path = pathlib.Path(sys.argv[1]); raw = path.read_bytes()
    report = {'artifact': str(path), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'fail': [], 'warn': [], 'info': {}}
    z = zipfile.ZipFile(path)
    names = [n for n in z.namelist() if not n.endswith('/')]
    types = {}
    hosts = {}
    for n in names:
        ext = pathlib.PurePosixPath(n).suffix.lower(); types[ext] = types.get(ext, 0) + 1
        low = n.lower()
        if ext in BLOCKED_EXT: report['fail'].append(f'blocked file type: {n}')
        elif ext not in ALLOWED_EXT and not low.endswith(('readme.md', 'changelog.md')) and ext != '.md': report['fail'].append(f'unexpected file type: {n}')
        if re.search(r'(^|/)(test|tests|__tests__|fixtures|bench|benchmarks|node_modules|\.git|tmp|logs?)/', low): report['fail'].append(f'dev path in artifact: {n}')
        data = z.read(n)
        if data[:2] == b'MZ' or data[:4] in (b'\x7fELF', b'PK\x03\x04', b'\xcf\xfa\xed\xfe') or data[:4] == b'\x00asm': report['fail'].append(f'binary/executable/archive signature: {n}')
        if ext in ('.png', '.webp'): continue
        text = data.decode('utf-8', 'replace')
        for label, rx in SECRETS.items():
            for m in re.finditer(rx, text): report['fail'].append(f'secret pattern [{label}] in {n}: {m.group(0)[:60]}')
        for label, rx in DYNAMIC.items():
            for m in re.finditer(rx, text): report['fail'].append(f'dynamic/system API [{label}] in {n}: {m.group(0)[:60]}')
        for m in re.finditer(LOCAL, text): report['fail'].append(f'local/private address in {n}: {m.group(0)}')
        for m in re.finditer(r'\b(?:https?|wss?)://([a-z0-9.\-]+)', text, re.I): hosts.setdefault(m.group(0).split('://')[0] + '://' + m.group(1).lower(), set()).add(n)
        for m in re.finditer(r'sourceMappingURL', text): report['fail'].append(f'source map reference in {n}')
        for m in re.finditer(r'[A-Za-z0-9+/]{400,}={0,2}', text):
            if 'data:image/svg' not in text[max(0, m.start() - 60):m.start()]: report['warn'].append(f'long base64-like blob ({len(m.group(0))} chars) in {n}')
    for h, fs in hosts.items():
        if h.startswith(('http://', 'ws://')) and 'www.w3.org' not in h: report['fail'].append(f'plain-HTTP destination {h} in {sorted(fs)}')
    manifest = json.loads(z.read([n for n in names if n.endswith('/manifest.json') or n == 'manifest.json'][0]))
    report['info'] = {'files': len(names), 'types': dict(sorted(types.items())), 'hosts': {h: sorted(fs) for h, fs in sorted(hosts.items())},
                      'version': manifest.get('version'), 'permissions': manifest.get('permissions'), 'host_permissions': manifest.get('host_permissions'),
                      'optional_host_permissions': manifest.get('optional_host_permissions'), 'csp': manifest.get('content_security_policy')}
    report['result'] = 'PASS' if not report['fail'] else 'FAIL'
    out = json.dumps(report, indent=2, ensure_ascii=False)
    print(out)
    if '--json' in sys.argv: pathlib.Path(sys.argv[sys.argv.index('--json') + 1]).write_text(out)
    sys.exit(1 if report['fail'] else 0)

main()
