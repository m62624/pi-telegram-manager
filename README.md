# pi-telegram-manager

> ⚖️ **Terms & responsibility — read this before anything else.**
>
> Running this bot makes **you** a Telegram bot developer, and you must read and follow Telegram's rules: the [Bot Developer Terms](https://telegram.org/tos/bot-developers), the [Privacy Policy](https://telegram.org/privacy), and the [Secretary / Business section](https://telegram.org/tos/bot-developers#5-4-telegram-business).
>
> This extension was built for **remote control and automation of your own Telegram chats**. In manager and mixed modes it reads conversations with **other people** and can answer **on your behalf** — those people are talking to a machine without necessarily knowing it. Decide for yourself whether that is fair in each chat, and say so where it matters (the bot prefixes its messages with a visible label by default — see `manager.labeler`).
>
> **You alone are responsible** for how you use it and for the data it processes; the author accepts no responsibility for your use of the bot or what you do with that data. The bot repeats these links on `/start` and `/help`.

> ⚠️ **Experimental.** Built **for local models** and, at runtime, driven by one — a small local model (tested with [`Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)) running through Pi. Cloud LLMs (such as Claude) take part in its development. It is maintained with AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

---

An experimental [Pi](https://github.com/earendil-works/pi) extension that puts a Pi agent on Telegram.

The question behind it: **can a small local model be genuinely useful in everyday life if its context is managed carefully?** So the design starts from the local model, not a cloud one. Where other extensions assume a large cloud context and pour everything into it, this one **respects a small context window** — it was tuned for a local model at **131k** context. Almost every choice — one decision per turn ending in a tool call, strict per-chat context isolation, a last-N memory window, idle memory consolidation split into resumable fragments — exists to keep a small model coherent across many conversations without a huge prompt. It works with cloud models too, but that is not what it is for.

The model runs **on your machine, in your own Telegram account**, and you pick how it behaves with a **mode**. This is a personal experiment — expect rough edges, bugs, and behavior that changes.

### What this deliberately is not

**One local model, one session. No sub-agents, no agent swarm, no orchestration layer, no cloud-scale machinery** — and that is a decision, not a gap waiting to be filled. Every one of those tricks assumes you can afford to spend context and calls freely; a single small local model cannot, and adding them would quietly break the very thing this extension is for. So instead of spawning a helper for each chat, one model handles them all, seeing exactly one conversation at a time.

If you need it for a cloud model — parallel agents, a big context, a delegation layer — **fork it**. The code is MIT, the ports are injected, and the pieces you would replace (context building, the scheduler, the memory passes) are the ones deliberately kept small. It runs on cloud models as-is; it is simply not tuned for them, and it will not grow features that only make sense there.

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

Both channels can have bugs; the difference is only what they track — npm follows tagged releases, GitHub follows `main`. Pick npm for released versions and GitHub to try the newest changes.

Then follow **[Getting started](#getting-started)** — a bot token, your user id, and (for the manager) one BotFather toggle.

---

## Modes

One bot account, one mode at a time. Each mode is a different job for the same model.

### 🤖 Personal — your terminal session, on your phone

Binds your **current Pi terminal session** to your **private chat with the bot**. It is the same session, not a copy: what you type in Telegram arrives in the terminal, what you type in the terminal is mirrored to Telegram, and the model's answer appears in both.

- Send text, files and images; the bot saves non-image files to disk and hands the model real paths ([`files.downloadDir`](SETTINGS.md#files)), so it can open them with its normal tools.
- You see the model **work**, not just its conclusion: each message it writes is delivered as it finishes, and each tool call is mirrored as a collapsible block ([`assistant.toolActivity`](SETTINGS.md#assistant-personal-mode)).
- Replies arrive as native rich Markdown with a live "typing…" indicator and a streamed draft preview ([`assistant.draftPreviews`](SETTINGS.md#assistant-personal-mode)).
- Messages you send while it is busy are **queued**, not dropped; editing a queued message rewrites it in place.
- The bot talks only to **you** (`allowedUserId`) and touches no other chats.

Start it with `/telegram-personal`. In the chat: `/clear` (wipe history), `/esc` (cancel the running turn), `/help`.

### 🕵️ Secretary manager — answer other people on your behalf

Through a Telegram **Secretary** connection (the feature Telegram formerly called **Business**; same Bot API), the bot reads your conversations with **many different people** and decides, message by message, whether to reply **on your behalf**. One agent multiplexes every chat.

**The two sub-modes are the whole personality of this mode** — pick deliberately:

| Sub-mode | Who leads | What it does | Pick it when |
| --- | --- | --- | --- |
| 👁️ **Observer** | **You do.** | The bot stays quiet by default. It reads everything, but only steps in when a message is clearly **for it** (a wake-word, a direct question) or when a message that needs an answer has sat unanswered past the owner-reply window and **you** did not answer it. If you reply first, the bot drops it and never repeats you. | You are around and answering; you want a safety net for what you miss, not a stand-in. **The safe default — start here.** |
| 🎛️ **Takeover** | **The bot does.** | It runs the conversation: it answers the interlocutor without waiting for you, keeps the thread moving, and only stays silent when there is genuinely nothing to answer. Your own messages still take precedence when you send one, but it does not wait for you. | You are away and want the conversation carried, not merely watched. |

Both sub-modes obey the same silence rules — small talk between other people, reactions and acknowledgements are not answered, and the bot never replies to *you* (it reads your messages only as context). The difference is **whether it waits for you first**.

Start it with `/telegram-manager`; it asks for the sub-mode. Mixed uses the same two.

### 🔀 Mixed — Personal **and** manager, in one session

Mixed is not a third behaviour. It is the two modes above **running at once on one brain**: Personal (you and the model) plus the secretary manager (the model and everyone else). The whole design is about **who gets the model right now**, and the answer is always: **you do**.

**While you are working, you are the priority.** You can work from the **terminal** or from the **personal** topic of your bot DM — they are the same session and rank exactly the same, so answering from your phone is not "the Telegram side", it is you. While you hold the brain:

- other people's messages are **stored and deferred**, and nothing from them enters your context or costs you tokens;
- even a wake-word does **not** pull the model off your work — it only marks that chat as ready to be answered later;
- you keep your **full tools** (`read`/`write`/`bash`), because the sandbox only applies while the model is moderating.

**When you stop, it goes back to Telegram.** The clock starts *after the model's inference finishes* — not while it is thinking. If nothing new comes from **you** and nothing more comes from **the model** for [`mixed.returnToTelegramMs`](SETTINGS.md#mixed-mixed-mode) (default **8 minutes**), the brain switches to Telegram and answers whoever needs an answer, in the sub-mode you picked (observer or takeover). Any message from you cancels the countdown.

**When you come back, you take the brain immediately.** A prompt from you — terminal or personal topic — aborts a moderation turn in flight, so you never wait on it. Nothing is lost: an unanswered chat is picked up again next time, and an interrupted memory pass resumes where it stopped.

Moderation never leaks into your side: what the bot writes to other people goes to them, and the account of what it did lands in the **manager** topic. Your TUI stays clean — one footer line (`mixed · observer · coding`) tells you who holds the brain right now.

Start it with `/telegram-mixed` (it asks for observer or takeover).

### ⏹️ Switching modes

Run **`/telegram-switch`** in Pi to pick a mode in the terminal — **Personal / Observer / Takeover / Mixed·Observer / Mixed·Takeover / Stop**, with the live one marked. Or send **`/switch`** in your DM with the bot to flip between the same modes from an inline keyboard, no terminal needed (the terminal picker can also push that keyboard to your phone while the bot is running).

Every mode command is itself a switch: starting one while another runs stops that one first — you never have to stop by hand. Switching is a **priority** action: it aborts whatever the bot is doing (even a long memory consolidation) and takes effect at once. A **pinned message** in the `personal` topic always shows the active mode.

---

## How the manager actually works

This is the part worth understanding before you let a model answer people for you. Every number below is a setting — the links go to [SETTINGS.md](SETTINGS.md).

### One chat at a time, in a deliberate order

Messages from many people arrive at once; the model handles **one chat per turn**, so it is never confused about who it is talking to. The scheduler picks the next chat by:

1. **never-replied chats first** — someone who has not heard back yet outranks an ongoing conversation;
2. then a **continuation window** ([`manager.continueWindowMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed), default **1:30**) — right after replying, that chat keeps priority, so a live back-and-forth is not interrupted by an older one.

### The owner-reply window — your first chance (observer's core)

A message that needs an answer is **held** for [`manager.ownerReplyWindowMs`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) (default **5 min**) before the bot may touch it. If **you** answer in that time, the bot drops it silently and never repeats you.

Two things skip the wait: a **wake-word** (see below) and takeover mode, where the bot does not wait for you at all.

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

With [`manager.log`](SETTINGS.md#manager-business-manager-and-the-telegram-side-of-mixed) on (the default), every turn is mirrored to the **manager** topic of your bot DM: which chat, the model's thinking, the tools it called, the decision it made and why it stayed silent. That is your audit trail — read it for a day before trusting takeover.

---

## Getting started

### 1. Create the bot (BotFather)

In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. BotFather replies with an **HTTP API token** (`123456:ABC-…`) — this is your `botToken`.

### 2. Enable Secretary Mode — for manager and mixed modes

Their Telegram side receives messages through a Telegram **Secretary** connection (the feature Telegram **recently renamed from Business** — the Bot API is unchanged), which a bot can only accept when **Secretary Mode** is on for it. One-time BotFather toggle:

> `@BotFather` → `/mybots` → *select your bot* → **Bot Settings** → **Secretary Mode** (formerly **Business Mode**) → **Turn on**

There is no special "secretary bot" type and nothing to pay for on the bot's side — just this toggle. (Personal mode doesn't need it.)

> ℹ️ **Under the hood** (this extension already does it for you): with Secretary Mode on, the bot handles `business_connection` updates when you connect it, receives your chats as `business_message`/`edited_business_message` updates, checks `can_reply`, and sends on your behalf with the `business_connection_id`. When you tap **Manage Bot** in a managed chat, Telegram opens the bot with a `/start bizChat<user_chat_id>` deep link — the bot answers that with its privacy/terms reminder.

> ✅ **No Telegram Premium, subscription, or "business account" is required.** Telegram opened **connected secretary/business bots to everyone** — [Bot API 10.0](https://core.telegram.org/bots/api-changelog), **8 May 2026**: *"Allowed Business Bots to manage user accounts without a Telegram Premium subscription."* An ordinary free account can let a bot reply on its behalf, and the people who message you need nothing either.

### 3. Enable Threaded Mode — recommended

Your DM with the bot works better as two topics, split by *whose* conversation it is: **personal** (you and the model — your prompts, its replies, and the full trace of the tool calls it made for you) and **manager** (what the bot did for other people — the per-turn feed and runtime notices). The bot creates both itself — it only needs the toggle:

> `@BotFather` → open the **Mini App** (tap the menu button next to the message field) → *select your bot* → **Threaded Mode** → **on**

⚠️ It is **not** in the classic `/mybots` → **Bot Settings** keyboard — that menu has no such row. The toggle lives only in the newer BotFather Mini App, under **Thread Settings**. `getMe` then reports `has_topics_enabled: true`, which is exactly what this extension checks.

| Open the Mini App | Turn on Threaded Mode |
| --- | --- |
| <img src="assets/threaded-mode-1-open-mini-app.jpg" alt="The BotFather Mini App button, left of the message field" width="320"> | <img src="assets/threaded-mode-2-toggle.jpg" alt="Thread Settings → Threaded Mode, on" width="320"> |

Leave **Disallow users to create new threads** off — the extension creates the `personal` and `manager` topics itself, and you may want to add your own.

Without it everything still works: the bot falls back to one flat DM (and you may want `manager.log: false` there, since the feed is chatty in one stream). Mute the **manager** topic by hand if you don't want its notifications — Telegram gives bots no API for that. Rename the topics with [`topics.personalName` / `topics.managerName`](SETTINGS.md#topics-owner-dm-layout), or turn the whole thing off with `topics.enabled: false`.

### 4. Find your Telegram user id

`allowedUserId` is your **numeric** user id (not your @username) — the only account the bot obeys. Get it from a lookup bot such as [@userinfobot](https://t.me/userinfobot) or [@getidsbot](https://t.me/getidsbot).

### 5. Configure

Create `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json` (typically `~/.pi/agent/extensions/pi-telegram-manager/settings.json`):

```json
{
  "botToken": "123456:ABC-your-bot-token",
  "allowedUserId": 419332999,
  "manager": { "ownerName": "Alex" }
}
```

`botToken` may instead be `"env:TELEGRAM_BOT_TOKEN"` to read it from the environment. Every other key is optional — see **[SETTINGS.md](SETTINGS.md)**.

### 6. (Manager / mixed only) Connect the bot to your account

Open Telegram **Settings → Telegram Business / Secretary → Chatbots** (Telegram is rolling out the *Secretary* label), enter your bot's username, and choose which chats it may access.

Then open Pi and run one of the commands below.

---

## Commands

**In the Pi terminal:**

| Command | Purpose |
| --- | --- |
| `/telegram-personal` | Start **Personal** mode (bind this session to your DM) |
| `/telegram-manager` | Start the **secretary manager** (asks for observer / takeover) |
| `/telegram-mixed` | Start **mixed** mode — terminal + Telegram (asks for observer / takeover) |
| `/telegram-switch` | Pick the mode in the terminal (or send the switcher keyboard to your bot DM) |
| `/telegram-stop` | Stop whichever mode is active |
| `/telegram-status` | Show the active mode |

**In your chat with the bot:** `/start` (privacy & terms — anyone), `/switch` (mode picker — owner), `/help`; in Personal mode also `/clear`, `/esc`.

---

## Settings

Everything is one JSON file at `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json`. Every key is optional and layered over the defaults; unknown keys warn, wrong-typed values fail loudly.

**See [SETTINGS.md](SETTINGS.md)** for every key — defaults, append-vs-replace semantics, the wake-word rules, the labeler banner, the topics layout, and the full timing table. The timings default for a **local model** answering over minutes, not milliseconds.

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
