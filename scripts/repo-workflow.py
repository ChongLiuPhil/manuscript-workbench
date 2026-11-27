#!/usr/bin/env python3
"""
Generic Local-Repo-First Git Workflow CLI for Manuscript Workbench.

Operates strictly on a single local clone directory
(default: <os.tmpdir>/manuscript-workbench-repo, overrideable via WORKBENCH_REPO_DIR)
and reads optional GITHUB_REPO and GITHUB_TOKEN strictly from runtime environment
variables without ever persisting tokens into .git/config or repository files.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

DEFAULT_REPO_DIR = Path(
    (os.environ.get("WORKBENCH_REPO_DIR") or "").strip()
    or os.path.join(tempfile.gettempdir(), "manuscript-workbench-repo")
)
DEFAULT_BASE_BRANCH = "main"
REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def get_github_token() -> str:
    return (os.environ.get("GITHUB_TOKEN") or "").strip()


def validate_repo_slug(repo_slug: str) -> str:
    slug = (repo_slug or "").strip()
    if not REPO_SLUG_RE.match(slug):
        raise ValueError(f"Invalid repository slug '{slug}'. Expected format: owner/repo")
    return slug


def git_auth_args() -> list[str]:
    token = get_github_token()
    if not token:
        return []
    encoded = base64.b64encode(f"git:{token}".encode("utf-8")).decode("ascii")
    return ["-c", f"http.extraHeader=AUTHORIZATION: Basic {encoded}"]


def git(repo_dir: Path, *args: str, auth: bool = False) -> str:
    cmd = ["git", "-c", "core.quotePath=false"]
    if auth:
        cmd.extend(git_auth_args())
    cmd.extend(args)
    return subprocess.check_output(
        cmd,
        cwd=repo_dir,
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()


def ensure_clone(repo_dir: Path, repo_slug: str, base_branch: str = DEFAULT_BASE_BRANCH) -> dict:
    slug = validate_repo_slug(repo_slug)
    clean_url = f"https://github.com/{slug}.git"

    if (repo_dir / ".git").exists():
        current_url = ""
        try:
            current_url = git(repo_dir, "remote", "get-url", "origin")
        except Exception:
            current_url = ""
        if slug.lower() not in current_url.lower():
            shutil.rmtree(repo_dir)

    if not (repo_dir / ".git").exists():
        repo_dir.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["git", *git_auth_args(), "clone", clean_url, str(repo_dir)]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    else:
        git(repo_dir, "remote", "set-url", "origin", clean_url)
        git(repo_dir, "fetch", "origin", "--prune", auth=True)

    return get_status(repo_dir, base_branch=base_branch, auto_sync=False)


def sync_main(
    repo_dir: Path,
    repo_slug: str = "",
    base_branch: str = DEFAULT_BASE_BRANCH,
    force: bool = False,
) -> dict:
    if not (repo_dir / ".git").exists():
        if not repo_slug:
            return {"cloned": False, "repoDir": str(repo_dir)}
        return ensure_clone(repo_dir, repo_slug, base_branch)

    git(repo_dir, "fetch", "origin", "--prune", auth=True)
    dirty_files = [
        line for line in git(repo_dir, "status", "--short").splitlines() if line.strip()
    ]
    if dirty_files and not force:
        return get_status(repo_dir, base_branch=base_branch, auto_sync=False)

    try:
        git(repo_dir, "checkout", "-B", base_branch, f"origin/{base_branch}")
    except Exception:
        pass
    return get_status(repo_dir, base_branch=base_branch, auto_sync=False)


def get_status(
    repo_dir: Path,
    base_branch: str = DEFAULT_BASE_BRANCH,
    auto_sync: bool = False,
) -> dict:
    if not (repo_dir / ".git").exists():
        return {"cloned": False, "repoDir": str(repo_dir), "defaultBase": base_branch}

    dirty_files = [
        line for line in git(repo_dir, "status", "--short").splitlines() if line.strip()
    ]
    if auto_sync and not dirty_files:
        try:
            git(repo_dir, "fetch", "origin", "--prune", auth=True)
        except Exception:
            pass

    cur_branch = git(repo_dir, "rev-parse", "--abbrev-ref", "HEAD")
    local_head = git(repo_dir, "rev-parse", "HEAD")
    local_short = git(repo_dir, "rev-parse", "--short", "HEAD")

    try:
        remote_head = git(repo_dir, "rev-parse", f"origin/{cur_branch}")
        remote_short = git(repo_dir, "rev-parse", "--short", f"origin/{cur_branch}")
    except Exception:
        try:
            remote_head = git(repo_dir, "rev-parse", f"origin/{base_branch}")
            remote_short = git(repo_dir, "rev-parse", "--short", f"origin/{base_branch}")
        except Exception:
            remote_head = local_head
            remote_short = local_short

    try:
        ahead_count = int(git(repo_dir, "rev-list", "--count", f"{remote_head}..HEAD"))
    except Exception:
        ahead_count = 0

    modified_paths = [
        line for line in git(repo_dir, "diff", "--name-only").splitlines() if line.strip()
    ]
    recent_commits = [
        line for line in git(repo_dir, "log", "-n", "6", "--oneline").splitlines() if line.strip()
    ]

    remote_url = ""
    repo_slug = ""
    try:
        remote_url = git(repo_dir, "remote", "get-url", "origin")
        m = re.search(r"github\.com[:/]([^/]+/[^/.]+?)(?:\.git)?$", remote_url)
        if m:
            repo_slug = m.group(1)
    except Exception:
        pass

    return {
        "cloned": True,
        "repoSlug": repo_slug,
        "repoDir": str(repo_dir),
        "defaultBase": base_branch,
        "branch": cur_branch,
        "localHead": local_head,
        "localShort": local_short,
        "remoteHead": remote_head,
        "remoteShort": remote_short,
        "aheadOfRemote": ahead_count,
        "inSyncWithRemote": local_head == remote_head and len(dirty_files) == 0,
        "hasLocalDraftEdits": len(dirty_files) > 0,
        "dirtyCount": len(dirty_files),
        "dirtyFiles": dirty_files,
        "modifiedPaths": modified_paths,
        "recentCommits": recent_commits,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_clone = sub.add_parser("ensure-clone")
    p_clone.add_argument("--repo-dir", type=Path, default=DEFAULT_REPO_DIR)
    p_clone.add_argument("--repo-slug", default=os.environ.get("GITHUB_REPO", ""))
    p_clone.add_argument("--base", default=DEFAULT_BASE_BRANCH)

    p_status = sub.add_parser("status")
    p_status.add_argument("--repo-dir", type=Path, default=DEFAULT_REPO_DIR)
    p_status.add_argument("--base", default=DEFAULT_BASE_BRANCH)

    p_sync = sub.add_parser("sync-main")
    p_sync.add_argument("--repo-dir", type=Path, default=DEFAULT_REPO_DIR)
    p_sync.add_argument("--repo-slug", default=os.environ.get("GITHUB_REPO", ""))
    p_sync.add_argument("--base", default=DEFAULT_BASE_BRANCH)
    p_sync.add_argument("--force", action="store_true")

    args = parser.parse_args()
    if args.command == "ensure-clone":
        out = ensure_clone(args.repo_dir, args.repo_slug, args.base)
    elif args.command == "status":
        out = get_status(args.repo_dir, args.base)
    elif args.command == "sync-main":
        out = sync_main(args.repo_dir, args.repo_slug, args.base, args.force)
    else:
        raise ValueError(f"Unsupported command: {args.command}")
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
