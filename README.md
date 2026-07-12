> ⚠️ Experimental. pi-telegram-manager is built **for local models** and, at runtime, is driven by one — a small local model (tested with Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf) running through Pi. Cloud LLMs (such as Claude) take part in its development. It is maintained with AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-telegram-manager

An experimental [Pi](https://github.com/earendil-works/pi) extension that puts a Pi agent on Telegram. It runs in one of a few **modes**, and the bot behaves very differently in each: in one it is *your* private assistant in your own chat with the bot; in another it quietly answers *other people* in your Telegram **business** chats on your behalf. The centrepiece is that **business manager** mode.

It was built **first for local models with a small context window** (the experiment ran a single local model at **131k** context through Pi). Almost every design choice here — one decision per turn ending in a tool call, strict per-chat context isolation, a last-N memory window, idle memory consolidation split into resumable fragments — exists to keep a small model coherent across many conversations without a huge context. It works with cloud models too, but that is not what it was tuned for.

This is a personal experiment. Expect rough edges, bugs, and behavior that changes.

---

## Modes

The **same bot account** runs one mode at a time. What the bot *is* depends entirely on the mode.

### 🤖 Personal — mode 1 (`/telegram-connect`)

Bridges your **current Pi terminal session** to your **private chat with the bot**. You talk to your own coding agent from your phone: send text, files, and images; get its replies (native rich Markdown), a live "typing…" indicator and streamed drafts; queue messages while it works; `/clear` the history or `/esc` a running turn. The bot only ever talks to **you** (`allowedUserId`); it does not touch any business chats.

### 🕵️ Business manager — mode 2 (the centrepiece)

Through a Telegram **Business** connection, the bot reads your business conversations with **many different people** and decides, message by message, whether to reply **on your behalf**. One agent instance multiplexes every chat, with:

- **strict per-chat context isolation** — each turn the model sees only that one conversation, rebuilt from disk;
- a **priority queue / scheduler** — one chat active at a time, never-replied chats first, a continuation window that keeps a live conversation going;
- an **owner-reply window** — a first message from someone is held for a few minutes so *you* can answer first; only if you stay silent does the bot step in;
- **persistent per-contact memory** — durable facts about each person, saved and resurfaced across sessions, updated by an **idle consolidation** pass that pauses for live replies and resumes where it left off;
- **catch-up on activation** — when you switch it on, it looks at chats left waiting and answers the ones still worth answering;
- an optional **debug feed** — since the bot account is idle here, it can DM *you* each turn's thinking, tool calls, and decision.

Two sub-modes decide how forward it is:

| Sub-mode | Command | Behavior |
| --- | --- | --- |
| 👁️ **Observer** | `/telegram-manager-observer` | Co-pilot. Only steps in when you stay silent past the owner-reply window — you always get first crack. |
| 🎛️ **Takeover** | `/telegram-manager-takeover` | The bot fully runs the business chats and replies on its own. |

### ⏹️ Switching modes from the chat (`/switch`)

Send **`/switch`** in your private chat with the bot (or tap it in the command menu) to flip between **Observer / Takeover / Personal / Stop** from an inline keyboard — no terminal needed. It is a **priority** action: it aborts whatever the bot is doing (even a long memory consolidation) and switches immediately. A **pinned message** at the top of that chat always shows the currently active mode, updated in place on every switch.

---

## Install

```bash
pi install git:github.com/m62624/pi-telegram-manager
```

Create the settings file at `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json` (typically `~/.pi/agent/extensions/pi-telegram-manager/settings.json`) with at least a bot token and your Telegram user id:

```json
{
  "botToken": "123456:ABC-your-bot-token",
  "allowedUserId": 419332999,
  "manager": { "ownerName": "Alex" }
}
```

`botToken` may instead be `"env:TELEGRAM_BOT_TOKEN"` to read it from the environment. For **mode 2**, connect your bot to your account under Telegram **Settings → Business → Chatbots**. Then open Pi and run one of the commands below.

The extension loads `./src/index.ts` directly — no build step is needed to run it, only a Pi session restart after changes.

---

## Commands

**In the Pi terminal:**

| Command | Purpose |
| --- | --- |
| `/telegram-connect` | Start **Personal** mode (bind this session to your DM) |
| `/telegram-disconnect` | Stop Personal mode |
| `/telegram-manager-observer` | Start the **business manager** in Observer sub-mode |
| `/telegram-manager-takeover` | Start the **business manager** in Takeover sub-mode |
| `/telegram-manager-stop` | Stop the business manager |
| `/telegram-switch` | Open the mode-switcher panel in your bot DM |
| `/telegram-status` | Show the active mode |

**In your chat with the bot** (owner only): `/switch` (mode picker), and in Personal mode `/clear`, `/esc`, `/help`.

---

## Settings

All settings live in one JSON file: `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json`. Every key is optional and layered over the defaults below. Unknown keys are ignored with a warning; a present-but-wrong-typed value fails loudly with the offending path.

**Override semantics.** For plain values (numbers, booleans, strings) a setting **replaces** the default. Two list settings are special: instruction-file lists are **appended** to the built-in instructions (they add to them, never replace them), and `manager.mentionWords` / `manager.allowedTools` **replace** the default list / **add** to the built-in tools as noted per row.

### Top level

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `botToken` | — | replaces | Telegram bot token, or `"env:VAR"` to read it from the environment. Required. |
| `allowedUserId` | — | replaces | Your Telegram numeric user id — the **only** user the bot obeys and the DM it uses for Personal mode, `/switch`, and the debug feed. Required for mode 1 and for `/switch`. |
| `timezone` | system zone | replaces | IANA timezone (e.g. `"Asia/Almaty"`) for the `[Now: …]` line shown to the model. |
| `instructionFiles` | `[]` | **appended** | Markdown files added to the system instructions in **both** modes. |

### `assistant` (Personal mode)

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `assistant.rendering` | `"rich"` | replaces | `"rich"` (native Bot API rich Markdown) or `"html"`. |
| `assistant.draftPreviews` | `true` | replaces | Stream the reply as an animated draft while it generates. |
| `assistant.toolActivity` | `true` | replaces | Mirror each agent tool call to the chat as a collapsible block. |
| `connect.instructionFiles` | `[]` | **appended** | Extra instruction files for Personal mode only. |

### `connectionCheck` (connection watchdog, both modes)

A silent timer probes the bot connection while a mode is active; after too many consecutive failures the mode auto-disconnects. Probes never post to chat or the debug feed — only the final auto-disconnect is surfaced.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `connectionCheck.enabled` | `true` | replaces | Run the watchdog while a mode is active. |
| `connectionCheck.intervalMs` | `600000` (10 min) | replaces | Probe interval. `0` also disables it. |
| `connectionCheck.maxRetries` | `3` | replaces | Consecutive failed probes tolerated before auto-disconnect. |

### `manager` (business manager, mode 2)

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `manager.ownerName` | — | replaces | Your display name, so the bot can introduce itself as "{name}'s assistant" on first contact. |
| `manager.ownerReplyWindowMs` | `300000` (5 min) | replaces | How long a first message from someone is held so **you** can answer before the bot may. |
| `manager.continueWindowMs` | `90000` (1:30) | replaces | After the bot replies, how long the chat stays "live" (a new message keeps it active instead of re-queuing). Also governs when things are quiet enough to resume memory consolidation. |
| `manager.liveFreshnessMs` | `120000` (2 min) | replaces | A message older than this (by its true send time) is recorded for context but does **not** wake a live reply cycle — so a redelivered old backlog never "wakes" the bot. |
| `manager.catchUpWindowMs` | `36000000` (10 h) | replaces | On activation, the bot may answer for you in a waiting chat only if its last message is newer than this. |
| `manager.reopenAfterMs` | `86400000` (24 h) | replaces | A chat resuming after this much silence is re-greeted. `0` disables re-greeting. |
| `manager.rememberMessages` | `20` | replaces | Last-N messages per chat the model reads each turn. Also bounds the transcript kept on disk (old messages are pruned to ~2× this). |
| `manager.factsLimit` | `20` | replaces | Last-N durable facts kept and injected per contact. |
| `manager.factConsolidationQuietMs` | `1800000` (30 min) | replaces | Quiet period after a chat's last activity before an idle memory-consolidation pass may run on it. |
| `manager.verifyLimit` | `8` | replaces | Max candidate facts individually verified in one consolidation pass. |
| `manager.reviseThreshold` | `2` | replaces | How many times a drafted reply may be reconsidered when new messages keep arriving mid-turn before it is sent as-is. `0` sends immediately. |
| `manager.strictReplyGuard` | `true` | replaces | Drop a reply the model itself tagged as chatter/acknowledgement (or "no reply needed") unless it was directly addressed. Curbs a weak model over-replying to banter. |
| `manager.mentionWords` | `["llm", "manager"]` | **replaces list** | Wake-words (case-insensitive). A message containing one skips the owner-reply window; the model still decides whether it is really addressed. `[]` disables. |
| `manager.labeler` | `"LLM agent 🤖:"` | replaces | Prefix rendered before each outgoing business reply (`""` = none). |
| `manager.debugFeed` | `false` | replaces | Mirror every turn (thinking, tool calls, decision) to your bot DM. Chatty in Observer — opt-in. |
| `manager.media.images` | `true` | replaces | Let the model see interlocutor images (vision). |
| `manager.media.documents` | `false` | replaces | Accept non-image documents (otherwise refused). |
| `manager.allowedTools` | `[]` | **adds to base** | Regex names of extra tools the model may call, on top of the built-in messaging tools. Empty = telegram-sandbox (messaging tools only, no computer access). |
| `manager.instructionFiles` | `[]` | **appended** | Extra instruction files for the manager. |
| `manager.firstMessageTemplate` | — | replaces | Override file for the first-contact greeting template. |
| `manager.reopenTemplate` | — | replaces | Override file for the re-opening greeting template. |
| `manager.observer.interlocutorInstructionFile` | — | replaces | Observer: extra instructions for handling the interlocutor. |
| `manager.observer.ownerInstructionFile` | — | replaces | Observer: extra instructions about the owner. |
| `manager.takeover.instructionFile` | — | replaces | Takeover: extra instructions. |

### `files`

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `files.maxBytes` | `52428800` (50 MiB) | replaces | Size cap for describing/downloading inbound attachments. |
| `files.downloadDir` | Pi's working dir | replaces | Where files sent to the bot (Personal mode) are saved. Absolute or `~`-relative. |

> **Reserved keys** — `manager.responseMode`, `manager.markRead`, `manager.throttleMs`, and `manager.subMode` are parsed for forward-compatibility but are **not wired to behavior yet**. Setting them does nothing today (the active sub-mode comes from the command you run).

---

## Timing at a glance (defaults)

Tuned for a **local model** answering over minutes, not milliseconds. Slower hardware → consider raising the windows.

| Window | Default | Meaning |
| --- | --- | --- |
| Owner-reply | 5 min | you get first crack at a new message |
| Continuation | 1 min 30 s | how long a chat stays "live" after a reply |
| Live freshness | 2 min | older messages are backlog, not a live trigger |
| Consolidation quiet | 30 min | idle wait before updating memory about a chat |
| Re-greet after | 24 h | silence before a resuming chat is welcomed back |
| Catch-up window | 10 h | oldest waiting message still worth answering on start |
| Connection check | 10 min | silent liveness probe interval |

---

## Development

```bash
git clone https://github.com/m62624/pi-telegram-manager.git
cd pi-telegram-manager
npm install
npm test          # vitest (all tests + mocks live in tests/)
npm run check     # biome
npm run build     # tsc (typecheck)
npm run ci        # check + build + test + pack --dry-run
pi -e ./src/index.ts
```

---

## License

[MIT](https://github.com/m62624/pi-telegram-manager/blob/main/LICENSE)
