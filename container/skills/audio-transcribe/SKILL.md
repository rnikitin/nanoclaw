---
name: audio-transcribe
description: Transcribe audio files (voice notes, podcasts, music with vocals, recordings) to text using OpenRouter multimodal models. Use whenever the user asks to transcribe, caption, or extract speech from an audio file or attachment.
allowed-tools: Bash(transcribe:*), Bash(ls:*), Bash(file:*), Bash(stat:*), Bash(head:*)
---

# Audio Transcribe

Send an audio file to OpenRouter's multimodal API (default: `google/gemini-2.5-flash`) and print the transcript on stdout. Reads the API key from the `OPENROUTER_API_KEY` env var that the host injects into every container.

## Quick start

```bash
transcribe voice.ogg                     # default model + neutral prompt
transcribe podcast.mp3 -l ru             # language hint
transcribe interview.m4a -m openai/gpt-4o-audio-preview
transcribe note.opus -p "Summarize the audio in 3 bullets in Russian."
transcribe note.wav --json               # full API response
```

## Inputs

- File extension determines the format sent to the API. Supported: wav, mp3, m4a, ogg, opus, flac, aac, aiff.
- Other extensions → error. Use `ffmpeg` (when available) or yt-dlp's `--audio-format` to convert first.
- The whole file is base64-encoded into the request body. Practical ceiling is ~25 MB of source audio per call. For longer recordings, split with `ffmpeg -ss/-t` first and concatenate the transcripts.

## Output

Default: just the transcript text on stdout. Stderr carries errors.

`--json` returns the raw OpenRouter response (useful for token usage, model id, finish reason).

## Models

`google/gemini-2.5-flash` is a strong default — multilingual, fast, cheap.

Other audio-capable models on OpenRouter include `openai/gpt-4o-audio-preview` and `google/gemini-2.5-pro`. Check https://openrouter.ai/models?modality=audio for the current list.

## Common patterns

### Transcribe a Telegram voice note

Voice messages arrive in `/workspace/group/attachments/<...>.ogg` (Opus inside Ogg). Pass the path straight to `transcribe`.

```bash
transcribe /workspace/group/attachments/voice-2026-04-28.ogg -l ru
```

### Save the transcript next to the audio

```bash
out="${file%.*}.txt"
transcribe "$file" -l ru > "$out"
```

### JSON for downstream processing

```bash
transcribe note.mp3 --json | jq '.usage, .choices[0].message.content'
```

## Errors

- `OPENROUTER_API_KEY is not set` → host hasn't injected the key. Restart nanoclaw service or report to the operator.
- `Unsupported audio extension` → convert to one of the listed formats.
- `OpenRouter HTTP 401` → bad/expired key.
- `OpenRouter HTTP 413` → file too large; split it.
- `Unexpected response shape` → model returned something the parser didn't expect; rerun with `--json` and inspect.
