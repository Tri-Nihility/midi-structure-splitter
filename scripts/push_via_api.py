#!/usr/bin/env python3
"""Push commits to GitHub via REST API (Git Data endpoints).

This works around the GnuTLS vs OpenSSL issue in sandboxed git.
Uses gh CLI for authentication.
"""

import subprocess
import json
import sys
import os

REPO = "Tri-Nihility/midi-structure-splitter"
REPO_DIR = "/workspace/midi-structure-splitter"

def gh_api(method, endpoint, data=None, input_data=None):
    """Call GitHub API via gh CLI."""
    cmd = ["gh", "api", "--method", method, f"repos/{REPO}/{endpoint}"]
    env = os.environ.copy()

    # For form-encoded data (POST only)
    if data and input_data is None:
        cmd.extend(["-f"] + [f"{k}={v}" for k, v in data.items()])
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_DIR, env=env)
    elif input_data is not None:
        # Use --input for JSON payload (works with all methods)
        cmd.append("--input")
        cmd.append("-")
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_DIR,
                                input=input_data, env=env)
    else:
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_DIR, env=env)

    if result.returncode != 0:
        print(f"API call failed: {method} {endpoint}")
        print(f"stderr: {result.stderr}")
        print(f"stdout: {result.stdout}")
        return None

    try:
        return json.loads(result.stdout) if result.stdout else None
    except json.JSONDecodeError:
        return result.stdout


def git_output(*args):
    """Run git command and return output."""
    return subprocess.check_output(["git"] + list(args), cwd=REPO_DIR, text=True).strip()


def push_commit(commit_sha):
    """Push a single commit (and its tree/blobs) to GitHub, then update the ref."""
    print(f"\n=== Pushing commit {commit_sha} ===")

    # Get commit info
    tree_sha = git_output("rev-parse", f"{commit_sha}^{{tree}}")
    parent_sha = git_output("rev-parse", f"{commit_sha}^") if git_output("rev-parse", f"{commit_sha}^@").count('\n') > 0 else None
    if not parent_sha:
        try:
            parent_sha = git_output("rev-parse", f"{commit_sha}~1")
        except:
            parent_sha = None

    # Get commit details
    commit_msg = git_output("log", "-1", "--format=%B", commit_sha)
    author_name = git_output("log", "-1", "--format=%an", commit_sha)
    author_email = git_output("log", "-1", "--format=%ae", commit_sha)
    author_date = git_output("log", "-1", "--format=%aI", commit_sha)
    committer_name = git_output("log", "-1", "--format=%cn", commit_sha)
    committer_email = git_output("log", "-1", "--format=%ce", commit_sha)
    committer_date = git_output("log", "-1", "--format=%cI", commit_sha)

    # Step 1: Upload all blobs in the tree
    print(f"  Tree: {tree_sha}")
    upload_tree_recursive(tree_sha, set())

    # Step 2: Create the tree on GitHub
    print(f"  Creating tree...")
    tree_data = create_github_tree(tree_sha)
    if not tree_data:
        print("  ERROR: Failed to create tree")
        return False

    # Step 3: Create the commit
    print(f"  Creating commit...")
    commit_data = {
        "message": commit_msg,
        "tree": tree_data["sha"],
        "parents": [parent_sha] if parent_sha else [],
        "author": {
            "name": author_name,
            "email": author_email,
            "date": author_date
        },
        "committer": {
            "name": committer_name,
            "email": committer_email,
            "date": committer_date
        }
    }

    payload = json.dumps(commit_data)
    result = gh_api("POST", "git/commits", input_data=payload)
    if not result or "sha" not in result:
        print(f"  ERROR: Failed to create commit: {result}")
        return False

    new_sha = result["sha"]
    print(f"  Commit created: {new_sha}")

    # Step 4: Update the ref
    print(f"  Updating ref...")
    ref_data = {
        "sha": new_sha,
        "force": False
    }
    ref_payload = json.dumps(ref_data)
    ref_result = gh_api("PATCH", "git/refs/heads/main", input_data=ref_payload)
    if not ref_result:
        print("  ERROR: Failed to update ref")
        return False

    print(f"  Ref updated to {new_sha}")
    return True


def upload_tree_recursive(tree_sha, uploaded_blobs):
    """Recursively upload all blobs in a tree to GitHub."""
    # List tree entries
    entries = git_output("ls-tree", tree_sha).split('\n')

    for entry in entries:
        if not entry.strip():
            continue
        parts = entry.split()
        mode = parts[0]
        obj_type = parts[1]
        obj_sha = parts[2]
        name = parts[3]

        if obj_type == "blob" and obj_sha not in uploaded_blobs:
            # Check if blob already exists on GitHub
            check = gh_api("GET", f"git/blobs/{obj_sha}")
            if not check or "message" in check:
                # Need to upload
                print(f"    Uploading blob {obj_sha} ({name})...")
                content = git_output("cat-file", "-p", obj_sha)
                blob_data = {
                    "content": content,
                    "encoding": "utf-8"
                }
                payload = json.dumps(blob_data)
                result = gh_api("POST", "git/blobs", input_data=payload)
                if result:
                    uploaded_blobs.add(obj_sha)
                else:
                    print(f"    WARNING: Failed to upload blob {obj_sha}")
            else:
                uploaded_blobs.add(obj_sha)

        elif obj_type == "tree":
            upload_tree_recursive(obj_sha, uploaded_blobs)


def create_github_tree(tree_sha):
    """Create a tree on GitHub from a local tree SHA."""
    entries = git_output("ls-tree", tree_sha).split('\n')
    tree_entries = []

    for entry in entries:
        if not entry.strip():
            continue
        parts = entry.split()
        mode = parts[0]
        obj_type = parts[1]
        obj_sha = parts[2]
        name = parts[3]

        tree_entries.append({
            "path": name,
            "mode": mode,
            "type": obj_type,
            "sha": obj_sha
        })

    payload = json.dumps({"tree": tree_entries})
    result = gh_api("POST", "git/trees", input_data=payload)
    return result


def main():
    # Commits in order (oldest first)
    commits = ["06b43a4", "1d297c3", "482d1b2", "a078eab"]

    for c in commits:
        full_sha = git_output("rev-parse", c)
        if not push_commit(full_sha):
            print(f"Failed at commit {c}, aborting")
            sys.exit(1)

    print("\n=== All commits pushed successfully! ===")


if __name__ == "__main__":
    main()
