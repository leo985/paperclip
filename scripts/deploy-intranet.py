#!/usr/bin/env python3
"""Publish an explicitly scoped Paperclip increment to the internal instance."""
import argparse
import datetime
import hashlib
import json
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import paramiko

REPO = Path(__file__).resolve().parent.parent
HELPERS = REPO / "scripts/intranet-release"
DEFAULT_MANIFEST = HELPERS / "delivery-lookup-detail.json"
HOST, PORT, USER = "10.60.43.53", 5033, "fg"
HOME = "/home/fg/paperclip"
TARGET_URL = f"http://{HOST}:3100"


def read_manifest(path):
    manifest = json.loads(path.read_text())
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,54}", manifest["name"]):
        raise ValueError("Invalid release name")
    backend, ui = manifest.get("backend", []), manifest.get("ui", [])
    if not backend and not ui:
        raise ValueError("Select at least one backend module or UI asset")
    targets = [item["target"] for item in backend]
    if len(set(targets)) != len(targets):
        raise ValueError("A backend target can appear only once")
    for asset in ui:
        if not asset.get("markers") or not all(asset["markers"]):
            raise ValueError("Every UI asset requires a stable marker")
        if not asset.get("components") and not asset.get("replacements"):
            raise ValueError("Every UI asset must specify an edit")
    for item in [*backend, *(component for asset in ui for component in asset.get("components", []))]:
        candidate = (REPO / item["source"]).resolve()
        if not candidate.is_relative_to(REPO) or not candidate.is_file() or candidate.suffix not in {".ts", ".tsx"}:
            raise ValueError("Invalid repository source: " + item["source"])
    return manifest["name"], backend, ui


def connect(config_path):
    data = json.loads(config_path.read_text())
    entries = [entry for entry in data["servers"]
               if (entry.get("host"), entry.get("port"), entry.get("username")) == (HOST, PORT, USER)]
    if len(entries) != 1:
        raise ValueError(f"Expected one configured deployment account for {USER}@{HOST}:{PORT}")
    entry = entries[0]
    if entry["auth_method"] == "password":
        # The existing internal deploy account uses a plain password field in its local SSH config.
        authentication = {"password": entry["password"]}
    elif entry["auth_method"] == "key":
        authentication = {"key_filename": str(Path(entry["ssh_key_path"]).expanduser())}
    else:
        raise ValueError("Unsupported SSH configuration for the deployment account")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.connect(HOST, port=PORT, username=USER, timeout=10, auth_timeout=10,
                   allow_agent=False, look_for_keys=False, **authentication)
    return client


def run_remote(client, command, timeout=120):
    channel = client.get_transport().open_session(timeout=10)
    try:
        channel.settimeout(timeout)
        channel.set_combine_stderr(True)
        channel.exec_command(shlex.join(command))
        output = channel.makefile("rb").read().decode()
        status = channel.recv_exit_status()
        if status:
            raise RuntimeError(output.strip() or f"Remote command failed with status {status}")
        return output.strip()
    finally:
        channel.close()


def write_remote(sftp, path, value):
    with sftp.open(path, "w") as file:
        file.write(json.dumps(value, ensure_ascii=False))


def compile_target(sftp, stage, remote, item, kind, position):
    with tempfile.TemporaryDirectory(prefix="paperclip-intranet-release-") as temporary:
        directory = Path(temporary)
        baseline = "-"
        if remote:
            baseline = str(directory / "live.js")
            sftp.get(f"{HOME}/runtime/node_modules/{remote}", baseline)
        elif item.get("route"):
            raise ValueError("A route patch needs an existing online module: " + item["target"])
        patched = directory / "candidate.js"
        subprocess.run(["node", str(HELPERS / "patch.cjs"), kind, json.dumps(item), baseline, str(patched)],
                       cwd=REPO, check=True)
        sftp.put(str(patched), f"{stage}/inputs/{kind}-{position}.js")


def check_external_health(receipt):
    with urllib.request.urlopen(TARGET_URL + "/api/health", timeout=10) as response:
        if json.load(response).get("status") != "ok":
            raise RuntimeError("External health check failed")
    digest = receipt.get("indexSha256")
    if digest:
        with urllib.request.urlopen(TARGET_URL + "/", timeout=10) as response:
            if hashlib.sha256(response.read()).hexdigest() != digest:
                raise RuntimeError("External homepage does not match the release receipt")


def wait_for_release(client, stage):
    run_remote(client, ["python3", stage + "/remote.py", "launch"])
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        job = json.loads(run_remote(client, ["cat", stage + "/job.json"], timeout=10))
        if job["status"] == "done":
            return job["receipt"]
        if job["status"] == "failed":
            raise RuntimeError(job["error"] + f" 详见 {stage}/deployment.log")
        time.sleep(3)
    raise RuntimeError(f"发布仍在远程运行，查看 {stage}/job.json 和 deployment.log。")



def publish(args):
    name, backend, ui = read_manifest(args.manifest)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    stage = f"{HOME}/private/{name}-{stamp}"
    with connect(args.ssh_config) as client:
        print(f"生产目标 {TARGET_URL}，发布目录 {stage}", flush=True)
        run_remote(client, ["mkdir", "-m", "700", stage, stage + "/inputs"])
        with client.open_sftp() as sftp:
            for helper in ("remote.py", "backup.cjs"):
                sftp.put(str(HELPERS / helper), stage + "/" + helper)
            write_remote(sftp, stage + "/request.json",
                         {"backend": [item["target"] for item in backend], "ui": [item["markers"] for item in ui]})
            baseline = json.loads(run_remote(client, ["python3", stage + "/remote.py", "scan"]))
            for position, item in enumerate(backend):
                target = item["target"] if baseline["backend"][item["target"]] is not None else None
                compile_target(sftp, stage, target, item, "backend", position)
            for position, item in enumerate(ui):
                target = "@paperclipai/server/ui-dist/assets/" + baseline["ui"][position]["asset"]
                compile_target(sftp, stage, target, item, "ui", position)
        print(run_remote(client, ["python3", stage + "/remote.py", "prepare"]), flush=True)
        run_remote(client, ["python3", stage + "/remote.py", "probe"])
        print("运行环境预检通过。", flush=True)
        if args.check:
            print("预检模式完成，发布包保存在远端私有目录。", flush=True)
            return
        receipt = wait_for_release(client, stage)
        print(json.dumps(receipt, ensure_ascii=False), flush=True)
        try:
            check_external_health(receipt)
        except (OSError, RuntimeError, ValueError) as error:
            raise RuntimeError(f"远端已生成发布回执，客户端入口复查失败：{error}。回执位于 {stage}/release.json") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", nargs="?", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--check", action="store_true", help="prepare and probe without installing files or restarting")
    parser.add_argument("--ssh-config", type=Path, default=Path.home() / ".ssh/server_config.json",
                        help="existing SSH configuration for the internal deployment account")
    try:
        publish(parser.parse_args())
    except (OSError, ValueError, RuntimeError, paramiko.SSHException, subprocess.SubprocessError) as error:
        print(f"发布停止。{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
