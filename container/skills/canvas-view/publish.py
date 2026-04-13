#!/usr/bin/env python3
"""
Publish any markdown document to Canvas for interactive review.

Canvas renders markdown as HTML in the browser with inline commenting on every
section. Use it for plans, reports, task lists, research notes, proposals —
anything long enough that structured feedback is preferable to chat replies.

Usage:
  python3 ~/.claude/skills/canvas-view/publish.py \
    --file /workspace/group/docs/my-doc.md \
    --title "My Document"

  # Or pipe markdown directly:
  echo "# Report\n..." | python3 ~/.claude/skills/canvas-view/publish.py --title "Report"

Prints the canvas URL to stdout.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(
        description="Publish a markdown document to Canvas for interactive review"
    )
    parser.add_argument("--file", "-f", help="Path to markdown file")
    parser.add_argument("--title", "-t", default="Document", help="Canvas title")
    parser.add_argument("--canvas-id", help="Custom canvas ID (auto-generated if not set)")
    args = parser.parse_args()

    # Read markdown from file or stdin
    if args.file:
        with open(args.file) as f:
            markdown = f.read()
    elif not sys.stdin.isatty():
        markdown = sys.stdin.read()
    else:
        print("Error: provide --file or pipe markdown to stdin", file=sys.stderr)
        sys.exit(1)

    if not markdown.strip():
        print("Error: empty document", file=sys.stderr)
        sys.exit(1)

    # Read the viewer JSX component
    skill_dir = os.path.dirname(os.path.abspath(__file__))
    jsx_path = os.path.join(skill_dir, "viewer.jsx")
    with open(jsx_path) as f:
        jsx = f.read()

    # Generate canvas ID from file path or content hash
    if args.canvas_id:
        canvas_id = args.canvas_id
    elif args.file:
        # Use filename for stable IDs (re-publishing updates the same canvas)
        base = os.path.basename(args.file).replace(".md", "")
        canvas_id = f"doc-{base}"
    else:
        h = hashlib.md5(markdown[:200].encode()).hexdigest()[:8]
        canvas_id = f"doc-{int(time.time())}-{h}"

    group = os.environ.get("NANOCLAW_GROUP_FOLDER", "unknown")
    redis_url = os.environ.get("REDIS_URL", "redis://host.docker.internal:6379")

    msg = json.dumps({
        "canvas_id": canvas_id,
        "action": "create",
        "group": group,
        "title": args.title,
        "jsx": jsx,
        "state": {
            "markdown": markdown,
            "status": "reviewing",
        },
    })

    # Publish via Python redis (install if needed)
    try:
        import redis as redis_lib
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "redis", "-q"], check=True)
        import redis as redis_lib

    try:
        r = redis_lib.from_url(redis_url, socket_connect_timeout=5)
        r.publish("nanoclaw:canvas", msg)
    except Exception as e:
        print(f"Error publishing to Redis: {e}", file=sys.stderr)
        # Fallback: write IPC file
        ipc_dir = "/workspace/ipc/canvas"
        os.makedirs(ipc_dir, exist_ok=True)
        ipc_path = os.path.join(ipc_dir, f"{canvas_id}.json")
        with open(ipc_path, "w") as f:
            f.write(msg)
        print(f"Redis unavailable, wrote IPC file: {ipc_path}", file=sys.stderr)

    canvas_base = os.environ.get(
        "CANVAS_URL_BASE", "https://ark.nikitin.me/canvas"
    ).rstrip("/")
    url = f"{canvas_base}/{group}/{canvas_id}"
    print(url)


if __name__ == "__main__":
    main()
