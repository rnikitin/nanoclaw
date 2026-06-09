# NanoClaw → Hermes Migration Plan

> **For Hermes:** Use `software-development/subagent-driven-development` or `software-development/writing-plans` to execute this plan task-by-task. Do not migrate secrets into reports. Stop NanoClaw scheduled tasks only after Hermes equivalents are imported disabled and verified.

**Goal:** Migrate the existing `/root/nanoclaw` bot assistant into Hermes Agent while preserving group identities, Telegram behavior, scheduled tasks, files, skills, memory/dreaming artifacts, and improving reliability through Hermes native gateway, cron, skills, Honcho memory, and optional GBrain knowledge retrieval.

**Architecture:** Keep Hermes as the primary gateway (`hermes-gateway.service`) and gradually replace NanoClaw (`nanoclaw.service`) using a reversible cutover. Map NanoClaw folder identities directly to separate Telegram forum topics in the existing Hermes supergroup, with a matching lightweight-but-complete per-topic workdir under `/root/hermes-topics/`. Convert NanoClaw Claude Code skills into Hermes skills where still useful, convert active NanoClaw tasks into Hermes cron jobs disabled first, then enable in batches after shadow-run verification. Import long-lived memory into topic workdirs, topic bootstrap messages, Honcho/GBrain namespaces, then stop/disable NanoClaw and remove the runtime after verified backup and copy.

**Tech Stack:** Hermes Agent, Telegram gateway/forum topics, Hermes cron, Hermes skills, Honcho memory provider, GBrain, systemd, SQLite exports, Python/Node migration scripts, rsync/tar backups.

---

## 0. Current Verified State

### Hermes

- Active profile: `default`.
- Model/provider: `gpt-5.5` via OpenAI Codex.
- Gateway: `hermes-gateway.service`, systemd system service, active.
- Telegram: configured, home chat `47319110`.
- Allowed Telegram supergroup: `-1003986432864`.
- Telegram behavior already configured:
  - `require_mention: false`
  - `observe_unmentioned_group_messages: true`
  - `group_allowed_chats: ['-1003986432864']`
- Memory provider: `honcho`, status available.
- Honcho self-hosted API: `http://localhost:8000`.
- GBrain installed: `/root/.bun/bin/gbrain`, version `0.42.37.0`, embeddings verified.
- Hermes cron currently has only one active job: `Hermes update watchdog`.

### NanoClaw

- Root: `/root/nanoclaw`.
- Version: `1.2.17`.
- Service: `nanoclaw.service`, active, running `/root/nanoclaw/dist/index.js`.
- Stack: Node.js/TypeScript, SQLite, Docker containers, Claude Agent SDK, Telegram/Discord channel adapters.
- Important roots:
  - `/root/nanoclaw/groups`
  - `/root/nanoclaw/store/messages.db`
  - `/root/nanoclaw/data/ipc`
  - `/root/nanoclaw/data/sessions`
  - `/root/nanoclaw/container/skills`
  - `/root/nanoclaw/.claude/skills`
- Current trigger model: assistant name from DB/main group, default `@Ark`; trigger regex is `^@<assistant>\b`, case-insensitive.
- NanoClaw currently has 85 TypeScript files under `src/`.
- Active channels in source: Telegram and Discord.
- Container isolation model:
  - main group mounts project root read-only + store writable + group writable + global writable;
  - non-main groups mount only group writable + global read-only + shared skills read-only;
  - per-chat `chatJid` session state under `data/sessions/{folder}/{sanitizedJid}/.claude/`.

### NanoClaw groups and memory counts

- `global`
  - key file: `CLAUDE.md` 11,333 bytes
  - skills: `yt-dlp-download`
- `main`
  - key file: `CLAUDE.md` 6,578 bytes
- `telegram_main`
  - key file: `CLAUDE.md` 2,747 bytes
  - skills: `canvas-tasks`, `tasks`, `weekly-report`
  - knowledge graph: 99 entities, 8,391 relations
  - recall entries: 51
- `telegram_trading-room`
  - key file: `CLAUDE.md` 2,986 bytes
  - skills: `trade-monitor`, `trade-open`, `trade-setup`
  - knowledge graph: 24 entities, 123 relations
  - recall entries: 6
- `telegram_algotrading-room`
  - key files: `CLAUDE.md` and `AGENTS.md`, both 14,678 bytes
  - knowledge graph: 393 entities, 10,211 relations
  - recall entries: 8
- `telegram_datamate-research`
  - key file: `CLAUDE.md` 3,352 bytes
  - skills: `reddit-rss`, `transcript-ingest`
  - knowledge graph: 409 entities, 9,363 relations
  - recall entries: 2
- `telegram_family-office`
  - key file: `CLAUDE.md` 274 bytes
  - empty knowledge graph / recall
- `telegram_nastya`
  - key file: `CLAUDE.md` 1,834 bytes
  - knowledge graph: 6 entities, 15 relations
  - recall entries: 2

### NanoClaw scheduled task inventory

Unique task statuses from `data/ipc/*/current_tasks.json`:

- `active`: 20
- `paused`: 1
- `disabled`: 1
- `completed`: 64

Active/paused/disabled distribution:

- `telegram_main`: 7 active
- `telegram_trading-room`: 3 active
- `telegram_algotrading-room`: 4 active, 1 paused
- `telegram_datamate-research`: 6 active, 1 disabled
- `telegram_family-office`: none active
- `telegram_nastya`: none active

---

## 1. Migration Principles

1. **No secret leakage**
   - Never print `.env`, Telegram tokens, Claude OAuth, GitHub tokens, Notion tokens, Redis URLs, cookies, or API keys.
   - Reports may contain only redacted values.
   - Secrets move to Hermes `.env`, auth store, Bitwarden/secret backend, or remain in existing project-specific env files with restricted permissions.

2. **Reversible cutover**
   - NanoClaw stays running until Hermes has disabled imports for all active jobs and at least one verified topic/session.
   - Stop NanoClaw only during final cutover window.
   - Keep backup + service baseline so rollback is `systemctl stop hermes-gateway` / restore config / `systemctl start nanoclaw` if needed.

3. **Preserve folder vs chatJid semantics through Telegram topics**
   - NanoClaw `folder` = identity/context bundle.
   - NanoClaw `chatJid` = conversation/session.
   - Hermes target should preserve this by mapping each old folder/chat identity to a dedicated Telegram forum topic/session. Do **not** create a parallel `/root/hermes-workspaces/nanoclaw/groups/` tree.

4. **Use Hermes native systems instead of reimplementing NanoClaw**
   - Messaging: Hermes gateway.
   - Scheduled tasks: Hermes cron.
   - Durable memory: Honcho + Hermes memory + imported markdown files.
   - Knowledge base/RAG: GBrain where useful.
   - Reusable behavior: Hermes skills.
   - Isolated execution: Hermes toolsets, approvals, delegation, optional profiles, and temporary original NanoClaw `workdir` only for file-dependent jobs; not NanoClaw Docker containers unless a specific task truly needs container parity.

5. **Import disabled first**
   - All NanoClaw active scheduled tasks become Hermes cron jobs in paused/disabled state first.
   - Enable batches only after manual verification of delivery topic and any required original NanoClaw path access.

6. **Improve while preserving**
   - Replace `WAKE/DONE` file-log boilerplate with cron output + optional script logs.
   - Replace ad-hoc `send_message`/`notify` strings with cron delivery targeting.
   - Convert repeated prompt boilerplate into skills or scripts.
   - Use `no_agent=True` for deterministic shell/script watchdogs.

---

## 2. Target Topology

### Telegram target is the data layout

Use the existing Hermes Telegram supergroup:

- raw chat id: `-1003986432864`

Create or map forum topics:

- `main`
- `trading-room`
- `algotrading-room`
- `datamate-research`
- `family-office`
- `nastya`
- `ops-migration`

Each old NanoClaw folder maps to one Hermes delivery target:

```text
telegram:<supergroup_id>:<message_thread_id>
```

Example shape:

```text
telegram:-1003986432864:12345
```

Do not guess thread ids. Create/list topics first, then write `target-topics.json`.

**Final user decision:** create `/root/hermes-topics/` as the canonical per-topic workdir root. Copy the NanoClaw group data into the matching topic workdirs now, then review/clean/adapt inside each topic later. NanoClaw is not kept as the long-term source of truth; it is backed up, stopped, disabled, and removed after verification.

### Final filesystem layout

```text
/root/hermes-topics/
  main/
  trading-room/
  algotrading-room/
  datamate-research/
  family-office/
  nastya/
  ops-migration/

/root/hermes-migration/nanoclaw/
  reports/
  exports/
  scripts/
  target-topics.json
  cron-import.json
  cron-import.sh
```

Mapping:

```text
/root/nanoclaw/groups/telegram_main              -> /root/hermes-topics/main
/root/nanoclaw/groups/telegram_trading-room      -> /root/hermes-topics/trading-room
/root/nanoclaw/groups/telegram_algotrading-room  -> /root/hermes-topics/algotrading-room
/root/nanoclaw/groups/telegram_datamate-research -> /root/hermes-topics/datamate-research
/root/nanoclaw/groups/telegram_family-office     -> /root/hermes-topics/family-office
/root/nanoclaw/groups/telegram_nastya            -> /root/hermes-topics/nastya
/root/nanoclaw/groups/global                     -> /root/hermes-topics/main/global-import
```

`ops-migration` is a fresh operational topic/workdir for migration logs, import reports, and rollback notes.

### Memory layout

Use three layers:

1. **Hermes/Honcho conversational memory**
   - New conversations and durable user facts go into Honcho through Hermes.

2. **Topic bootstrap context**
   - Convert group `CLAUDE.md` / `AGENTS.md` into concise topic bootstrap messages and/or topic-specific prompt snippets.
   - Store full converted markdown under `/root/hermes-migration/nanoclaw/exports/<topic>/` for audit, but the active user-facing layout is the Telegram topic, not a new workdir.

3. **GBrain knowledge base**
   - Import high-value static/project memory and knowledge graph exports into GBrain pages.
   - Use GBrain for retrieval-heavy groups like `algotrading-room`, `datamate-research`, and `telegram_main`.

### Skills mapping

NanoClaw skills should be classified:

- Already covered by Hermes native/bundled skills:
  - `audio-transcribe` → Hermes STT / `stt.enabled`
  - `pdf-reader` → Hermes `ocr-and-documents` / file tools
  - `youtube-summarize`, `youtube-data`, `yt-dlp-download` → Hermes `media/youtube-content` plus possibly custom helper scripts
  - `agent-browser` → Hermes browser automation
  - `planning-mode` → Hermes `software-development/writing-plans`
  - `status` / `capabilities` → Hermes `/status`, `/commands`, `hermes status`
- Convert to Hermes local skills:
  - `trade-monitor`
  - `trade-open`
  - `trade-setup`
  - `tasks`
  - `canvas-tasks`
  - `weekly-report`
  - `reddit-rss`
  - `transcript-ingest`
- Archive only unless requested:
  - NanoClaw setup/update/channel-add skills (`add-whatsapp`, `add-discord`, `add-telegram`, etc.)

### Scheduled tasks mapping

NanoClaw task fields map to Hermes cron like this:

- `schedule_type=cron`, `schedule_value=<cron>` → `cronjob(action='create', schedule='<cron>')`
- `schedule_type=interval`, milliseconds → convert to `every <duration>` when safe
- `schedule_type=once`, ISO timestamp → one-shot cron schedule
- `execution_mode=script` → prefer `script=<path>`, `no_agent=True` if output is already final
- `execution_mode=agent` → use normal agent cron with `prompt=<self-contained prompt>`
- `precondition` → wrapper script that exits silently if precondition fails, or `script` context collector before agent prompt
- `group_folder` → Telegram topic target + `workdir=/root/hermes-topics/<topic>`
- `chat_jid` / folder → `deliver=telegram:-1003986432864:<topic_id>`

---

## 3. Detailed Implementation Tasks

### Task 1: Create backups and frozen baselines

**Objective:** Make rollback possible before touching NanoClaw or importing jobs.

**Files:**

- Create: `/root/backups/nanoclaw-hermes-migration-2026-06-09/`
- Create: `/root/hermes-migration/nanoclaw/reports/service-baseline.txt`
- Create: `/root/hermes-migration/nanoclaw/reports/disk-baseline.txt`

**Steps:**

1. Create directories:

```bash
mkdir -p /root/backups/nanoclaw-hermes-migration-2026-06-09
mkdir -p /root/hermes-migration/nanoclaw/reports
mkdir -p /root/hermes-migration/nanoclaw/exports
mkdir -p /root/hermes-migration/nanoclaw/scripts
# Do not create /root/hermes-workspaces/nanoclaw/groups; topics are the target layout.
```

2. Record service state without secrets:

```bash
{
  date -u
  systemctl is-active nanoclaw.service || true
  systemctl is-active hermes-gateway.service || true
  systemctl status nanoclaw.service --no-pager --lines=40 \
    | sed -E 's/(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)[^ ]*/\1=<redacted>/g'
  systemctl status hermes-gateway.service --no-pager --lines=40 \
    | sed -E 's/(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)[^ ]*/\1=<redacted>/g'
} | tee /root/hermes-migration/nanoclaw/reports/service-baseline.txt
```

3. Record disk baseline:

```bash
{
  date -u
  du -sh /root/nanoclaw /root/.hermes /root/honcho /root/.gbrain 2>/dev/null || true
  df -h /root
} | tee /root/hermes-migration/nanoclaw/reports/disk-baseline.txt
```

4. Back up NanoClaw critical state:

```bash
rsync -aH --numeric-ids \
  --exclude 'node_modules' \
  --exclude '.git/objects' \
  --exclude 'dist' \
  --exclude 'build' \
  --exclude 'logs/*.log' \
  /root/nanoclaw/groups \
  /root/nanoclaw/data \
  /root/nanoclaw/store \
  /root/nanoclaw/container \
  /root/nanoclaw/.claude \
  /root/backups/nanoclaw-hermes-migration-2026-06-09/nanoclaw-critical/
```

5. Back up Hermes state:

```bash
rsync -aH --numeric-ids /root/.hermes/ /root/backups/nanoclaw-hermes-migration-2026-06-09/hermes-state/
```

**Verification:**

```bash
test -d /root/backups/nanoclaw-hermes-migration-2026-06-09/nanoclaw-critical/groups
test -d /root/backups/nanoclaw-hermes-migration-2026-06-09/hermes-state
```

Expected: both commands exit 0.

---

### Task 2: Generate redacted migration inventory

**Objective:** Produce machine-readable inventory for groups, memories, skills, tasks, and DB tables.

**Files:**

- Create: `/root/hermes-migration/nanoclaw/reports/nanoclaw-inventory.json`
- Create: `/root/hermes-migration/nanoclaw/reports/hermes-inventory.txt`

**Steps:**

1. Generate NanoClaw inventory with a script that never prints secrets:

```bash
python3 /root/hermes-migration/nanoclaw/scripts/inventory_nanoclaw.py \
  > /root/hermes-migration/nanoclaw/reports/nanoclaw-inventory.json
```

2. If the script does not exist yet, create it from the inventory logic used during planning:

- scan `/root/nanoclaw/groups`
- count files/bytes
- list key files (`CLAUDE.md`, `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `README.md`)
- list group skills
- count SQLite graph tables
- parse `data/ipc/*/current_tasks.json`
- redact secret-like strings before writing JSON

3. Capture Hermes state:

```bash
{
  hermes status --all
  hermes memory status
  hermes cron list --all
  hermes profile list
} > /root/hermes-migration/nanoclaw/reports/hermes-inventory.txt
```

**Verification:**

```bash
python3 -m json.tool /root/hermes-migration/nanoclaw/reports/nanoclaw-inventory.json >/dev/null
```

Expected: JSON parses cleanly and contains no raw keys/tokens.

---

### Task 3: Create or map Telegram forum topics

**Objective:** Establish delivery targets before importing cron jobs.

**Files:**

- Create: `/root/hermes-migration/nanoclaw/target-topics.json`

**Steps:**

1. Confirm bot can manage topics in `-1003986432864`:

- use Telegram Bot API `getMe`, `getChat`, `getChatMember`
- verify `type=supergroup`, `is_forum=true`, `can_manage_topics=true`
- never print the bot token

2. Create missing topics:

- `main`
- `trading-room`
- `algotrading-room`
- `datamate-research`
- `family-office`
- `nastya`
- `ops-migration`

3. Write target mapping:

```json
{
  "telegram_main": "telegram:-1003986432864:<main_thread_id>",
  "telegram_trading-room": "telegram:-1003986432864:<trading_thread_id>",
  "telegram_algotrading-room": "telegram:-1003986432864:<algotrading_thread_id>",
  "telegram_datamate-research": "telegram:-1003986432864:<datamate_thread_id>",
  "telegram_family-office": "telegram:-1003986432864:<family_thread_id>",
  "telegram_nastya": "telegram:-1003986432864:<nastya_thread_id>",
  "ops-migration": "telegram:-1003986432864:<ops_thread_id>"
}
```

4. Send one test message to each topic using `send_message`.

**Verification:**

- Each topic receives exactly one test message.
- Hermes gateway discovers the topics after message traffic or after `/restart`.
- `target-topics.json` contains raw thread ids, not topic names only.

---

### Task 4: Create `/root/hermes-topics/` and copy all NanoClaw group data

**Objective:** Make `/root/hermes-topics/` the canonical per-topic workdir root and copy the existing NanoClaw group data there for later cleanup/adaptation inside each topic.

**Files:**

- Create: `/root/hermes-topics/main/`
- Create: `/root/hermes-topics/trading-room/`
- Create: `/root/hermes-topics/algotrading-room/`
- Create: `/root/hermes-topics/datamate-research/`
- Create: `/root/hermes-topics/family-office/`
- Create: `/root/hermes-topics/nastya/`
- Create: `/root/hermes-topics/ops-migration/`
- Create: `/root/hermes-topics/main/global-import/`

**Steps:**

1. Create topic directories.
2. Copy NanoClaw group folders with `rsync -aH --numeric-ids` into the matching topic directories.
3. Copy `groups/global` into `/root/hermes-topics/main/global-import`.
4. Write a `MIGRATION_SOURCE.md` in each topic with:
   - source NanoClaw folder
   - copy timestamp
   - intended Telegram topic target
   - cleanup status
5. Keep all data initially. Do not prune logs, `.dreams`, skills, or local project files during the first copy. Cleanup happens later inside each topic.

**Verification:**

- Every `/root/hermes-topics/<topic>/` exists.
- Every copied topic has its source files.
- `du -sh /root/hermes-topics/*` shows non-empty directories for imported groups.
- No copy errors in rsync logs.

---

### Task 5: Export NanoClaw dreaming memory and knowledge graphs

**Objective:** Preserve `.dreams` memory in formats Hermes/GBrain can consume.

**Files:**

- Create: `/root/hermes-migration/nanoclaw/exports/<group>/entities.csv`
- Create: `/root/hermes-migration/nanoclaw/exports/<group>/relations.csv`
- Create: `/root/hermes-migration/nanoclaw/exports/<group>/recall.csv`
- Create: `/root/hermes-migration/nanoclaw/exports/<topic>/knowledge-graph.md`
- Create: `/root/hermes-migration/nanoclaw/exports/<topic>/recall.md`

**Steps:**

1. Write SQLite export script:

```bash
python3 /root/hermes-migration/nanoclaw/scripts/export_dreams.py
```

2. Script behavior:

- for each `groups/<folder>/.dreams/knowledge-graph.db`, export all tables to CSV
- for each `groups/<folder>/.dreams/recall.db`, export recall entries to CSV
- generate markdown summaries:
  - top entities by degree
  - relation counts by type
  - latest recall entries
  - warnings for empty graphs

3. Link markdown summaries from the matching Telegram topic bootstrap and, where useful, send a concise summary into the topic. Keep the full markdown under `/root/hermes-migration/nanoclaw/exports/<topic>/`.

4. Import high-value summaries into GBrain:

```bash
cd /root/brain
# one page per group, exact command depends on final GBrain import strategy
gbrain put-page nanoclaw/<group>/memory --file /root/hermes-migration/nanoclaw/exports/<topic>/knowledge-graph.md
```

If `gbrain put-page` syntax differs, run `gbrain --help` and adapt.

**Verification:**

- Counts in exported CSV match planning inventory:
  - algotrading-room: about 393 entities, 10k relations
  - datamate-research: about 409 entities, 9k relations
  - main: about 99 entities, 8k relations
- `gbrain query "nanoclaw datamate research memory"` returns imported pages after embedding.

---

### Task 6: Convert NanoClaw skills to Hermes skills

**Objective:** Preserve specialized behavior without carrying NanoClaw runtime assumptions.

**Files:**

- Create: `/root/.hermes/skills/nanoclaw-trade-monitor/SKILL.md`
- Create: `/root/.hermes/skills/nanoclaw-trade-open/SKILL.md`
- Create: `/root/.hermes/skills/nanoclaw-trade-setup/SKILL.md`
- Create: `/root/.hermes/skills/nanoclaw-tasks/SKILL.md`
- Create: `/root/.hermes/skills/nanoclaw-weekly-report/SKILL.md`
- Create: `/root/.hermes/skills/nanoclaw-reddit-rss/SKILL.md`
- Create: `/root/.hermes/skills/nanoclaw-transcript-ingest/SKILL.md`

**Steps:**

1. Classify every NanoClaw skill into one of:

- native Hermes equivalent
- convert to Hermes skill
- archive only

2. For each converted skill:

- read original `SKILL.md`
- identify hard-coded paths (`/workspace/group`, `/workspace/global`)
- rewrite to topic-relative instructions and, only for file-dependent workflows, explicit original NanoClaw archive paths
- document required commands and env vars
- add verification command
- add failure modes

3. Convert shell helpers into linked skill files:

```text
references/
templates/
scripts/
```

4. Avoid copying secrets, cookies, OAuth JSON, or tokenized config into skill dirs.

**Verification:**

```bash
hermes skills list | grep nanoclaw
```

Expected: converted skills are visible. For each skill, `skill_view` loads cleanly.

---

### Task 7: Convert active/paused/disabled tasks to Hermes cron import JSON

**Objective:** Convert NanoClaw scheduler state into reviewable Hermes cron definitions before creating any jobs.

**Files:**

- Create: `/root/hermes-migration/nanoclaw/cron-import.json`
- Create: `/root/hermes-migration/nanoclaw/task-archive.md`

**Steps:**

1. Write converter:

```bash
python3 /root/hermes-migration/nanoclaw/scripts/convert_tasks_to_hermes_cron.py \
  --topics /root/hermes-migration/nanoclaw/target-topics.json \
  --out /root/hermes-migration/nanoclaw/cron-import.json \
  --archive /root/hermes-migration/nanoclaw/task-archive.md
```

2. Conversion rules:

- only active/paused/disabled tasks become import candidates
- completed tasks go to archive markdown only
- `active` NanoClaw tasks become `paused` Hermes jobs initially
- `paused` stays paused
- `disabled` stays disabled/archived, not scheduled
- every prompt becomes self-contained and replaces NanoClaw paths
- every job has a clear `name`, `schedule`, `deliver`, and `enabled_toolsets`; `workdir` is optional and used only for jobs that still need files from `/root/nanoclaw/groups/<old_folder>`

3. Suggested toolsets per category:

- trading monitor / scripts: `terminal,file,web,skills,messaging`
- YouTube summaries: `web,terminal,file,skills,messaging`
- Notion sync: `terminal,file,web,skills,messaging`
- reminders: `web,messaging`
- memory audits: `terminal,file,skills,messaging`

4. Handle preconditions:

- `trade-monitor` every 15 minutes has a precondition.
- Convert it to a wrapper script that exits with empty stdout when no alert is needed.
- Prefer `no_agent=True` if the script can produce final alert text itself; otherwise use the script as pre-run context for an agent job.

**Verification:**

```bash
python3 -m json.tool /root/hermes-migration/nanoclaw/cron-import.json >/dev/null
```

Expected: JSON parses. Number of import candidates should be 22 total: 20 active + 1 paused + 1 disabled, with disabled marked not to create unless explicitly requested.

---

### Task 8: Create Hermes cron jobs paused first

**Objective:** Register cron jobs without allowing duplicate execution.

**Files:**

- Create: `/root/hermes-migration/nanoclaw/cron-create-results.jsonl`

**Steps:**

1. Create jobs from import JSON using a script that calls `hermes cron create` or the cron job API.

2. For each job:

- set `deliver` to the mapped topic target
- set `workdir=/root/hermes-topics/<topic>` for migrated jobs
- set `skills` when a converted skill is needed
- set `enabled_toolsets` narrowly
- create as paused if CLI supports it, otherwise create then immediately pause

3. Add a prefix to job names:

```text
nanoclaw/<group>/<short-task-name>
```

Examples:

- `nanoclaw/trading-room/trade-monitor`
- `nanoclaw/trading-room/dns-youtube-weekly`
- `nanoclaw/main/daily-reminder`
- `nanoclaw/datamate-research/notion-sync`
- `nanoclaw/algotrading-room/research-saturday-1`

**Verification:**

```bash
hermes cron list --all | grep 'nanoclaw/'
```

Expected: all imported jobs appear and are paused/disabled.

---

### Task 9: Shadow-run representative jobs

**Objective:** Verify semantics before stopping NanoClaw.

**Steps:**

1. Pick one representative job per group:

- `telegram_main`: daily reminder or weekly planning
- `telegram_trading-room`: YouTube weekly or a safe no-op trade-monitor dry run
- `telegram_algotrading-room`: memory audit or Saturday research dry run
- `telegram_datamate-research`: memory health or ingest dry run

2. For each selected job:

- run manually via `hermes cron run <job_id>` or equivalent
- deliver to `ops-migration` first, not production topic, if the task may produce noisy output
- inspect logs and output
- compare to NanoClaw expected behavior

3. Fix path/tool/skill issues.

4. Repeat until each representative category has one passing run.

**Verification:**

- Job runs complete without secrets in output.
- Output lands in expected topic.
- Topic delivery and any temporary original NanoClaw workdir paths are correct.
- No task writes to `/root/nanoclaw` unless explicitly intended as archive/reference.

---

### Task 10: Configure Hermes per-topic instructions

**Objective:** Preserve group persona and “when to speak” rules.

**Files:**

- Modify: `/root/.hermes/config.yaml` via `hermes config set` or controlled YAML edit
- Create/update: per-group `AGENTS.md`

**Steps:**

1. Build per-topic prompt snippets from imported `CLAUDE.md` files.

2. Add Telegram `channel_prompts` if Hermes supports per-chat/per-topic prompt keys for this gateway version.

3. Otherwise rely on topic bootstrap messages, Honcho/group session context, GBrain, and cron prompts. Use `/root/hermes-topics/<topic>` as the cron workdir.

4. Keep user’s current Telegram behavior:

- shared context per supergroup/topic
- `require_mention: false`
- respond naturally, but avoid dominating group chats

**Verification:**

- Ask a topic-specific test question in each topic.
- Hermes should answer with the right group identity/context.
- Confirm no cross-topic leakage of sensitive personal memory.

---

### Task 11: Cut over scheduled jobs in batches

**Objective:** Prevent duplicate scheduled executions.

**Steps:**

1. Choose a cutover window.

2. Pause NanoClaw scheduler or stop NanoClaw entirely:

```bash
systemctl stop nanoclaw.service
```

3. Confirm NanoClaw stopped:

```bash
systemctl is-active nanoclaw.service || true
```

Expected: `inactive`.

4. Enable Hermes jobs by group, safest order:

1. `family-office` / `nastya` — no active jobs, verify chat only
2. `main` — reminders/syncs
3. `datamate-research` — Notion/transcript/memory jobs
4. `trading-room` — YouTube + TRONN3 daily
5. `algotrading-room` — research/macro jobs
6. `trade-monitor` — high-frequency preconditioned job last

5. After enabling each batch, monitor:

```bash
hermes cron list --all
journalctl -u hermes-gateway.service -n 200 --no-pager
```

**Rollback:**

If severe issues occur:

```bash
# pause imported Hermes jobs first
hermes cron list --all
# pause each nanoclaw/* job
systemctl start nanoclaw.service
```

---

### Task 12: Decommission NanoClaw runtime but keep archive

**Objective:** Remove duplicate bot behavior while retaining auditability.

**Steps:**

1. After 7 days stable operation, disable NanoClaw auto-start:

```bash
systemctl disable nanoclaw.service
```

2. Keep `/root/nanoclaw` read-only/archive.

3. Move old logs and exports into `/root/hermes-migration/nanoclaw/archive-index.md`.

4. Do not delete NanoClaw until at least one full cycle of weekly jobs has passed.

**Verification:**

```bash
systemctl is-enabled nanoclaw.service || true
systemctl is-active nanoclaw.service || true
```

Expected after decommission: disabled + inactive.

---

## 4. Improvement Opportunities During Migration

### A. Replace per-task WAKE/DONE boilerplate

Old NanoClaw prompts often start and end with manual log writes. In Hermes:

- Use cron job execution logs for job lifecycle.
- Keep script-specific logs only where they are domain artifacts.
- For agent jobs, add a short structured final response instead of appending boilerplate.

### B. Split deterministic scripts from reasoning jobs

For jobs that already run a shell command and produce a report:

- Use `script` + `no_agent=True` if stdout is final.
- Use `script` + agent prompt only when interpretation/summarization is needed.

This lowers token spend and reduces failure surface.

### C. Move recurring domain workflows into skills

Examples:

- `nanoclaw-trade-monitor`
- `nanoclaw-datamate-notion-sync`
- `nanoclaw-algotrading-research`

Each cron prompt can become shorter and less brittle by loading a skill instead of embedding long instructions.

### D. Use GBrain for large group memories

Best candidates:

- `algotrading-room` — many entities/relations and trading research history
- `datamate-research` — many entities/relations and transcript/research artifacts
- `telegram_main` — many recall entries and personal task history

### E. Use Honcho for social/personal memory, not raw archives

Do not dump all NanoClaw logs into Honcho. Instead:

- import concise durable conclusions only
- keep raw artifacts in files/GBrain
- let new Hermes conversations build fresh Honcho memory

### F. Optional specialized Hermes profiles

Start with one `default` profile to avoid over-fragmentation. Add profiles only when needed:

- `trading` profile if trading jobs need a different model/toolset/secrets boundary
- `coding` profile if code-heavy jobs should run independently
- `research` profile if long research cron jobs need different model/cost settings

Until then, use cron per-job model/toolset overrides, with `workdir=/root/hermes-topics/<topic>` for topic-specific jobs.

---

## 5. Known Risks

1. **Duplicate scheduled jobs**
   - Mitigation: import paused; stop NanoClaw before enabling Hermes jobs.

2. **Telegram topic misdelivery**
   - Mitigation: create `target-topics.json`; test every target before importing jobs.

3. **Path assumptions**
   - NanoClaw prompts use `/workspace/group`; the Hermes target is Telegram topics, with per-topic workdirs under `/root/hermes-topics/`.
   - Mitigation: rewrite prompts to topic-first language; rewrite prompts and add compatibility env vars/scripts inside each topic workdir as needed.

4. **Secret exposure from old prompts/service args**
   - Mitigation: redaction scripts; never paste full systemd output without filters; do not copy `.env` into exports or topic bootstrap messages.

5. **Loss of container isolation**
   - Hermes local terminal executes on host by default.
   - Mitigation: narrow toolsets, approvals, topic-scoped delivery, per-topic workdirs, and optionally use Docker/SSH terminal backend for high-risk tasks.

6. **Behavioral drift from Claude Code SDK to Hermes model/tool loop**
   - Mitigation: shadow-run representative jobs and compare outputs.

7. **Memory over-import**
   - Dumping raw old memory into active prompt can degrade quality.
   - Mitigation: summaries into AGENTS.md, raw exports into GBrain/files.

---

## 6. Definition of Done

Migration is complete when:

- Hermes responds correctly in all target Telegram topics.
- Per-topic/session context does not leak across topics.
- All active NanoClaw tasks are either:
  - imported and enabled in Hermes,
  - intentionally archived,
  - or explicitly replaced by a better Hermes-native workflow.
- NanoClaw service is stopped, disabled, and the runtime removed after backup/copy verification.
- Honcho memory remains available in Hermes.
- GBrain contains imported high-value NanoClaw memory or an explicit decision says not to import it.
- Converted Hermes skills cover all still-needed NanoClaw custom workflows.
- Backups and export reports exist under `/root/backups/nanoclaw-hermes-migration-2026-06-09` and `/root/hermes-migration/nanoclaw`.

---

## 7. Recommended Execution Order

1. Backup and inventory.
2. Create Telegram topics and target mapping.
3. Copy all group data into `/root/hermes-topics/` topic workdirs.
4. Export memory and graph artifacts.
5. Convert high-priority skills.
6. Convert cron jobs to import JSON.
7. Create Hermes cron jobs paused.
8. Shadow-run sample jobs.
9. Stop NanoClaw.
10. Enable Hermes jobs in batches.
11. Remove NanoClaw runtime after backup/copy verification and service shutdown.
12. Monitor Hermes topics/jobs for one week.

---

## 8. Immediate Next Step

Implement **Task 1** and **Task 2** first. They are read-only/safe except for creating backup/report directories. Do not create cron jobs or stop NanoClaw until inventory and topic mapping are reviewed.
