#!/usr/bin/env python3
"""
Publish a markdown plan to Canvas for interactive review.

Usage:
  python3 /workspace/global/skills/canvas-plan/publish-plan.py \
    --file /workspace/group/plans/my-plan.md \
    --title "Plan: My Feature"

  # Or pipe markdown directly:
  echo "# My Plan\n..." | python3 /workspace/global/skills/canvas-plan/publish-plan.py --title "Plan"

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
    parser = argparse.ArgumentParser(description="Publish a plan to Canvas")
    parser.add_argument("--file", "-f", help="Path to markdown file")
    parser.add_argument("--title", "-t", default="Plan Review", help="Canvas title")
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
        print("Error: empty plan", file=sys.stderr)
        sys.exit(1)

    # Read the plan-review JSX component
    skill_dir = os.path.dirname(os.path.abspath(__file__))
    jsx_path = os.path.join(skill_dir, "plan-review.jsx")
    with open(jsx_path) as f:
        jsx = f.read()

    # Generate canvas ID from file path or content hash
    if args.canvas_id:
        canvas_id = args.canvas_id
    elif args.file:
        # Use filename for stable IDs (re-publishing updates the same canvas)
        base = os.path.basename(args.file).replace(".md", "")
        canvas_id = f"plan-{base}"
    else:
        h = hashlib.md5(markdown[:200].encode()).hexdigest()[:8]
        canvas_id = f"plan-{int(time.time())}-{h}"

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

    url = f"https://ark.nikitin.me/canvas/{group}/{canvas_id}"
    print(url)


if __name__ == "__main__":
    main()
