# Settings

All settings live in one JSON file: `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json` (typically `~/.pi/agent/extensions/pi-telegram-manager/settings.json`). Every key is optional and layered over the defaults below. Unknown keys are ignored with a warning; a present-but-wrong-typed value fails loudly with the offending path. Changes take effect on the next Pi session restart.

**Override semantics.** For plain values (numbers, booleans, strings) a setting **replaces** the default. Two list settings are special: instruction-file lists are **appended** to the built-in instructions (they add, never replace), and `manager.mentionWords` / `manager.allowedTools` follow the per-row notes below.

## Top level

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `botToken` | — | replaces | Telegram bot token, or `"env:VAR"` to read it from the environment. Required. |
| `allowedUserId` | — | replaces | Your Telegram numeric user id — the **only** user the bot obeys and the DM it uses for Personal mode, `/switch`, and the debug feed. Required for Personal mode and for `/switch`. |
| `timezone` | system zone | replaces | IANA timezone (e.g. `"Asia/Almaty"`) for the `[Now: …]` line shown to the model. |
| `instructionFiles` | `[]` | **appended** | Markdown files added to the system instructions in **all** modes. |

## `assistant` (Personal mode)

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `assistant.rendering` | `"rich"` | replaces | `"rich"` (native Bot API rich Markdown) or `"html"`. |
| `assistant.draftPreviews` | `true` | replaces | Stream the reply as an animated draft while it generates. |
| `assistant.toolActivity` | `true` | replaces | Mirror each agent tool call to the chat as a collapsible block — turns the bot DM into a live log of the model's work in Personal mode. |
| `connect.instructionFiles` | `[]` | **appended** | Extra instruction files for Personal mode only. |

## `mixed` (mixed mode)

Mixed runs the manager alongside your terminal session in one Pi session, with the terminal always the priority.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `mixed.returnToTelegramMs` | `480000` (8 min) | replaces | After your terminal inference **finishes** (or an abort settles), how long the brain stays idle before it returns to Telegram moderation. The countdown starts when the turn **ends**, not while it runs; any new terminal prompt cancels it. |

**Priority & algorithm.** While you are at the terminal (the `coding` polarity) the manager may not run a turn: incoming Telegram messages are stored and deferred, and **even a wake-word does not preempt you** — it only marks the chat ready. Nothing from Telegram enters your terminal context or costs you tokens. When your inference has been idle for `mixed.returnToTelegramMs`, the brain flips to the `telegram` polarity and moderates the ready chats in the sub-mode you picked. The instant you type again it flips back, aborts any in-flight moderation, and restores your full tools. In the `telegram` polarity the model runs in the sandbox (messaging tools only — no `read`/`write`/`bash`); your full tools exist only while you hold the terminal. The log of what it did while you were away lands in the **log** topic of your bot DM (`manager.log`, on by default).

## `connectionCheck` (connection watchdog, all modes)

A silent timer probes the bot connection while a mode is active; after too many consecutive failures the mode auto-disconnects. Probes never post to chat or the debug feed — only the final auto-disconnect is surfaced.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `connectionCheck.enabled` | `true` | replaces | Run the watchdog while a mode is active. |
| `connectionCheck.intervalMs` | `600000` (10 min) | replaces | Probe interval. `0` also disables it. |
| `connectionCheck.maxRetries` | `3` | replaces | Consecutive failed probes tolerated before auto-disconnect. |


## `topics` (owner DM layout)

Bot API 9.3 lets a bot create forum topics **inside a private chat**, so your DM with the bot is split in two: **chat** — the conversation with the model (Personal, and the mixed continuation) — and **log** — the manager feed, runtime notices and Personal-mode tool activity. The conversation topic stays free of logs.

It needs **Threaded Mode** on the bot, toggled in the **@BotFather Mini App** (tap BotFather's menu button → your bot → Threaded Mode). It is *not* in the classic `/mybots` → Bot Settings keyboard. Without it (or on any error) everything degrades to the single plain DM exactly as before — nothing to configure, nothing breaks.

The two thread ids are remembered on disk (`topics.json`); a topic you delete while the bot is off is simply recreated on the next start.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `topics.enabled` | `true` | replaces | Use topics when the bot supports them. `false` keeps one flat DM. |
| `topics.chatName` | `"chat"` | replaces | Name of the conversation topic. |
| `topics.logName` | `"log"` | replaces | Name of the observability topic. |

## `manager` (business manager, and the Telegram side of mixed)

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `manager.ownerName` | — | replaces | Your display name, so the bot can introduce itself as "{name}'s assistant" on first contact. |
| `manager.ownerReplyWindowMs` | `300000` (5 min) | replaces | How long a first message from someone is held so **you** can answer before the bot may. |
| `manager.continueWindowMs` | `90000` (1:30) | replaces | After the bot replies, how long the chat stays "live" (a new message keeps it active instead of re-queuing). Also governs when things are quiet enough to resume memory consolidation. |
| `manager.liveFreshnessMs` | `120000` (2 min) | replaces | A message older than this (by its true send time) is recorded for context but does **not** wake a live reply cycle — so a redelivered old backlog never "wakes" the bot. |
| `manager.catchUpWindowMs` | `36000000` (10 h) | replaces | On activation, the bot may answer for you in a waiting chat only if its last message is newer than this. |
| `manager.reopenAfterMs` | `86400000` (24 h) | replaces | A chat resuming after this much silence is re-greeted. `0` disables re-greeting. |
| `manager.rememberMessages` | `20` | replaces | Last-N messages per chat the model reads each turn. Also bounds the transcript kept on disk (old messages are pruned to ~2× this). |
| `manager.maxCharsPerMessage` | `4000` | replaces | Character cap on a single message in the window the model reads — a longer one is truncated with a `…[+N chars]` marker, so one huge paste can't dominate a small local context. `0` disables. Disk transcripts are never trimmed. |
| `manager.maxContextChars` | `40000` | replaces | Character budget for the whole last-N window: the oldest messages are dropped until the kept text fits (the newest is always kept). Bounds the window by size, not just count, so 20 long messages still fit a small model. `0` disables. |
| `manager.factsLimit` | `20` | replaces | Last-N durable facts kept and injected per contact. |
| `manager.factConsolidationQuietMs` | `1800000` (30 min) | replaces | Quiet period after a chat's last activity before an idle memory-consolidation pass may run on it. |
| `manager.verifyLimit` | `8` | replaces | Max candidate facts individually verified in one consolidation pass. |
| `manager.reviseThreshold` | `2` | replaces | How many times a drafted reply may be reconsidered when new messages keep arriving mid-turn before it is sent as-is. `0` sends immediately. |
| `manager.strictReplyGuard` | `true` | replaces | Drop a reply the model itself tagged as chatter/acknowledgement (or "no reply needed") unless it was directly addressed. Curbs a weak model over-replying to banter. |
| `manager.mentionWords` | `["llm", "manager"]` | **replaces list** (+ labeler) | Wake-words — see [Wake-words](#wake-words) below. |
| `manager.labeler` | `"LLM agent 🤖:"` | replaces | The banner prefixed to each outgoing business reply, rendered as a blockquote so it stands apart from a message you typed. `""` removes the banner entirely (and the rule line with it). |
| `manager.labelerRule` | `"────────────"` | replaces | A second line under the labeler, inside the same blockquote — a horizontal rule that makes the banner taller and easier to spot. You control its look and length by the string itself; `""` removes just the rule line (the labeler stays). Ignored when `labeler` is `""`. |
| `manager.log` | `true` | replaces | Mirror every turn (thinking, tool calls, decision) to your bot DM — the moderation log for manager and mixed. With `topics` on it goes to its own **log** topic, so it never buries the conversation; without topics it shares the single DM and is chatty in Observer (turn it off there). Renamed from `manager.debugFeed`, which is still read when this key is unset. |
| `manager.media.images` | `true` | replaces | Let the model see interlocutor images (vision). |
| `manager.media.documents` | `false` | replaces | Accept non-image documents (otherwise refused). |
| `manager.allowedTools` | `[]` | **adds to base** | Regex names of extra tools the model may call, on top of the built-in messaging tools. Empty = telegram-sandbox (messaging tools only, no computer access). |
| `manager.instructionFiles` | `[]` | **appended** | Extra instruction files for the manager. |
| `manager.firstMessageTemplate` | — | replaces | Override file for the first-contact greeting template. |
| `manager.reopenTemplate` | — | replaces | Override file for the re-opening greeting template. |
| `manager.observer.interlocutorInstructionFile` | — | replaces | Observer: extra instructions for handling the interlocutor. |
| `manager.observer.ownerInstructionFile` | — | replaces | Observer: extra instructions about the owner. |
| `manager.takeover.instructionFile` | — | replaces | Takeover: extra instructions. |

### Wake-words

`manager.mentionWords` is a list of trigger words/phrases. A message that contains one **skips the owner-reply window** and makes that chat ready right away — the model still decides whether the message is actually a question worth answering.

- **Override.** Setting `mentionWords` **replaces** the default list (`["llm", "manager"]`) — it does not add to it. So include the defaults if you still want them. `[]` disables wake-words.
- **Labeler is added automatically.** On top of your list, the bot's own label (`manager.labeler`, normalized) is added as a phrase, so a message that addresses the bot by the name it signs replies with also wakes it. This is automatic and additive — your `mentionWords` stays authoritative, and the labeler is never written into your file. (An empty or emoji-only labeler adds nothing.)
- **Matching.** Case-insensitive and **whole-word** (Unicode-aware): `"llm"` matches "Hey LLM!" but not "llms". Surrounding punctuation is ignored (`"llm!?"`, `"(qwen)"` match). A multi-word entry is matched as whole words **in order** with any punctuation between them — `"mini bro"` matches "Mini, bro!" but not "minibro" or "bro mini". Misspellings are not matched; the model can still infer intent from the message itself.
- **Priority in mixed.** In mixed mode, a wake-word does **not** interrupt your terminal work — it only marks the chat ready and is served after the return timer (`mixed.returnToTelegramMs`) hands the brain back to Telegram. In the standalone manager it takes effect on the next tick.

## `files`

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `files.maxBytes` | `52428800` (50 MiB) | replaces | Size cap for describing/downloading inbound attachments. |
| `files.downloadDir` | Pi's working dir | replaces | Where files sent to the bot (Personal mode) are saved. Absolute or `~`-relative. |

---

## Timing at a glance (defaults)

Tuned for a **local model** answering over minutes, not milliseconds. Slower hardware → consider raising the windows.

| Window | Default | Meaning |
| --- | --- | --- |
| Owner-reply | 5 min | you get first crack at a new message |
| Continuation | 1 min 30 s | how long a chat stays "live" after a reply |
| Live freshness | 2 min | older messages are backlog, not a live trigger |
| Consolidation quiet | 30 min | idle wait before updating memory about a chat |
| Mixed return | 8 min | idle after a terminal turn before the brain returns to Telegram |
| Re-greet after | 24 h | silence before a resuming chat is welcomed back |
| Catch-up window | 10 h | oldest waiting message still worth answering on start |
| Connection check | 10 min | silent liveness probe interval |
