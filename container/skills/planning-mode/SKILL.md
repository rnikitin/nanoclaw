---
name: planning-mode
description: Use before starting anything non-trivial — creating new features, skills, systems, refactors, or significant changes. Writes a plan as markdown and publishes via Canvas for user approval. Does NOT apply to simple questions, quick edits, lookups, or conversations. When in doubt, plan first.
allowed-tools: Bash(python3:*), Bash(mkdir:*), Bash(cat:*), Write, Edit
---

# Planning Mode

Before implementing something non-trivial, produce a plan and get approval. Skip for trivial tasks.

## Trigger

Use when the user asks to:
- Create something new (feature, skill, system, integration)
- Make a significant change (refactor, redesign, migration)
- Build anything with multiple moving parts or unclear trade-offs

Skip for:
- Quick edits to a known file
- Factual questions or lookups
- Small fixes with an obvious approach
- Casual conversation

## Flow

1. Write the plan as a markdown file in `/workspace/group/plans/<slug>.md`
2. Publish via Canvas:
   ```bash
   python3 ~/.claude/skills/canvas-view/publish.py \
     --file /workspace/group/plans/<slug>.md \
     --title "Plan: <short title>"
   ```
3. Send the URL to the user in chat and wait
4. A `<canvas-event>` arrives with `type: "approve"` or `type: "submit"` (with comments)
5. Approve → execute. Submit → revise the plan, republish with `--canvas-id <same-id>` to update the same doc.

## Plan structure

Keep it tight. Skip anything that doesn't move the decision.

```
# Title

## Context
What we're solving and why.

## Approach
The concrete plan — steps, files touched, decisions made.

## Risks / Open questions
- Things that could break
- Things the user should call before execution
```

Do NOT enter Claude's built-in plan mode — it blocks file editing. Always use this Canvas-based flow instead.
