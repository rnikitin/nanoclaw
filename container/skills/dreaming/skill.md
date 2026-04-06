# Dreaming — Memory Consolidation

Run background memory consolidation for a group.

## Usage

```
/dreaming status    — Check dreaming status
/dreaming run       — Run full dream cycle (light + REM + deep)
/dreaming light     — Run light sleep only
/dreaming deep      — Run deep sleep only
```

## How It Works

Dreaming consolidates short-term memories into long-term storage:

1. **Light Sleep** (every 6h): Ingests daily signals, deduplicates candidates
2. **REM Sleep** (weekly): Extracts patterns, builds theme summaries
3. **Deep Sleep** (daily 3 AM): Scores candidates and promotes to MEMORY.md

Memories are scored on 6 weighted factors:
- Relevance (30%): How well it matched queries
- Frequency (24%): How often it was recalled
- Diversity (15%): From how many different queries
- Recency (15%): How recently it was recalled
- Consolidation (10%): Over how many days
- Conceptual (6%): Concept tag density

Only memories passing all thresholds get promoted to long-term storage.
