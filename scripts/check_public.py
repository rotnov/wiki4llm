"""Check the proposed tracked payload; findings require review, never suppression."""

import argparse
import re
import subprocess
from pathlib import Path

SECRET = re.compile(
    rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}"
    rb"|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}"
    rb"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
)


def git(root, *args):
    return subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            str(root),
            *args,
        ],
        check=True,
        capture_output=True,
        timeout=30,
    ).stdout


def check_index(root, forbidden):
    """Scan immutable blobs/modes from one tree written from the proposed index."""
    tree = git(root, "write-tree").decode().strip()
    entries = git(root, "ls-tree", "-r", "-z", "--full-tree", tree).split(b"\0")
    findings = []
    count = 0
    for entry in entries:
        if not entry:
            continue
        count += 1
        metadata, encoded = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        name = encoded.decode("utf-8")
        path = Path(name)
        if (
            mode not in {"100644", "100755"}
            or kind != "blob"
            or ".wiki-rag" in path.parts
            or path.name.startswith(".env")
            or path.suffix in {".pem", ".key", ".p12", ".pfx"}
        ):
            findings.append(f"{name}: prohibited file or mode")
            continue
        data = git(root, "cat-file", "blob", oid)
        if SECRET.search(data):
            findings.append(f"{name}: possible credential")
        if any(marker.lower().encode() in data.lower() for marker in forbidden):
            findings.append(f"{name}: private marker")
    return {"tree": tree, "file_count": count, "findings": findings}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--forbid", action="append", default=[], help="private word or path to reject"
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        result = check_index(root, args.forbid)
    except OSError, ValueError, subprocess.SubprocessError:
        print("Unable to inspect a complete staged Git tree; resolve index/read errors first")
        return 1
    if not result["file_count"]:
        print("No staged payload: stage the proposed release before checking")
        return 1
    for finding in result["findings"]:
        print(finding)
    print(
        f"Checked staged tree {result['tree']}: {result['file_count']} files; "
        f"{len(result['findings'])} findings"
    )
    return 1 if result["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
