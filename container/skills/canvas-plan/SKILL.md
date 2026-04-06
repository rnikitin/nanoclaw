---
name: canvas-plan
description: Present a plan for interactive review via Canvas. Renders markdown as HTML with inline commenting. Use this whenever you create or update a plan that needs user approval. ALWAYS use Canvas for plans — never dump plan text in chat.
allowed-tools: Bash(python3:*), Bash(cat:*), Bash(echo:*)
---

# Canvas Plan Review

All plans MUST be presented through Canvas for interactive review.

## Quick Usage

```bash
# Write plan to file, then publish
python3 /workspace/global/skills/canvas-plan/publish-plan.py \
  --file /workspace/group/plans/my-plan.md \
  --title "Plan: My Feature"
```

The script prints the canvas URL. Send it to the user.

## What Happens

1. Plan renders as formatted HTML in the browser
2. User can add inline comments on any section (like GitHub PR reviews)
3. User clicks "Approve" or "Submit comments"
4. You receive a `<canvas-event>`:
   - `type: "approve"` — proceed with the plan
   - `type: "submit"` with `feedback` array — revise the plan based on comments

## Re-publishing

Using the same filename creates the same canvas ID. Re-publishing updates the existing canvas — useful after revising based on feedback.

## Piping markdown

```bash
echo "# Quick Plan\n\n## Approach\nDo the thing" | \
  python3 /workspace/global/skills/canvas-plan/publish-plan.py --title "Quick Plan"
```
