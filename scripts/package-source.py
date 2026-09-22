#!/usr/bin/env python3
"""Package the current source snapshot, including uncommitted work and fixed vendor files."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "release"
PREFIX = "TripleTeam"
tracked = subprocess.check_output(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT
).decode().split("\0")
names = set(name for name in tracked if name)
names.update(str(path.relative_to(ROOT)) for path in (ROOT / "dist").glob("*.js"))
payload = []
for name in sorted(names):
    if name == "RELEASE_MANIFEST.json":
        continue
    path = ROOT / name
    parts = Path(name).parts
    if any(part in {".git", "node_modules", "upstream", "release", ".cache", "__pycache__"} for part in parts):
        continue
    if path.name.startswith(".env") and path.name != ".env.example":
        continue
    if path.suffix in {".log", ".pem", ".key", ".db", ".sqlite", ".pyc"} or path.name in {"auth.json", "daemon.json"}:
        continue
    if path.is_symlink():
        raise SystemExit("Refusing source symlink; review before packaging: " + name)
    if path.is_file():
        payload.append((name, path.read_bytes(), 0o755 if path.stat().st_mode & 0o111 else 0o644))

required = {"README.md", "README.zh-CN.md", "package.json", "package-lock.json", "LICENSE", "dist/cli.js", "dist/daemon.js", "dist/benchmark.js", "dist/control-extension.js", "vendor/pi/SNAPSHOT.md"}
missing = required - {name for name, _, _ in payload}
if missing:
    raise SystemExit("Run npm run build first; missing files: " + ", ".join(sorted(missing)))

manifest = {
    "format": "tripleteam-source-release/v1",
    "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    "snapshot": "current working tree, including uncommitted and untracked source files",
    "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data, _ in payload],
}
manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
payload.append(("RELEASE_MANIFEST.json", manifest_bytes, 0o644))
OUT.mkdir(exist_ok=True)
archive = OUT / "TripleTeam-source.tar.gz"
with archive.open("wb") as raw:
    with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as target:
            for name, data, mode in payload:
                entry = tarfile.TarInfo(PREFIX + "/" + name)
                entry.size, entry.mode, entry.mtime = len(data), mode, 0
                target.addfile(entry, io.BytesIO(data))
zip_path = OUT / "TripleTeam-source.zip"
with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
    for name, data, mode in payload:
        entry = zipfile.ZipInfo(PREFIX + "/" + name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = (0o100000 | mode) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        target.writestr(entry, data)
(OUT / "RELEASE_MANIFEST.json").write_bytes(manifest_bytes)
(OUT / "SHA256SUMS").write_text("".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n" for path in (archive, zip_path)))
print(json.dumps({"files": len(payload), "archives": [str(archive), str(zip_path)], "manifest": str(OUT / "RELEASE_MANIFEST.json")}, indent=2))
