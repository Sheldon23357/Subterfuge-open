#!/usr/bin/env python3
"""Admin commands for a systemd-managed Linux lobby. Never prints credentials."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

SERVICE = "subterfuge-lobby"
ROOMS = Path("/var/lib/subterfuge/rooms")
BACKUPS = Path("/var/backups/subterfuge")


def checked_room(root, code):
    if not re.fullmatch(r"[A-Z0-9]{6}", code):
        raise ValueError("Room code must contain six uppercase letters/digits")
    if root.is_symlink():
        raise ValueError("Room root must not be a symlink")
    path = root / code
    if path.is_symlink() or not path.is_dir() or path.resolve().parent != root.resolve():
        raise ValueError("Room is missing or is outside the configured room directory")
    metadata = path / "room.json"
    if metadata.is_symlink() or json.loads(metadata.read_text())["code"] != code:
        raise ValueError("Room metadata does not match the requested code")
    return path


def archive_room(root, backups, code):
    source = checked_room(root, code)
    destination_root = backups / "removed-rooms"
    if backups.is_symlink() or destination_root.is_symlink():
        raise ValueError("Backup directory must not be a symlink")
    destination_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = destination_root / (stamp + "-" + code)
    if destination.exists():
        raise ValueError("Backup destination already exists")
    # Same-disk rename preserves the complete database, WAL, metadata and permissions.
    source.rename(destination)
    return destination


def systemctl(*args, **kwargs):
    return subprocess.run(["systemctl", *args], **kwargs)


def listing():
    with urllib.request.urlopen("http://127.0.0.1:4312/api/rooms", timeout=10) as response:
        return json.load(response)["rooms"]


def wait_ready():
    for _ in range(40):
        try:
            listing()
            return
        except (OSError, ValueError):
            time.sleep(0.25)
    raise RuntimeError("Lobby did not become ready; inspect subterfuge logs")


def main():
    parser = argparse.ArgumentParser(description="Manage the hosted game lobby")
    actions = parser.add_subparsers(dest="action", required=True)
    for name in ("status", "rooms", "backup", "backups", "logs", "restart"):
        actions.add_parser(name)
    remove = actions.add_parser("remove-room", help="Remove one room from the lobby, preserving a recoverable archive")
    remove.add_argument("code")
    remove.add_argument("--yes", action="store_true", required=True, help="Confirm removal and brief lobby restart")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run through sudo, or use the installed subterfuge wrapper")
    if args.action == "status":
        return systemctl("status", SERVICE, "--no-pager", "-l").returncode
    if args.action == "rooms":
        print(json.dumps(listing(), ensure_ascii=False, indent=2))
    elif args.action == "logs":
        return subprocess.run(["journalctl", "-u", SERVICE, "-n", "60", "--no-pager"]).returncode
    elif args.action == "restart":
        systemctl("restart", SERVICE, check=True)
        wait_ready()
        print("Lobby restarted and ready")
    elif args.action == "backup":
        subprocess.run(["/usr/local/sbin/subterfuge-backup"], check=True)
        wait_ready()
    elif args.action == "backups":
        for item in sorted(BACKUPS.rglob("*")):
            if item.name.endswith(".tar.gz") or item.parent.name == "removed-rooms":
                print(item)
    elif args.action == "remove-room":
        checked_room(ROOMS, args.code)
        # Serialize against the existing full-backup service.
        import fcntl
        with open("/run/lock/subterfuge-backup.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            was_active = systemctl("is-active", "--quiet", SERVICE).returncode == 0
            systemctl("stop", SERVICE, check=True)
            try:
                archive = archive_room(ROOMS, BACKUPS, args.code)
            finally:
                if was_active:
                    systemctl("start", SERVICE, check=True)
            if was_active:
                wait_ready()
            print(f"Removed {args.code}; recoverable archive: {archive}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
