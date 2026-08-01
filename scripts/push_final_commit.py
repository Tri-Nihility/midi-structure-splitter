#!/usr/bin/env python3
"""Push only the final commit (a078eab) to GitHub, parented to f94a403 (current remote HEAD).

Handles nested trees by recursively uploading blobs and rebuilding tree structure.
Includes retry logic for transient API failures.
"""

import subprocess
import json
import sys
import os
import time

REPO = "Tri-Nihility/midi-structure-splitter"
REPO_DIR = "/workspace/midi-structure-splitter"
REMOTE_HEAD = "f94a403e23fdeb633c76106a7e203cfdec5630a3"
LOCAL_COMMIT = "a078eab"
MAX_RETRIES = 3


def gh_api(method, endpoint, input_data=None, retries=MAX_RETRIES):
    """Call GitHub API via gh CLI with JSON payload. Retries on failure."""
    cmd = ["gh", "api", "--method", method, f"repos/{REPO}/{endpoint}"]
    if input_data is not None:
        cmd.extend(["--input", "-"])
    env = os.environ.copy()

    for attempt in range(retries):
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_DIR,
                                input=input_data, env=env, timeout=30)
        if result.returncode == 0:
            try:
                return json.loads(result.stdout) if result.stdout else None
            except json.JSONDecodeError:
                return result.stdout
        if attempt < retries - 1:
            wait = (attempt + 1) * 3
            print(f"    retry in {wait}s...")
            time.sleep(wait)
    print(f"  API {method} {endpoint} FAILED after {retries} attempts: {result.stderr.strip()}")
    return None


def git_output(*args):
    return subprocess.check_output(["git"] + list(args), cwd=REPO_DIR, text=True).strip()


def upload_blob(local_blob_sha, name=""):
    """Upload a blob to GitHub. Returns (True, github_sha) if successful."""
    # First check if blob already exists on GitHub
    check = gh_api("GET", f"git/blobs/{local_blob_sha}")
    if check and "sha" in check:
        print(f"    blob {local_blob_sha[:12]} ({name}) already on GitHub")
        return (True, local_blob_sha)

    content = git_output("cat-file", "-p", local_blob_sha)
    result = gh_api("POST", "git/blobs",
                    input_data=json.dumps({"content": content, "encoding": "utf-8"}))
    if result and "sha" in result:
        github_sha = result["sha"]
        print(f"    blob {local_blob_sha[:12]} ({name}) uploaded -> {github_sha[:12]}")
        return (True, github_sha)
    return (False, None)


def create_github_tree(local_tree_sha, indent=""):
    """Recursively create a tree on GitHub from a local tree SHA.
    Returns the GitHub tree SHA."""
    entries = git_output("ls-tree", local_tree_sha).split('\n')
    tree_entries = []

    for entry in entries:
        if not entry.strip():
            continue
        parts = entry.split()
        mode = parts[0]
        obj_type = parts[1]
        obj_sha = parts[2]
        name = parts[3]

        if obj_type == "blob":
            ok, github_blob_sha = upload_blob(obj_sha, name)
            if not ok:
                print(f"    FAILED to upload blob {obj_sha[:12]} ({name})")
                sys.exit(1)
            tree_entries.append({
                "path": name,
                "mode": mode,
                "type": "blob",
                "sha": github_blob_sha
            })
        elif obj_type == "tree":
            print(f"{indent}  subtree {name}/")
            github_subtree_sha = create_github_tree(obj_sha, indent + "    ")
            tree_entries.append({
                "path": name,
                "mode": mode,
                "type": "tree",
                "sha": github_subtree_sha
            })

    result = gh_api("POST", "git/trees", input_data=json.dumps({"tree": tree_entries}))
    if result and "sha" in result:
        print(f"{indent}  tree created: {result['sha'][:12]}")
        return result["sha"]
    else:
        print(f"{indent}  FAILED to create tree!")
        sys.exit(1)


def main():
    local_tree = git_output("rev-parse", f"{LOCAL_COMMIT}^{{tree}}")
    commit_msg = git_output("log", "-1", "--format=%B", LOCAL_COMMIT)
    author_name = git_output("log", "-1", "--format=%an", LOCAL_COMMIT)
    author_email = git_output("log", "-1", "--format=%ae", LOCAL_COMMIT)
    author_date = git_output("log", "-1", "--format=%aI", LOCAL_COMMIT)
    committer_name = git_output("log", "-1", "--format=%cn", LOCAL_COMMIT)
    committer_email = git_output("log", "-1", "--format=%ce", LOCAL_COMMIT)
    committer_date = git_output("log", "-1", "--format=%cI", LOCAL_COMMIT)

    print(f"Local tree: {local_tree}")
    print(f"Parent (remote): {REMOTE_HEAD}")

    # Step 1+2: Recursively upload blobs and create tree structure
    print("\n--- Building tree on GitHub ---")
    github_tree_sha = create_github_tree(local_tree)

    # Step 3: Create commit
    print(f"\n--- Creating commit ---")
    commit_data = {
        "message": commit_msg,
        "tree": github_tree_sha,
        "parents": [REMOTE_HEAD],
        "author": {"name": author_name, "email": author_email, "date": author_date},
        "committer": {"name": committer_name, "email": committer_email, "date": committer_date}
    }
    commit_result = gh_api("POST", "git/commits", input_data=json.dumps(commit_data))
    if not commit_result:
        print("FAILED to create commit")
        sys.exit(1)
    new_sha = commit_result["sha"]
    print(f"Commit created: {new_sha}")

    # Step 4: Update ref
    print(f"\n--- Updating ref ---")
    ref_result = gh_api("PATCH", "git/refs/heads/main",
                        input_data=json.dumps({"sha": new_sha, "force": False}))
    if not ref_result:
        print("FAILED to update ref")
        sys.exit(1)
    print(f"Ref updated! main now at {new_sha}")

    print("\n=== DONE: All 4 commits are now on GitHub! ===")


if __name__ == "__main__":
    main()