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
| `assistant.draftPreviews` | `true` | replaces | Stream the reply as an animated draft while it generates, and — before the first word of it exists — show what the agent is doing right now (`Thinking…`, then the tool it is running). The draft is ephemeral: it animates in place and leaves nothing in the chat history. Mixed mode shows it on coding turns only; a manager turn never does (a draft cannot be sent over a business connection). |
| `assistant.toolActivity` | `true` | replaces | Mirror each agent tool call to the chat as a collapsible block — turns the bot DM into a live log of the model's work in Personal mode. The card completes itself when the call returns: ✅ or ❌ (⏹️ if `/esc` caught it mid-flight), with the output folded in. |
| `assistant.toolOutputMaxBytes` | `26214400` (25 MiB) | replaces | Size cap **in bytes** for attaching the full output of a tool call. `0` never attaches. See below. |
| `assistant.toolOutputDir` | *(extension dir)* | replaces | Where those files are written before being sent. POSIX and Windows paths both accepted. |
| `connect.instructionFiles` | `[]` | **appended** | Extra instruction files for Personal mode only. |

### The full output of a tool call

A card can only show so much: past `assistant`'s result limit it stops at `… (59 earlier lines)`. The rest has to be reachable, or the card is only teasing — so the extension attaches the full output as a file. It comes from one of two places, and you never have to care which:

- the **tool** truncated its own output for the model and saved the whole thing to a file → that file is sent;
- the tool returned everything and **the card** is what cut it (a `find … | head -100`, say) → the extension writes the full output out itself and sends that.

Two rules, and both are yours:

- **only when something was actually truncated.** If the card shows the whole result, a file would just be a duplicate.
- **only up to `toolOutputMaxBytes`.** Over the cap, nothing is attached. Cap it low if you read Telegram on metered mobile data (`1048576` = 1 MiB), or set `0` to never attach anything.

This is not `files.maxBytes` — that governs files **you** send the bot. This one governs logs the bot sends **you**, unasked, which is why it has a cap of its own. The extension decides it mechanically: the agent is never asked, so it cannot decide to bury you in logs.

**Where the files go.** By default into the extension's own directory (`<agent>/extensions/pi-telegram-manager/tool-output`) — never the system temp dir — and each one is deleted the moment it has been sent. Point `toolOutputDir` anywhere you like; both path flavours are accepted, since the same `settings.json` may travel between machines:

```jsonc
"assistant": {
  "toolOutputMaxBytes": 1048576,   // 1 MiB — mobile data
  "toolOutputDir": "~/logs/pi"     // or "/var/log/pi", "C:\\logs", "D:/logs", "\\\\server\\share"
}
```

A leading `~` expands to your home directory on either platform (`~\logs` works too). Beyond that the path is used exactly as written: a Windows path on Linux fails as a missing directory — an honest error — instead of being quietly rewritten into some other one.

## `mixed` (mixed mode)

Mixed runs the manager alongside your terminal session in one Pi session, with the terminal always the priority.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `mixed.returnToTelegramMs` | `480000` (8 min) | replaces | After your terminal inference **finishes** (or an abort settles), how long the brain stays idle before it returns to Telegram moderation. The countdown starts when the turn **ends**, not while it runs; any new terminal prompt cancels it. |

**Two keyboards, one session.** Mixed runs the Personal bridge as well, bound to the **personal** topic of your bot DM: a message there is treated exactly like a prompt typed at the terminal (it takes the brain back for coding, aborting a moderation turn in flight), and terminal prompts are mirrored into it. Manager turns are never delivered there — they answer the interlocutor and report into the **manager** topic.

**Priority & algorithm.** While you are at the terminal (the `coding` polarity) the manager may not run a turn: incoming Telegram messages are stored and deferred, and **even a wake-word does not preempt you** — it only marks the chat ready. Nothing from Telegram enters your terminal context or costs you tokens. When your inference has been idle for `mixed.returnToTelegramMs`, the brain flips to the `telegram` polarity and moderates the ready chats. The instant you type again it flips back, aborts any in-flight moderation, and restores your full tools. In the `telegram` polarity the model runs in the sandbox (messaging tools only — no `read`/`write`/`bash`); your full tools exist only while you hold the terminal. The log of what it did while you were away lands in the **manager** topic of your bot DM (`manager.log`, on by default).

## `connectionCheck` (connection watchdog, all modes)

A silent timer probes the bot connection while a mode is active; after too many consecutive failures the mode auto-disconnects. Probes never post to chat or the debug feed — only the final auto-disconnect is surfaced.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `connectionCheck.enabled` | `true` | replaces | Run the watchdog while a mode is active. |
| `connectionCheck.intervalMs` | `600000` (10 min) | replaces | Probe interval. `0` also disables it. |
| `connectionCheck.maxRetries` | `3` | replaces | Consecutive failed probes tolerated before auto-disconnect. |


## `topics` (owner DM layout)

Bot API 9.3 lets a bot create forum topics **inside a private chat**, so your DM with the bot is split by *whose* conversation it is: **personal** — you and the model (your prompts, its replies, and the tool calls it made for you, so you can watch it work) — and **manager** — what the bot did for other people (the per-turn feed and runtime notices).

It needs **Threaded Mode** on the bot, toggled in the **@BotFather Mini App** (tap BotFather's menu button → your bot → Threaded Mode). It is *not* in the classic `/mybots` → Bot Settings keyboard. This is a setup step, not a nicety — with it off, the bot warns you in the DM on every mode start (set `topics.enabled: false` if you genuinely want one flat stream). Without it (or on any error) everything degrades to the single plain DM exactly as before — nothing to configure, nothing breaks.

The two thread ids are remembered on disk (`topics.json`); a topic you delete while the bot is off is simply recreated on the next start, and a pair created under the old `chat`/`log` names is adopted and renamed in place.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `topics.enabled` | `true` | replaces | Use topics when the bot supports them. `false` keeps one flat DM. |
| `topics.personalName` | `"personal"` | replaces | Name of your own conversation topic. Renamed from `topics.chatName`, still read when unset. |
| `topics.managerName` | `"manager"` | replaces | Name of the secretary-side topic. Renamed from `topics.logName`, still read when unset. |

## `manager` (business manager, and the Telegram side of mixed)

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `manager.ownerName` | — | replaces | Your display name, so the bot can introduce itself as "{name}'s assistant" on first contact. |
| `manager.ownerReplyWindowMs` | `300000` (5 min) | replaces | How long a first message from someone is held so **you** can answer before the bot may. |
| `manager.continueWindowMs` | `120000` (2 min) | replaces | After the bot replies, how long that chat keeps the fast lane: a message inside the window is served at once, skipping the owner window and the queue. When it expires the chat is released and the next one is promoted. Writing in the chat yourself closes the lane immediately. |
| `manager.liveFreshnessMs` | `600000` (10 min) | replaces | **How late a message may arrive and still count as live.** Telegram redelivers what the bot missed (reconnect, network blip, restart), and age is measured by the message's *true send time*. Older than this → backlog: kept for context and memory, but it starts no reply cycle, so a conversation that ended yesterday cannot wake the bot on reconnect. Keep it **above** `ownerReplyWindowMs`: a message younger than the owner window has not even had its turn yet. Too low is the dangerous side — a live message delayed in transit would be filed as history and answered by nobody. |
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
| `manager.labeler` | `"LLM agent 🤖:"` | replaces | The banner prefixed to each outgoing business reply, rendered as a blockquote so it stands apart from a message you typed. `""` removes the banner entirely (and the rule line with it) — the bot still tells people what it is when it introduces itself and whenever it is asked (see [Telling people it is a bot](#telling-people-it-is-a-bot)). A label with nothing visible in it (zero-width characters only) counts as `""`. |
| `manager.labelerRule` | `"────────────"` | replaces | A second line under the labeler, inside the same blockquote — a horizontal rule that makes the banner taller and easier to spot. You control its look and length by the string itself; `""` removes just the rule line (the labeler stays). Ignored when `labeler` is `""`. |
| `manager.log` | `true` | replaces | Mirror every turn (thinking, tool calls, decision) to your bot DM — the moderation log for manager and mixed. With `topics` on it goes to its own **manager** topic, so it never buries the conversation; without topics it shares the single DM and is chatty (turn it off there). Renamed from `manager.debugFeed`, which is still read when this key is unset. |
| `manager.media.images` | `true` | replaces | Let the model see interlocutor images (vision). |
| `manager.media.documents` | `false` | replaces | Accept non-image documents (otherwise refused). |
| `manager.allowedTools` | `[]` | **adds to base** | Regex names of extra tools the model may call, on top of the built-in messaging tools. Empty = telegram-sandbox (messaging tools only, no computer access). |
| `manager.instructionFiles` | `[]` | **appended** | Extra instruction files for the manager. |
| `manager.firstMessageTemplate` | — | replaces | Override file for the first-contact greeting template. Controls the tone and shape of the greeting, not whether the bot says it is a bot — see below. |
| `manager.reopenTemplate` | — | replaces | Override file for the re-opening greeting template. |

### Telling people it is a bot

The manager answers strangers on your behalf, so one rule is bundled with the
extension and **no setting reaches it**: when it opens a conversation with someone
new it says it is an AI assistant answering for you, and when anyone asks whether
they are talking to a bot it answers truthfully. That instruction is appended
**last**, after your own `instructionFiles`, so your text cannot quietly outweigh
it.

Everything around it is still yours: the tone and wording of the greeting
(`manager.firstMessageTemplate`), the name it signs with (`manager.labeler`),
whether messages carry a banner at all (`labeler: ""`), the subjects it will and
will not go into (`manager.instructionFiles`).

### Wake-words

`manager.mentionWords` is a list of trigger words/phrases. A message that contains one **skips the owner-reply window** and makes that chat ready right away — the model still decides whether the message is actually a question worth answering.

- **Override.** Setting `mentionWords` **replaces** the default list (`["llm", "manager"]`) — it does not add to it. So include the defaults if you still want them. `[]` disables wake-words.
- **Labeler is added automatically.** On top of your list, the bot's own label (`manager.labeler`, normalized) is added as a phrase, so a message that addresses the bot by the name it signs replies with also wakes it. This is automatic and additive — your `mentionWords` stays authoritative, and the labeler is never written into your file. (An empty or emoji-only labeler adds nothing.)
- **Matching.** Case-insensitive and **whole-word** (Unicode-aware): `"llm"` matches "Hey LLM!" but not "llms". Surrounding punctuation is ignored (`"llm!?"`, `"(qwen)"` match). A multi-word entry is matched as whole words **in order** with any punctuation between them — `"mini bro"` matches "Mini, bro!" but not "minibro" or "bro mini". Misspellings are not matched; the model can still infer intent from the message itself.
- **Priority in mixed.** In mixed mode, a wake-word does **not** interrupt your terminal work — it only marks the chat ready and is served after the return timer (`mixed.returnToTelegramMs`) hands the brain back to Telegram. In the standalone manager it takes effect on the next tick.

## `forwards` (forwarded messages, all modes)

A forward is not a message someone wrote to you — it is content pasted in from elsewhere, and Telegram sends a batch of them as **one message each**. Ten forwarded posts of any length can fill a small local context on their own, which is also the cheapest way for a stranger to fill it deliberately. So forwards get their own budget, separate from the ordinary message policy, and a batch reaches the model as **one turn** rather than as N turns it answers one by one. Replies and quotes inside the current chat are not affected.

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `forwards.maxChars` | `2000` | replaces | Longest body kept from **one** forwarded message; the rest is cut with a `…[+N chars not read]` marker. `0` = no cap. |
| `forwards.maxMessages` | `5` | replaces | How many forwards of a single batch are read at all. Past it the bodies are **not read**: one `[forward limit: …]` note says so and the rest of the batch is dropped (no media is downloaded for them either). A forwarded **album** counts as **one** forward, not one per photo. `0` = no cap. |
| `forwards.groupWindowMs` | `3000` | replaces | The quiet gap that ends a batch. Forwards arriving back-to-back within it are one batch; a message the sender typed themselves also ends it. |

## `files`

| Key | Default | Override | What it does |
| --- | --- | --- | --- |
| `files.maxBytes` | `52428800` (50 MiB) | replaces | Size cap for describing/downloading inbound attachments. |
| `files.maxImagesPerTurn` | `10` | replaces | How many images one turn may carry to the model. Telegram delivers an album as separate messages (one photo each, up to 10) and this extension folds them into a single turn; Pi imposes no limit of its own, so this cap exists only to protect a small local context — each picture costs real tokens. `0` = no cap. |
| `files.downloadDir` | Pi's working dir | replaces | Where files sent to the bot (Personal mode) are saved. Absolute or `~`-relative. |

---

## Timing at a glance (defaults)

Tuned for a **local model** answering over minutes, not milliseconds. Slower hardware → consider raising the windows.

| Window | Default | Meaning |
| --- | --- | --- |
| Owner-reply | 5 min | you get first crack at a new message |
| Continuation | 2 min | how long a chat stays "live" after a reply |
| Live freshness | 10 min | how late a message may arrive and still wake the bot (reconnect/backlog guard) |
| Consolidation quiet | 30 min | idle wait before updating memory about a chat |
| Mixed return | 8 min | idle after a terminal turn before the brain returns to Telegram |
| Re-greet after | 24 h | silence before a resuming chat is welcomed back |
| Catch-up window | 10 h | oldest waiting message still worth answering on start |
| Connection check | 10 min | silent liveness probe interval |

**They are not independent — two relations matter if you retune them.**

- **Live freshness > owner-reply.** Freshness decides whether a message may wake the bot at all; the owner window then holds it so you can answer first. Set freshness *below* the owner window and you declare messages too old to wake the bot before they have even had their turn — a message delayed in transit is then filed as history and answered by nobody. Keep a wide margin (10 min vs 5 min).
- **Continuation is a priority, not a deadline.** It only says how long a chat keeps the fast lane after a reply. Miss it and nothing is lost: the next message re-enters the normal path — the owner window, then the queue — so the person is still answered, just not instantly. Raise it if your contacts take their time replying; lower it if one chatty conversation keeps the model from the others (the queue promotes never-answered chats first regardless).
