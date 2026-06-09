---
name: youtube-summarize
description: Summarize, transcribe, or answer questions about a YouTube video by passing its public URL to Gemini via OpenRouter. Use whenever the user shares a YouTube link and asks what it's about, or wants key points / timestamps / a translation of the content.
allowed-tools: Bash(youtube-summarize:*)
---

# YouTube Summarize

Sends a YouTube URL to Google Gemini through OpenRouter's chat-completions endpoint using the `video_url` content part. Gemini ingests the video directly (image frames + audio) — no download, no cookies, no `yt-dlp`. Reads `$OPENROUTER_API_KEY` from container env.

## Quick start

```bash
youtube-summarize "https://www.youtube.com/watch?v=ID"
youtube-summarize "https://youtu.be/ID" -l ru
youtube-summarize "URL" -p "What are the top 3 trading rules the speaker mentions? Include timestamps."
youtube-summarize "URL" -m google/gemini-3.1-flash      # quality upgrade
youtube-summarize "URL" --resolution standard           # better visual fidelity, ~3x cost
youtube-summarize "URL" --json
```

## Inputs

- A single public YouTube URL. Unlisted or private videos are **not** supported by the Gemini AI-Studio path — they return an error.
- `youtu.be/<id>` short links and `youtube.com/watch?v=<id>` long links both work; the script does not rewrite them.

## Output

Default: just the summary on stdout. `--json` returns the full OpenRouter response (`usage`, `model`, `choices`).

## Options

- `-m / --model` — OpenRouter model id. Default `google/gemini-3.1-flash-lite` (cheapest 3.x Flash, stable). Other good choices: `google/gemini-3.1-flash`, `google/gemini-2.5-flash`.
- `-p / --prompt` — override the default prompt entirely. Useful when you want a specific format the default doesn't cover (Q&A on a single point, translation only, fact extraction into a CSV, etc.).
- `-l / --lang` — language for the default prompt (e.g. `ru`). Without it, the model writes the summary in the speaker's language.
- `--resolution low|standard` — Gemini `mediaResolution`. Default `low` (~100 tok/sec). `standard` is ~3x tokens, sharper for text-heavy slides.
- `--fps N` — sampling rate in frames per second (default 1). Lower (0.3-0.5) for podcast/stream-style videos where slides barely change — halves visual cost. **Rule of thumb: any video longer than 1 hour → always pass `--fps 0.5` (or lower) to keep input tokens under the 1M context limit.**
- `--start OFFSET` / `--end OFFSET` — clip the video before Gemini sees it. Accepts `90s`, `12m`, `1h30m`, `5:30`, or `1:05:30`. Use to trim intros/outros on long streams.
- `--no-fallback` — on Gemini 400 errors (content policy), exit instead of trying the transcript pipeline. Default is to fall back automatically.
- `--json` — full response dump.

## Default prompt

The built-in prompt asks the model for a **detailed, structured, video-type-adaptive summary** — not a generic three-bullet TL;DR. It tells the model to:

- Pick the sections that fit the video type (lecture / interview / news / tutorial / stream / something custom) and produce 15-25 bullets total.
- Always extract a "Key numbers / facts" section when the video contains prices, rates, dates, stats, or named entities.
- Quote 1-3 high-signal lines verbatim, each with a timestamp.
- Sprinkle timestamps generously (`MM:SS`, or `HH:MM:SS` past one hour) — at least one per section.
- Skip intros, sponsor reads, sign-offs, small talk.
- Flag caveats and contradictions explicitly.

Override with `-p` when the task is something other than a thorough summary. Example for narrow extraction:

```bash
youtube-summarize URL -p "List every stock ticker the speaker mentions, with a one-line context and timestamp."
```

## Transcript fallback

When Gemini returns 400 INVALID_ARGUMENT — usually a content-policy block on videos that mention sensitive topics (politics, alcohol, controlled substances) or age-restricted content — `youtube-summarize` automatically:

1. Calls `youtube-data transcript <url> --lang <lang>` to pull captions/auto-subs (no Data API quota).
2. Feeds the transcript text to the same OpenRouter model.
3. Prints the resulting summary.

The transcript path itself has two tiers: first `youtube-transcript-api` (no auth, no cookies — but blocked from datacenter IPs like Hetzner), then `yt-dlp --write-auto-subs --cookies /workspace/global/.yt-cookies.txt`. If both tiers fail, the user needs to drop a fresh cookies export at that path. The cli prints an explicit "send fresh cookies" message when it gets there.

Disable with `--no-fallback` for diagnostic runs.

## Cost (rough)

At `gemini-3.1-flash-lite` ($0.25/M in, $1.50/M out) with `--resolution low`:

- 10-min video ≈ 60 000 input tokens ≈ $0.015 input + a few thousand output tokens (≈ $0.005). **~$0.02 per summary.**
- `--resolution standard`: ~3x input tokens.
- `gemini-3.1-flash`: ~2x cost vs lite, sharper reasoning.

## Length rules

| Video length | Recommended flags |
|---|---|
| < 1 hour | defaults are fine |
| 1–2 hours | `--fps 0.5` |
| 2–4 hours | `--fps 0.3` (or `--fps 0.5` + `--start` to trim intro) |
| > 4 hours | `--fps 0.2` + `--start/--end` for the segment you actually care about |

Why: Gemini 3.1 Flash-Lite has a 1M-token context window. At default `--fps 1` + `--resolution low` (~100 tok/sec), 2h 47m hits 1M and Gemini will refuse. Lowering fps cuts the visual stream proportionally; audio still gets transcribed at full rate, so the summary quality stays high for talk-heavy content.

## Errors

- `OPENROUTER_API_KEY is not set` → host hasn't injected the key.
- `OpenRouter HTTP 4xx` with `not a public YouTube URL` / `video unavailable` → unlisted/private/region-locked. Fall back to `yt-dlp-download` + `audio-transcribe`.
- `OpenRouter HTTP 5xx` → transient; retry.

## Common patterns

### Russian summary with timestamps

```bash
youtube-summarize "https://youtu.be/ID" -l ru
```

### Pipe from search

```bash
url=$(youtube-data search "qwen3 release" -n 1 --json \
  | jq -r '.items[0] | "https://www.youtube.com/watch?v=" + .id.videoId')
youtube-summarize "$url" -l ru
```

### Long live-stream archive (cheap)

```bash
youtube-summarize "https://www.youtube.com/watch?v=ID" -l ru --fps 0.5 --start 2m
```

### Targeted Q&A

```bash
youtube-summarize "URL" -p "What dataset did the speaker use? Quote the exact phrase + timestamp."
```
