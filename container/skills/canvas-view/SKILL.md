---
name: canvas-view
description: Open any markdown document (plan, report, task list, proposal, research note, summary) in Canvas for structured interactive review. Renders as HTML with inline commenting on every section. Use whenever you produce a long document, want feedback from the user, or need explicit approval before acting. Never dump long markdown straight into chat.
allowed-tools: Bash(python3:*), Bash(cat:*), Bash(echo:*)
---

# Canvas View

Canvas is an interactive document viewer. Publish any markdown here — the user reads the rendered HTML in a browser, drops inline comments on the sections that matter, and replies with approve or feedback.

## When to use

- Plans or proposals that need approval before execution
- Research notes, analyses, or post-mortems the user will read carefully
- Task lists and todos where per-item feedback is useful
- Reports and summaries — anything longer than a comfortable chat message

If the output is short and non-actionable, just reply in chat. Canvas is for documents the user will want to scroll, annotate, and react to.

## Quick usage

```bash
# Write to a file, then publish
python3 ~/.claude/skills/canvas-view/publish.py \
  --file /workspace/group/docs/my-doc.md \
  --title "My Document"
```

```bash
# Or pipe markdown directly
echo "# Report\n\n## Findings\n..." | \
  python3 ~/.claude/skills/canvas-view/publish.py --title "Weekly Report"
```

The script prints the canvas URL. Send it to the user.

## What the user sees

1. Rendered markdown in the browser (sections, tables, code, checklists)
2. A `+` button on every heading — click to add an inline comment
3. Bottom bar: **Approve** (or **Approve as is** + **Submit N comments**)

## What you receive back

A `<canvas-event>` arrives in your next turn:

- `type: "approve"` — proceed
- `type: "submit"` with a `feedback` array — each entry has the section title and the user's comments; revise the document and re-publish

## Re-publishing

Using the same `--file` produces the same canvas ID, so re-publishing updates the existing view instead of creating a new one. This is the normal flow after processing feedback — edit the markdown, run the script again, send the same URL.
