"""Runs as the deployment user on the Paperclip instance."""
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path, PurePosixPath
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack

STAGE = Path(__file__).resolve().parent
HOME = STAGE.parent.parent
ROOT = HOME / "runtime/node_modules"
UI = "@paperclipai/server/ui-dist/"
HEALTH = "http://127.0.0.1:3100"
ENV = dict(os.environ, XDG_RUNTIME_DIR=f"/run/user/{os.getuid()}")
REFERENCE = re.compile(r"(?<![\w.-])([\w.-]+\.(?:js|css|woff2?))(?![\w.-])")
BACKEND = re.compile(r"@paperclipai/(?:server/dist/(?:routes|services)/|shared/dist/)[\w./-]+\.js")
PROTECTED = ("dsp7-install.py", "dsp7-install.ps1", "dsp7-bridge.zip", "dsp7-bridge-manifest.json")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(name, value):
    target = STAGE / name
    pending = target.with_suffix(".tmp")
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    os.replace(pending, target)


def read(name):
    return json.loads((STAGE / name).read_text())


def safe_target(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != name:
        raise ValueError("Unsafe release target: " + name)
    valid = BACKEND.fullmatch(name) or name in (UI + "index.html", UI + "sw.js") or re.fullmatch(
        re.escape(UI) + r"assets/[\w.-]+", name,
    )
    if not valid:
        raise ValueError("Unsupported release target: " + name)
    destination = ROOT / name
    if not destination.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Release target escapes the runtime: " + name)
    return destination


def asset_graph():
    index = (ROOT / UI / "index.html").read_text()
    assets = ROOT / UI / "assets"
    available = {entry.name for entry in assets.iterdir() if entry.is_file()}
    pending = set(REFERENCE.findall(index)) & available
    text, links = {}, {}
    while pending:
        name = pending.pop()
        if name in text or not name.endswith((".js", ".css")):
            continue
        text[name] = (assets / name).read_text()
        links[name] = set(REFERENCE.findall(text[name])) & available
        pending.update(links[name] - text.keys())
    return index, text, links


def scan():
    request = read("request.json")
    result = {"backend": {}}
    for name in request["backend"]:
        dest = safe_target(name)
        result["backend"][name] = sha(dest) if dest.is_file() else None
    if request["ui"]:
        _, assets, _ = asset_graph()
        chosen = []
        for markers in request["ui"]:
            matches = [name for name, value in assets.items() if name.endswith(".js") and all(m in value for m in markers)]
            if len(matches) != 1:
                raise ValueError(f"Expected one reachable asset for {markers}, found {sorted(matches)}")
            name = matches[0]
            chosen.append({"asset": name, "sha": sha(ROOT / UI / "assets" / name)})
        if len({item["asset"] for item in chosen}) != len(chosen):
            raise ValueError("Combine edits targeting the same UI asset")
        result.update(ui=chosen, index=sha(ROOT / UI / "index.html"), sw=sha(ROOT / UI / "sw.js"))
    write("baseline.json", result)
    print(json.dumps(result, ensure_ascii=False))


def rewrite_ui(baseline, inputs):
    if not baseline.get("ui"):
        return {}
    if sha(ROOT / UI / "index.html") != baseline["index"] or sha(ROOT / UI / "sw.js") != baseline["sw"]:
        raise ValueError("Online entry or service worker changed after reading the baseline")
    index, assets, links = asset_graph()
    changes = {}
    for position, item in enumerate(baseline["ui"]):
        name = item["asset"]
        if name not in assets or sha(ROOT / UI / "assets" / name) != item["sha"]:
            raise ValueError("Online asset changed: " + name)
        value = (inputs / f"ui-{position}.js").read_text()
        if value != assets[name]:
            changes[name] = value
    if not changes:
        return {}
    renamed = set(changes)
    while True:
        parents = {name for name, children in links.items() if children & renamed}
        if parents <= renamed:
            break
        renamed.update(parents)
    names = {
        name: f"release-{hashlib.sha256(name.encode()).hexdigest()[:12]}-{STAGE.name.split('-')[-1]}.{name.rsplit('.', 1)[-1]}"
        for name in renamed
    }

    def rewrite(value):
        return REFERENCE.sub(lambda match: names.get(match[1], match[1]), value)

    worker = (ROOT / UI / "sw.js").read_text()
    worker, count = re.subn(r'const BUILD_ID = "[^"]+";', f'const BUILD_ID = "{STAGE.name}";', worker)
    if count != 1:
        raise ValueError("Service worker build ID is absent or ambiguous")
    payload = {UI + "assets/" + names[name]: rewrite(changes.get(name, assets[name])).encode() for name in renamed}
    payload[UI + "index.html"] = rewrite(index).encode()
    payload[UI + "sw.js"] = rewrite(worker).encode()
    if payload[UI + "index.html"] == index.encode():
        raise ValueError("Updated UI asset has no entry point")
    return payload


def prepare():
    baseline = read("baseline.json")
    inputs = STAGE / "inputs"
    payload = rewrite_ui(baseline, inputs)
    for position, (name, digest) in enumerate(baseline["backend"].items()):
        dest = safe_target(name)
        if (sha(dest) if dest.is_file() else None) != digest:
            raise ValueError("Online module changed: " + name)
        value = (inputs / f"backend-{position}.js").read_bytes()
        if digest != hashlib.sha256(value).hexdigest():
            payload[name] = value
    installed, hashes = {}, {}
    for name, contents in payload.items():
        dest = safe_target(name)
        installed[name] = sha(dest) if dest.is_file() else None
        if name.startswith(UI + "assets/") and installed[name] is not None:
            raise ValueError("UI release asset already exists: " + name)
        file = STAGE / "payload" / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(contents)
        hashes[name] = sha(file)
        if name.endswith(".js"):
            subprocess.run(["node", "--input-type=module", "--check"], input=contents, check=True)
    write("manifest.json", {"installed": installed, "hashes": hashes})
    print(json.dumps({"release": STAGE.name, "uiFiles": sum(name.startswith(UI) for name in hashes),
                      "backendFiles": sum(not name.startswith(UI) for name in hashes)}, ensure_ascii=False))


def probe():
    backend = [name for name in read("manifest.json")["hashes"] if not name.startswith(UI)]
    if not backend:
        return
    sandbox = STAGE / "probe/node_modules"
    sandbox.mkdir(parents=True)
    for source in ROOT.iterdir():
        if source.name != "@paperclipai":
            (sandbox / source.name).symlink_to(source)
    scope = sandbox / "@paperclipai"
    scope.mkdir()
    for source in (ROOT / "@paperclipai").iterdir():
        destination = scope / source.name
        if source.name not in {"shared", "server"}:
            destination.symlink_to(source)
            continue
        destination.mkdir()
        os.link(source / "package.json", destination / "package.json")
        if (source / "node_modules").is_dir():
            (destination / "node_modules").symlink_to(source / "node_modules")
        shutil.copytree(source / "dist", destination / "dist", copy_function=os.link, symlinks=True)
    for name in backend:
        file = sandbox / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.unlink(missing_ok=True)
        shutil.copy2(STAGE / "payload" / name, file)
    urls = [(sandbox / name).as_uri() for name in backend]
    code = "for (const url of " + json.dumps(urls) + ") await import(url); process.exit(0);"
    subprocess.run(["node", "--input-type=module", "-e", code], check=True, timeout=75)


def healthy():
    try:
        with urllib.request.urlopen(HEALTH + "/api/health", timeout=4) as response:
            return json.load(response).get("status") == "ok"
    except (OSError, ValueError):
        return False


def main_pid():
    return int(subprocess.check_output(["systemctl", "--user", "show", "paperclip.service", "-p", "MainPID", "--value"],
                                       env=ENV, text=True))


def restart():
    subprocess.run(["systemctl", "--user", "restart", "paperclip.service"], env=ENV, check=True, timeout=120)
    until = time.monotonic() + 100
    while time.monotonic() < until:
        if healthy():
            return
        time.sleep(1)
    raise RuntimeError("Backend failed its health check")


def replace(destination, source):
    temporary = destination.with_name("." + destination.name + "." + STAGE.name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def verify_http(item):
    name, digest = item
    file = safe_target(name)
    if sha(file) != digest:
        raise ValueError("Installed hash mismatch: " + name)
    if not name.startswith(UI):
        return
    with urllib.request.urlopen(HEALTH + "/" + name.removeprefix(UI), timeout=15) as response:
        contents = response.read()
        mime = response.headers.get("Content-Type", "")
    if hashlib.sha256(contents).hexdigest() != digest or (name.endswith(".js") and "javascript" not in mime):
        raise ValueError("Invalid HTTP asset: " + name)


def deploy():
    manifest = read("manifest.json")
    hashes = manifest["hashes"]
    if not hashes:
        write("release.json", {"release": STAGE.name, "status": "unchanged"})
        return
    with ExitStack() as stack:
        for name in ("ui-static-release.lock", "delivery-backend-release.lock"):
            lock = stack.enter_context((STAGE.parent / name).open("a"))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deploy_locked(hashes, manifest["installed"])


def deploy_locked(hashes, original):
    for name in hashes:
        dest = safe_target(name)
        if (sha(dest) if dest.is_file() else None) != original[name]:
            raise ValueError("Online baseline changed: " + name)
        if sha(STAGE / "payload" / name) != hashes[name]:
            raise ValueError("Release payload changed: " + name)
    if not healthy():
        raise RuntimeError("Current instance failed health check")
    protected = [HOME / "server.env", *[ROOT / UI / name for name in PROTECTED],
                 *Path.home().joinpath(".config/systemd/user/paperclip.service.d").glob("*.conf")]
    protected_hashes = {path: sha(path) for path in protected}
    pid = main_pid()
    backup = STAGE / "backup"
    backup.mkdir(mode=0o700)
    for name, digest in original.items():
        if digest is not None:
            target = backup / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_target(name), target)
    backend = any(not name.startswith(UI) for name in hashes)
    database = None
    if backend:
        database = json.loads(subprocess.check_output(
            ["node", str(STAGE / "backup.cjs"), str(HOME), str(backup)], env=ENV, text=True, timeout=150,
        ))
        archive = Path(database["backupFile"])
        if archive.parent != backup or not archive.is_file() or not archive.stat().st_size:
            raise RuntimeError("Database backup was not created")
        subprocess.run(["gzip", "-t", str(archive)], check=True, timeout=30)
    entry_names = {UI + "index.html", UI + "sw.js"}
    applied = []
    try:
        for name in hashes:
            if name not in entry_names:
                replace(safe_target(name), STAGE / "payload" / name)
                applied.append(name)
        if backend:
            restart()
            if main_pid() == pid or not main_pid():
                raise RuntimeError("Backend PID did not change")
        for name in hashes:
            if name in entry_names:
                replace(safe_target(name), STAGE / "payload" / name)
                applied.append(name)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(verify_http, hashes.items()))
        if not healthy() or any(sha(path) != digest for path, digest in protected_hashes.items()):
            raise RuntimeError("Instance health or protected file verification failed")
    except Exception as error:
        try:
            for name in reversed(applied):
                if original[name] is None:
                    safe_target(name).unlink(missing_ok=True)
                else:
                    replace(safe_target(name), backup / name)
            if backend:
                restart()
            for name, digest in original.items():
                if digest is None:
                    if safe_target(name).exists():
                        raise RuntimeError("Added file remained after rollback: " + name)
                else:
                    verify_http((name, digest))
            write("rollback.json", {"restored": True, "reason": str(error)})
        except Exception as rollback_error:
            write("rollback.json", {"restored": False, "reason": str(error), "rollbackError": str(rollback_error)})
            raise RuntimeError("Rollback could not be verified; check " + str(STAGE / "rollback.json")) from rollback_error
        raise RuntimeError("Release failed; original version restored. " + str(error)) from error
    receipt = {"release": STAGE.name, "status": "deployed", "health": "ok", "beforePid": pid,
               "afterPid": main_pid(), "backup": str(backup), "databaseBackup": database,
               "installedFiles": len(hashes), "httpFiles": sum(name.startswith(UI) for name in hashes),
               "indexSha256": hashes.get(UI + "index.html")}
    write("release.json", receipt)
    print(json.dumps(receipt, ensure_ascii=False))


def launch():
    if (STAGE / "job.json").exists():
        raise RuntimeError("A deployment worker already exists for this release")
    write("job.json", {"status": "running"})
    try:
        with (STAGE / "deployment.log").open("a") as log:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "worker"],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as error:
        write("job.json", {"status": "failed", "error": str(error)})
        raise


def worker():
    try:
        deploy()
    except Exception as error:
        write("job.json", {"status": "failed", "error": str(error)})
        raise
    write("job.json", {"status": "done", "receipt": read("release.json")})


if __name__ == "__main__":
    {"scan": scan, "prepare": prepare, "probe": probe, "launch": launch, "worker": worker}[sys.argv[1]]()
