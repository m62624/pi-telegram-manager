> ⚠️ Experimental. pi-telegram-manager is built **for local models** and, at runtime, is driven by one — a small local model (tested with [Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)) running through Pi. Cloud LLMs (such as Claude) take part in its development. It is maintained with AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-telegram-manager

<p align="center">
  <img src="assets/icon.webp" alt="pi-telegram-manager icon" width="120">
</p>

An experimental [Pi](https://github.com/earendil-works/pi) extension that puts a Pi agent on Telegram — as your own assistant on your phone, and as a secretary that answers other people on your behalf. The model runs **on your machine, in your own Telegram account**.

> ⚖️ **Terms & responsibility — read before using.** The bot is **yours**, not this project's: you create it in @BotFather and connect it to Telegram, and Telegram's [Bot Developer Terms](https://telegram.org/tos/bot-developers) then bind **you** — *"'you' refers to you, the developer"*, and the Telegram account holding the bot's credentials answers for what it does. So they apply to running your own bot, not to reading this repository. Also: the [Privacy Policy](https://telegram.org/privacy) and the [Secretary / Business section](https://telegram.org/tos/bot-developers#5-4-telegram-business).
>
> In manager and mixed modes the bot reads chats with **other people** and answers **on your behalf** — they are talking to a machine without necessarily knowing it (it labels its messages by default; see `manager.labeler`). **You alone are responsible** for how you use it and for the data it processes. The bot repeats these links on `/start` and `/help`.

The question behind it: **can a small local model be genuinely useful in everyday life if its context is managed carefully?** So the design starts from the local model, not a cloud one. Where other extensions assume a large cloud context and pour everything into it, this one **respects a small context window** — it was tuned for a local model at **131k** context. Almost every choice — one decision per turn ending in a tool call, strict per-chat context isolation, a last-N memory window, idle memory consolidation split into resumable fragments — exists to keep a small model coherent across many conversations without a huge prompt.

### What this deliberately is not

**One local model, one session. No sub-agents, no agent swarm, no orchestration layer** — a decision, not a gap waiting to be filled. Those tricks assume you can spend context and calls freely; a small local model cannot. So one model handles every chat, seeing exactly one conversation at a time.

Need the cloud shape — parallel agents, a big context, a delegation layer? **Fork it.** MIT, ports injected, and the pieces you would replace (context building, the scheduler, the memory passes) are the ones deliberately kept small. It runs on cloud models as-is; it is simply not tuned for them, and will not grow features that only make sense there.

---

## Install

Released versions, published to npm:

```bash
pi install npm:pi-telegram-manager
```

Developer version — the latest `main`, including changes not yet released to npm:

```bash
pi install git:github.com/m62624/pi-telegram-manager
```

Both channels can have bugs; the difference is only what they track — npm follows tagged releases, GitHub follows `main`. Then set it up: **[Getting started](#getting-started)**.

---

## Modes

One bot account, one mode at a time. Each mode is a different job for the same model.

### 🤖 Personal — your terminal session, on your phone

Binds your **current Pi terminal session** to your **private chat with the bot**. It is the same session, not a copy: what you type in Telegram arrives in the terminal, what you type in the terminal is mirrored to Telegram, and the model's answer appears in both.

- Send text, files and images; the bot saves non-image files to disk and hands the model real paths ([`files.downloadDir`](SETTINGS.md#files)), so it can open them with its normal tools.
- You see the model **work**, not just its conclusion: each message it writes is delivered as it finishes, and each tool call is mirrored as a collapsible block ([`assistant.toolActivity`](SETTINGS.md#assistant-personal-mode)).
- Replies arrive as native rich Markdown with a live "typing…" indicator and a streamed draft preview ([`assistant.draftPreviews`](SETTINGS.md#assistant-personal-mode)).
- Messages you send while it is busy are **queued**, not dropped; editing a queued message rewrites it in place.
- **Forwards** you paste in arrive as one turn, not one per message, and are capped by their own budget ([`forwards`](SETTINGS.md#forwards-forwarded-messages-all-modes)) — a wall of forwarded posts cannot eat the model's context, in your DM or in a chat the manager answers.
- The bot talks only to **you** (`allowedUserId`) and touches no other chats.

Start it with `/telegram-personal`. In the chat: `/clear` (wipe history), `/esc` (cancel the running turn), `/help`.

### 🕵️ Secretary manager — answer other people on your behalf

Through a Telegram **Secretary** connection (formerly called **Business**), the bot reads your conversations with **many different people** and decides, message by message, whether to reply **on your behalf**. One agent multiplexes every chat. In one sentence:

> 🎛️ **It answers for you when you don't — and gets out of the way the moment you do.**

The rules are few, and the important ones are enforced in **code**, not by asking the model nicely:

- **It never replies immediately.** An incoming message is held for the owner-reply window ([`manager.ownerReplyWindowMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **5 min**): **you** get first crack, always. Answer inside it and the bot drops that batch and never repeats you. Only if the window runs out in your silence is the chat handed to the model. Want it to answer for you more eagerly? Shorten that window. Want it to hardly ever beat you to it? Lengthen it.
- **It never answers *you*.** Your messages are context, never a task: no message of yours can open a turn at all. So writing "did you buy the bread?" to someone cannot make the bot answer "yes" — there is nothing unanswered for it to wake up for.
- **Writing in a chat does not switch the bot off in it.** You simply took that batch. If the person writes again and you let it hang, the window runs out and the bot answers — it keeps watching for whatever nobody answered.
- **Call it and it comes.** A wake-word ([`manager.mentionWords`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed)) or its own name skips the window entirely — from the interlocutor, and from **you**: "hey qwen, what did I forward to them?" is answered in that chat. It is the one case where a message of yours reaches the model.
- **It stays quiet when nothing is being asked.** "ok", "nice", a sticker, small talk between other people — that judgement is the model's, and [`manager.strictReplyGuard`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) drops an over-eager reply it itself tagged as chatter.
- **If you answer while it is writing, its reply is not sent blind.** The draft is held and reconsidered against what you just said: it sends, refines, or drops it — it never talks over you.

Start it with `/telegram-manager`. Mixed runs the same manager.

### 🔀 Mixed — Personal **and** manager, in one session

Mixed is not a third behaviour. It is the two modes above **running at once on one brain**: Personal (you and the model) plus the secretary manager (the model and everyone else). The whole design is about **who gets the model right now**, and the answer is always: **you do**.

**While you are working, you are the priority.** You can work from the **terminal** or from the **personal** topic of your bot DM — they are the same session and rank exactly the same, so answering from your phone is not "the Telegram side", it is you. While you hold the brain:

- other people's messages are **stored and deferred**, and nothing from them enters your context or costs you tokens;
- even a wake-word does **not** pull the model off your work — it only marks that chat as ready to be answered later;
- you keep your **full tools** (`read`/`write`/`bash`), because the sandbox only applies while the model is moderating.

**When you stop, it goes back to Telegram.** The clock starts *after the model's inference finishes* — not while it is thinking. If nothing new comes from **you** and nothing more comes from **the model** for [`mixed.returnToTelegramMs`](SETTINGS.md#mixed-mixed-mode) (default **8 minutes**), the brain switches to Telegram and answers whoever needs an answer. Any message from you cancels the countdown.

**When you come back, you take the brain immediately.** A prompt from you — terminal or personal topic — aborts a moderation turn in flight, so you never wait on it. Nothing is lost: an unanswered chat is picked up again next time, and an interrupted memory pass resumes where it stopped.

Moderation never leaks into your side: what the bot writes to other people goes to them, and the account of what it did lands in the **manager** topic. Your TUI stays clean — one footer line (`mixed · coding`) tells you who holds the brain right now.

Start it with `/telegram-mixed`.

### ⏹️ Switching modes

In the terminal, the mode commands **are** the switcher: `/telegram-personal`, `/telegram-manager`, `/telegram-mixed`, `/telegram-stop` — starting one stops whatever else was running. Away from the terminal, send **`/switch`** in your DM with the bot and pick **Manager / Mixed / Personal** from an inline keyboard. Stopping is deliberately not a button there — it is the explicit `/stop` command, so a stray tap cannot kill a long-lived Secretary connection.

The inline keyboard has **no Stop button** — a Secretary connection is a long-lived thing, and a mistap while picking a mode should not end it. Stopping the bot from Telegram is its own command: **`/stop`**.

Every mode command is itself a switch: starting one while another runs stops that one first — you never have to stop by hand. Switching is a **priority** action: it aborts whatever the bot is doing (even a long memory consolidation) and takes effect at once. A **pinned message** in the `personal` topic always shows the active mode.

---

## How the manager actually works

This is the part worth understanding before you let a model answer people for you. Every number below is a setting — the links go to [SETTINGS.md](SETTINGS.md).

### One chat at a time, in a deliberate order

Messages from many people arrive at once; the model handles **one chat per turn**, so it is never confused about who it is talking to. The scheduler picks the next chat by:

1. **never-replied chats first** — someone who has not heard back yet outranks an ongoing conversation;
2. then a **continuation window** ([`manager.continueWindowMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **1:30**) — right after replying, that chat keeps priority, so a live back-and-forth is not interrupted by an older one.

### The owner-reply window — your first chance

A message is **held** for [`manager.ownerReplyWindowMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) (default **5 min**) before the bot may touch it. If **you** answer in that time, the bot drops that batch silently and never repeats you.

Answering does not switch the bot off in that chat — it only means you took that batch. The next message from that person arms a fresh window, and if you let it hang, the bot answers it. So the bot is never "frozen out" of a conversation you are half-following; it just never gets ahead of you.

Two things skip the wait: a **wake-word** (see below), and a chat that is already the active one — a follow-up in a live back-and-forth continues immediately rather than waiting five minutes again. That fast lane closes the moment **you** write in the chat: you are there, so the bot goes back to letting you answer first.

### Wake-words — how the bot knows it is being addressed

[`manager.mentionWords`](SETTINGS.md#wake-words) (default `["llm", "manager"]`, plus your bot's own label automatically). A message containing one jumps straight past the owner-reply window — but it does **not** force a reply: the model still decides whether the word was a real address to it ("hey llm, what do you think?") or just a word used in passing ("the LLM at work is slow"). In mixed mode, a wake-word never preempts your coding.

### What it sees, and what it remembers

- **Strict per-chat isolation.** Each turn the model's context is rebuilt from disk for that one conversation. It never sees another chat.
- **A last-N window** ([`manager.rememberMessages`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **20**), bounded again by characters ([`manager.maxContextChars`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) / [`manager.maxCharsPerMessage`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed)) so one long paste cannot overflow a small local context.
- **Durable facts per contact** ([`manager.factsLimit`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **20**), keyed by the person's Telegram account (not their name — so two Alexes never merge). They are resurfaced the next time that person writes.
- **Memory consolidation.** When a chat has been quiet for [`manager.factConsolidationQuietMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) (default **30 min**), the model re-reads it and interrogates itself about what is worth keeping: *who is this person → which facts did they state → is each one actually true and durable* (up to [`manager.verifyLimit`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) facts). It runs only while idle, and a live message **interrupts it immediately** — the pass resumes later from where it stopped.

### Guards against a small model doing something silly

- **Every turn ends in a tool call**, never in prose. Prose is never delivered to Telegram — if the model writes an answer as plain text, it is **held as a draft** and handed back with one instruction: send it, refine it, or drop it. That way a composed answer is never lost, and never sent by accident.
- **The same happens when new messages land mid-reply**: the draft is held and reconsidered against them, up to [`manager.reviseThreshold`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) times (default **2**), then sent as-is.
- **The chatter guard** ([`manager.strictReplyGuard`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **on**): a reply the model itself tagged as chatter/acknowledgement — or as not needing an answer — is dropped unless the interlocutor addressed the bot directly. This is what stops a weak model from cheerfully joining a conversation between two other people.
- **Backlog is not "woken"** ([`manager.liveFreshnessMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **2 min**): a message redelivered long after it was sent is recorded as context but does not start a live reply cycle.
- **Catch-up on start** ([`manager.catchUpWindowMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **10 h**): when a mode starts, chats whose last message is not yours and is still recent get answered — so switching the bot on does not silently ignore what waited for it.
- **Re-greeting** ([`manager.reopenAfterMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **24 h**): a conversation resuming after a long silence is greeted rather than continued mid-sentence.
- **The sandbox.** While the manager holds the session the model has **no computer access** — only its messaging tools. It cannot read your files, run commands, or ask you anything, and a blocked call steers it back. Extra tools can be allowed explicitly ([`manager.allowedTools`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed)).

### What you see

With [`manager.log`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) on (the default), every turn is mirrored to the **manager** topic of your bot DM: which chat, the model's thinking, the tools it called, the decision it made and why it stayed silent. That is your audit trail — read it for a day before trusting the bot with your chats.

---

## Security model

The idea is simple: **a model can only do harm through its tools.** So when it talks to other people, it gets none — except the ones it needs to talk.

**In Personal, everything is open.** It is your own conversation: the model reads, writes, runs commands, opens the files you send it. It works for you.

**As a manager, it can only reply.** Answering other people, it runs in the **telegram-sandbox**: its tool list is rewritten to the messaging tools and nothing else, and any other call is blocked at runtime — hiding a tool is not enough, a small model happily invents a name it remembers. It can look at **images** people send ([`manager.media.images`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default on) — but not files: documents are refused, and it has no tool to open one anyway.

**In mixed it switches by itself:** your own chat with the bot (terminal or the `personal` topic) → full tools; a message from someone else → sandbox. Same predicate everywhere, so the gate cannot drift out of sync.

**But it is not a container.** No Docker, no VM, no separate user — the Pi process runs with your own rights the whole time. The sandbox gates the *model*, not the process. And [`manager.allowedTools`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) lets you hand tools back into it: whatever you put there, a stranger's message can eventually reach. Empty is the default.

## Getting started

### 1. Create the bot (BotFather)

In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. BotFather replies with an **HTTP API token** (`123456:ABC-…`) — this is your `botToken`.

### 2. Enable Secretary Mode — for manager and mixed modes

Their Telegram side receives messages through a Telegram **Secretary** connection (the feature Telegram **recently renamed from Business** — the Bot API is unchanged), which a bot can only accept when **Secretary Mode** is on for it. One-time BotFather toggle:

> `@BotFather` → `/mybots` → *select your bot* → **Bot Settings** → **Secretary Mode** (formerly **Business Mode**) → **Turn on**

Personal mode does not need it.

> ✅ **No Telegram Premium, subscription, or "business account" is required.** Telegram opened **connected secretary/business bots to everyone** — [Bot API 10.0](https://core.telegram.org/bots/api-changelog), **8 May 2026**: *"Allowed Business Bots to manage user accounts without a Telegram Premium subscription."* An ordinary free account can let a bot reply on its behalf, and the people who message you need nothing either.

### 3. Enable Threaded Mode — required

Your DM with the bot is **two topics**, split by *whose* conversation it is: **personal** (you and the model — your prompts, its replies, and the full trace of the tool calls it made for you) and **manager** (what the bot did for other people — the per-turn feed and runtime notices). Without them both streams share one chat: every moderation card, every notice and your own conversation interleaved — which makes the DM useless as either. The bot creates both topics itself; it only needs the toggle:

> `@BotFather` → open the **Mini App** (tap the menu button next to the message field) → *select your bot* → **Threaded Mode** → **on**

⚠️ It is **not** in the classic `/mybots` → **Bot Settings** keyboard — that menu has no such row. The toggle lives only in the newer BotFather Mini App, under **Thread Settings**. `getMe` then reports `has_topics_enabled: true`, which is exactly what this extension checks.

| Open the Mini App | Turn on Threaded Mode |
| --- | --- |
| <img src="assets/threaded-mode-1-open-mini-app.jpg" alt="The BotFather Mini App button, left of the message field" width="320"> | <img src="assets/threaded-mode-2-toggle.jpg" alt="Thread Settings → Threaded Mode, on" width="320"> |

*Not rendering? Open them in the repository: [`assets/threaded-mode-1-open-mini-app.jpg`](assets/threaded-mode-1-open-mini-app.jpg), [`assets/threaded-mode-2-toggle.jpg`](assets/threaded-mode-2-toggle.jpg).*

Leave **Disallow users to create new threads** off — the extension creates the `personal` and `manager` topics itself, and you may want to add your own.

If the toggle is off, the bot does not die — it falls back to one flat DM — but it **tells you so**, in that DM, with a link back to this section, on every mode start. Silence it only by deciding: either turn Threaded Mode on, or say you meant it with `topics.enabled: false` (then also consider `manager.log: false`, since the feed is chatty in a single stream).

Mute the **manager** topic by hand if you don't want its notifications — Telegram gives bots no API for that. Rename the topics with [`topics.personalName` / `topics.managerName`](SETTINGS.md#topics-owner-dm-layout).

### 4. Find your Telegram user id

`allowedUserId` is your **numeric** user id (not your @username) — the only account the bot obeys. Get it from a lookup bot such as [@userinfobot](https://t.me/userinfobot) or [@getidsbot](https://t.me/getidsbot).

### 5. Configure

Create `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json` (typically `~/.pi/agent/extensions/pi-telegram-manager/settings.json`):

```json
{
  "botToken": "123456:ABC-your-bot-token",
  "allowedUserId": 123456789,
  "manager": { "ownerName": "Alex" }
}
```

`botToken` may instead be `"env:TELEGRAM_BOT_TOKEN"` to read it from the environment. Every other key is optional — see **[SETTINGS.md](SETTINGS.md)**.

### 6. (Manager / mixed only) Connect the bot to your account

The toggle in step 2 only *allows* the bot to be connected; this is where you actually hand it your chats. Open Telegram **Settings → Telegram Business / Secretary → Chatbots** (Telegram is rolling out the *Secretary* label), enter your bot's username, and choose which chats it may access — and make sure it is allowed to **reply** (without that permission the bot can read but not answer, and the manager will sit there silent).

<img src="assets/connect-secretary-bot.gif" alt="Telegram Settings → Business/Secretary → Chatbots: adding the bot and picking its chats" width="300">

*Not rendering? Open it in the repository: [`assets/connect-secretary-bot.gif`](assets/connect-secretary-bot.gif).*

Then open Pi and start a mode.

---

## Commands

**In the Pi terminal:**

| Command | Purpose |
| --- | --- |
| `/telegram-personal` | Start **Personal** mode (bind this session to your DM) |
| `/telegram-manager` | Start the **secretary manager** (answer other people for you) |
| `/telegram-mixed` | Start **mixed** mode — terminal + Telegram in one session |
| `/telegram-stop` | Stop whichever mode is active |
| `/telegram-status` | Show the active mode |

**In your chat with the bot:** `/start` (privacy & terms — anyone), `/switch` (mode picker — owner), `/stop` (stop the bot — owner), `/help`; in Personal mode also `/clear`, `/esc`.

---

## Settings

Everything is one JSON file at `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json`. Every key is optional and layered over the defaults; unknown keys warn, wrong-typed values fail loudly. The timings default for a **local model** answering over minutes, not milliseconds.

**Every key, with its default: [SETTINGS.md](SETTINGS.md).**

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
