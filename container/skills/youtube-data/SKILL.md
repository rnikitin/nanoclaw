---
name: youtube-data
description: Query YouTube via the official Data API v3 — search videos, look up channel info and uploads, fetch video metadata, list playlist items, read comments. No cookies, no scraping. Use whenever the user asks to find/list/look up anything on YouTube (titles, durations, view counts, comments, latest uploads of a channel, etc.). For actually watching/summarizing a video, hand the URL off to the youtube-summarize skill.
allowed-tools: Bash(youtube-data:*)
---

# YouTube Data API v3

A single CLI with subcommands. Reads `$YOUTUBE_API_KEY` from container env. All subcommands accept `--json` for raw structured output.

## Subcommands

| Subcommand | Purpose | Quota cost |
|---|---|---|
| `search <q>` | Free-text search for videos | 100 |
| `channel <input>` | Channel info (subs, video count, description, uploads playlist id) | 1 |
| `latest <input>` | Newest videos uploaded by a channel | 2–3 |
| `video <id_or_url>` | Single video details (duration, stats, live status, channel) | 1 |
| `playlist <id>` | Items in a playlist | 1 |
| `comments <id_or_url>` | Top-level comments on a video | 1 |
| `transcript <id_or_url>` | Caption/subtitle text without watching the video | 0 (no Data API call) |

`<input>` for channel/latest accepts: bare channelId (`UC…`), `@handle`, channel URL, or any video URL on that channel (auto-resolves; +1 quota).

Daily project quota is 10 000 units. `search` is the only expensive subcommand — use `latest` whenever you know the channel.

## Quick start

```bash
youtube-data search "qwen3 release" -n 5
youtube-data search "qwen3" --order date --lang ru

youtube-data channel @lexfridman
youtube-data channel UCo1RPtO57Izwy2wjBmPMjCw

youtube-data latest @mkbhd -n 10
youtube-data latest UCo1RPtO57Izwy2wjBmPMjCw --since 7d --skip-live --min-duration 30m

youtube-data video AqwL4R5o_Ik
youtube-data video "https://www.youtube.com/watch?v=AqwL4R5o_Ik" --json

youtube-data playlist PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf -n 20

youtube-data comments AqwL4R5o_Ik -n 20 --order relevance
```

## `search`

```bash
youtube-data search <query> [-n N] [--order relevance|date|viewCount|rating|title] [--lang ru] [--region RU] [--published-after RFC3339] [--published-before RFC3339] [--json]
```

Output: list of `title`, `url`, `channel`, `published`, truncated `description`.

## `channel`

```bash
youtube-data channel <input> [--json]
```

Prints: title, handle, channelId, subscriberCount, videoCount, viewCount, description, country, custom URL, uploads playlist id.

## `latest`

```bash
youtube-data latest <input> [-n N] [--since 7d] [--skip-live] [--min-duration 5m] [--max-duration 1h] [--json]
```

Output per item: title, url, publishedAt, duration (human-readable), `live` (`none|live|upcoming`).

Use `--min-duration 5m` to filter out Shorts. `--skip-live` drops items currently broadcasting or scheduled to broadcast (keeps finished livestream VODs).

## `video`

```bash
youtube-data video <id_or_url> [--json]
```

Prints: title, channel, publishedAt, duration, viewCount, likeCount, commentCount, `live` state, language, captions availability, description (truncated).

## `playlist`

```bash
youtube-data playlist <playlistId> [-n N] [--json]
```

Lists videos in a playlist (title, url, publishedAt, position).

## `transcript`

```bash
youtube-data transcript <id_or_url> [--lang ru,en] [--timestamps] [--ytdlp-cookies PATH] [--no-ytdlp] [--json]
```

Downloads captions/auto-generated subtitles without spending Data API quota. Tries `youtube-transcript-api` first (no auth) — falls back to `yt-dlp --write-auto-subs` with cookies if the former is blocked (datacenter IPs hit YouTube's bot wall).

- Default `--lang ru,en` — comma-separated priority list. First available wins.
- Plain output: full transcript text on stdout. `--timestamps` prepends `[MM:SS]` per chunk. `--json` returns structured snippets.
- yt-dlp fallback auto-discovers cookies at `/workspace/global/.yt-cookies.txt` (then `~/.yt-cookies.txt`). Override with `--ytdlp-cookies`. Disable entirely with `--no-ytdlp`.
- This is the right tool when `youtube-summarize` returns Gemini 400 (content-policy block on sensitive videos): grab the transcript, then summarize the text with any text LLM.

## `comments`

```bash
youtube-data comments <video_id_or_url> [-n N] [--order relevance|time] [--json]
```

Prints top-level comments: author, likeCount, replyCount, text (truncated). For full thread, use `--json` and walk the `replies` field.

## Common pipelines

### "Anything new from this channel this week?" → summarize

```bash
url=$(youtube-data latest UCo1RPtO57Izwy2wjBmPMjCw \
        --since 7d --skip-live --min-duration 30m --json \
      | jq -r '.items[0].url // empty')
if [ -n "$url" ]; then
  youtube-summarize "$url" -l ru --fps 0.5
else
  echo "No new long-form video this week."
fi
```

### "What do top commenters say?"

```bash
youtube-data comments AqwL4R5o_Ik -n 30 --order relevance
```

### "Compare two channels' release cadence"

```bash
youtube-data latest @lexfridman --since 30d
youtube-data latest @hubermanlab --since 30d
```

## Errors

- `YOUTUBE_API_KEY is not set` — host hasn't injected the key.
- `HTTP 403 quotaExceeded` — wait until midnight Pacific or request a quota bump.
- `HTTP 404 channelNotFound` / `videoNotFound` — bad id/handle/URL.
- `HTTP 400 keyInvalid` — bad/expired key.
- `commentsDisabled` — the video disabled comments; nothing to fetch.
