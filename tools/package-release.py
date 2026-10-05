#!/usr/bin/env python3
"""Build release ZIPs from the files tracked in Git (HEAD), the way the originals were delivered.

    python3 tools/package-release.py            ->  dist/Esports-Monitor-server-<ver>.zip
                                                     dist/Esports-Monitor-extension-<ver>.zip
                                                     dist/Esports-Monitor-browser-host-<ver>-optional.zip
    python3 tools/package-release.py --extension-only   (extension + optional helper, no server ZIP)

Server ZIP: top folder astek-monitor-server-v<ver>/ with executable *.sh and the two empty
secrets/ placeholder files that docker-compose bind-mounts (real values are created on the
server by configure-ggbet-relay.sh / upgrade.sh and are never part of a release).
Extension ZIP: top folder Esports-Monitor-v<ver>/, runtime files only (no test/, no Markdown docs). It never contains
the optional Windows helper (browser-host/: PowerShell installer + C# source, registry writes); that helper is a
separate, optional ZIP so the extension package holds no scripts or executables.
Only committed files are packaged, so secrets and local data cannot leak into a release.
"""
import io, json, pathlib, subprocess, sys, tarfile, zipfile

root = pathlib.Path(__file__).resolve().parent.parent
dist = root / "dist"


def tracked(subdir):
    """Yield (relative path, bytes, executable) for every tracked file under subdir at HEAD."""
    data = subprocess.run(["git", "archive", "--format=tar", f"HEAD:{subdir}"], cwd=root, check=True, stdout=subprocess.PIPE).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            if member.isfile():
                yield member.name, tar.extractfile(member).read(), bool(member.mode & 0o111)


def write(zf, arcname, payload, executable=False, mode=None):
    info = zipfile.ZipInfo(arcname, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = ((mode if mode is not None else (0o755 if executable else 0o644)) | 0o100000) << 16
    zf.writestr(info, payload)


def build_server(version):
    top = f"astek-monitor-server-v{version}"
    target = dist / f"Esports-Monitor-server-{version}.zip"
    with zipfile.ZipFile(target, "w") as zf:
        for name, payload, executable in tracked("server"):
            if name == "secrets/.gitkeep":
                continue
            write(zf, f"{top}/{name}", payload, executable)
        for placeholder in ("secrets/ggbet-relay-secret", "secrets/ggbet-relay-ca.pem"):
            write(zf, f"{top}/{placeholder}", b"", mode=0o600)
    return target


def build_extension(version):
    top = f"Esports-Monitor-v{version}"
    target = dist / f"Esports-Monitor-extension-{version}.zip"
    with zipfile.ZipFile(target, "w") as zf:
        for name, payload, executable in sorted(tracked("extension")):
            if not runtime_file(name):
                continue
            write(zf, f"{top}/{name}", payload, executable)
    return target


RUNTIME_EXT = (".js", ".css", ".html", ".json", ".png", ".webp", ".svg")


def runtime_file(name):
    """Only files the browser loads at runtime go into the extension package."""
    return not name.startswith(("test/", "browser-host/")) and name.lower().endswith(RUNTIME_EXT)


def build_browser_host(version):
    top = f"Esports-Monitor-browser-host-v{version}"
    target = dist / f"Esports-Monitor-browser-host-{version}-optional.zip"
    with zipfile.ZipFile(target, "w") as zf:
        for name, payload, executable in sorted(tracked("browser-host")):
            write(zf, f"{top}/{name}", payload, executable)
    return target


def main():
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
    if status:
        print("Refusing to package with uncommitted changes (releases are built from HEAD):\n" + status, file=sys.stderr)
        return 1
    dist.mkdir(exist_ok=True)
    server_version = json.loads((root / "server/package.json").read_text())["version"]
    extension_version = json.loads((root / "extension/manifest.json").read_text())["version"]
    builds = [] if "--extension-only" in sys.argv else [build_server(server_version)]
    builds += [build_extension(extension_version), build_browser_host(extension_version)]
    for path in builds:
        print(f"{path.relative_to(root)}  {path.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
