> ⚠️ Experimental. pi-telegram-manager is built **for local models** and, at runtime, is driven by one — a small local model (tested with [`Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)) running through Pi. Cloud LLMs (such as Claude) take part in its development. It is maintained with AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-telegram-manager

An experimental [Pi](https://github.com/earendil-works/pi) extension that puts a Pi agent on Telegram.

The question behind it: **can a small local model be genuinely useful in everyday life if its context is managed carefully?** So the design starts from the local model, not a cloud one. Where other extensions assume a large cloud context and pour everything into it, this one **respects a small context window** — it was tuned for a local model at **131k** context and tested with [`Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF). Almost every choice — one decision per turn ending in a tool call, strict per-chat context isolation, a last-N memory window, idle memory consolidation split into resumable fragments — exists to keep a small model coherent across many conversations without a huge prompt. It works with cloud models too, but that is not what it is for.

The model runs **on your machine, in your own Telegram account**, and you pick how it behaves with a **mode**. This is a personal experiment — expect rough edges, bugs, and behavior that changes.

> ⚖️ **Terms & responsibility — read before using.** By running this bot you must read and follow Telegram's terms: the [Bot Developer Terms](https://telegram.org/tos/bot-developers), the [Privacy Policy](https://telegram.org/privacy), and the [Secretary / Business section](https://telegram.org/tos/bot-developers#5-4-telegram-business). This extension was built for **remote control and automation of your own Telegram chats**. **You alone are responsible** for how you use it and for the data it processes; the author accepts no responsibility for your use of the bot or what you do with that data. The bot also shows these links on `/start` and `/help`.

---

## Modes

One bot account, one mode at a time. Each mode is a different job for the same model.

### 🔀 Mixed — terminal + Telegram in one brain

One Pi session runs two threads: your **terminal session** and Telegram moderation, with the **terminal always the priority**. While you are at the terminal, Telegram is deferred and nothing from it enters your session — no tokens, no confusion, and even a wake-word only queues, it never pulls the model off your work. Once your inference has been idle for `mixed.returnToTelegramMs` (default **8 min**), the brain moderates Telegram in the sub-mode you chose; the moment you type again it drops Telegram, aborts any in-flight reply, and restores your full tools. Your TUI stays clean — just a footer (`mixed · observer · coding`); the log of what it did while you were away lands in the **log** topic of your bot DM.

Mixed is Personal **and** manager at once: the **chat** topic of your bot DM is a second keyboard for the very same session. Writing there is exactly like typing at the terminal — same priority, so it cancels the return timer, aborts a moderation turn in flight, and answers you with your full tools; the reply lands in both the terminal and the chat topic, and what you type at the terminal is mirrored into it. Moderation output never leaks there: the manager talks to the interlocutor and logs to the **log** topic.

Start it with `/telegram-mixed` (it asks for observer or takeover — see below).

### 🤖 Personal — bridge your terminal to a DM

Binds your **current Pi terminal session** to your **private chat with the bot**, so you drive your own agent from your phone: send text, files, and images; get replies in native rich Markdown with a live "typing…" indicator and streamed drafts; queue messages while it works; `/clear` history or `/esc` a turn. The bot talks only to **you** (`allowedUserId`) and touches no other chats.

Start it with `/telegram-personal`.

### 🕵️ Secretary manager — answer other people on your behalf

Through a Telegram **Secretary** connection (the feature Telegram formerly called **Business**; same Bot API), the bot reads your conversations with **many different people** and decides, message by message, whether to reply **on your behalf**. One agent multiplexes every chat, with:

- **strict per-chat context isolation** — each turn the model sees only that one conversation, rebuilt from disk;
- a **priority scheduler** — one chat at a time, never-replied chats first, a continuation window that keeps a live conversation going;
- an **owner-reply window** — a first message is held a few minutes so *you* can answer first; only if you stay silent does the bot step in;
- **persistent per-contact memory** — durable facts about each person (keyed by their account, not their name), resurfaced across sessions and updated by an idle consolidation pass that pauses for live replies;
- **catch-up on activation** — on start it answers the chats still worth answering;
- an optional **debug feed** — it can DM *you* each turn's thinking, tools, and decision.

Start it with `/telegram-manager`; it asks for a sub-mode:

| Sub-mode | Behavior |
| --- | --- |
| 👁️ **Observer** | Co-pilot. Steps in only when you stay silent past the owner-reply window — you always get first crack. |
| 🎛️ **Takeover** | The bot runs the chats and replies on its own. |

Mixed uses the same two sub-modes for its Telegram side.

### ⏹️ Switching from the chat (`/switch`)

Send **`/switch`** in your DM with the bot (or tap it in the command menu) to flip between **Observer / Takeover / Mixed·Observer / Mixed·Takeover / Personal / Stop** from an inline keyboard — no terminal needed. Every mode, including mixed, is switchable from here. It is a **priority** action: it aborts whatever the bot is doing (even a long memory consolidation) and switches at once. A **pinned message** at the top of that chat always shows the active mode.

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

Your DM with the bot works better as two topics: **chat** (the conversation with the model) and **log** (the moderation feed, notices, tool activity). The bot creates both itself — it only needs the toggle:

> `@BotFather` → open the **Mini App** (tap the menu button next to the message field) → *select your bot* → **Threaded Mode** → **on**

⚠️ It is **not** in the classic `/mybots` → **Bot Settings** keyboard — that menu has no such row. The toggle lives only in the newer BotFather Mini App, under **Thread Settings**. `getMe` then reports `has_topics_enabled: true`, which is exactly what this extension checks.

| Open the Mini App | Turn on Threaded Mode |
| --- | --- |
| <img src="assets/threaded-mode-1-open-mini-app.jpg" alt="The BotFather Mini App button, left of the message field" width="320"> | <img src="assets/threaded-mode-2-toggle.jpg" alt="Thread Settings → Threaded Mode, on" width="320"> |

Leave **Disallow users to create new threads** off — the extension creates the `chat` and `log` topics itself, and you may want to add your own.

Without it everything still works: the bot falls back to one flat DM (and you may want `manager.log: false` there, since the feed is chatty). Mute the **log** topic by hand if you don't want its notifications — Telegram gives bots no API for that. Rename the topics with `topics.chatName` / `topics.logName`, or turn the whole thing off with `topics.enabled: false`.

### 4. Find your Telegram user id

`allowedUserId` is your **numeric** user id (not your @username) — the only account the bot obeys. Get it from a lookup bot such as [@userinfobot](https://t.me/userinfobot) or [@getidsbot](https://t.me/getidsbot).

### 5. Install

```bash
pi install git:github.com/m62624/pi-telegram-manager
```

### 6. Configure

Create `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json` (typically `~/.pi/agent/extensions/pi-telegram-manager/settings.json`):

```json
{
  "botToken": "123456:ABC-your-bot-token",
  "allowedUserId": 419332999,
  "manager": { "ownerName": "Alex" }
}
```

`botToken` may instead be `"env:TELEGRAM_BOT_TOKEN"` to read it from the environment. Every other key is optional — see **[SETTINGS.md](https://github.com/m62624/pi-telegram-manager/blob/main/SETTINGS.md)**.

### 7. (Manager / mixed only) Connect the bot to your account

Open Telegram **Settings → Telegram Business / Secretary → Chatbots** (Telegram is rolling out the *Secretary* label), enter your bot's username, and choose which chats it may access.

Then open Pi and run a command below. The extension loads `./src/index.ts` directly — no build step, just a Pi session restart after changes.

---

## Commands

**In the Pi terminal:**

| Command | Purpose |
| --- | --- |
| `/telegram-personal` | Start **Personal** mode (bind this session to your DM) |
| `/telegram-manager` | Start the **secretary manager** (asks for observer / takeover) |
| `/telegram-mixed` | Start **mixed** mode — terminal + Telegram (asks for observer / takeover) |
| `/telegram-stop` | Stop whichever mode is active |
| `/telegram-switch` | Open the mode-switcher panel in your bot DM |
| `/telegram-status` | Show the active mode |

**In your chat with the bot:** `/start` (privacy & terms — anyone), `/switch` (mode picker — owner), `/help`; in Personal mode also `/clear`, `/esc`.

---

## Settings

Everything is one JSON file at `<pi-agent-dir>/extensions/pi-telegram-manager/settings.json`. Every key is optional and layered over the defaults; unknown keys warn, wrong-typed values fail loudly.

**See [SETTINGS.md](https://github.com/m62624/pi-telegram-manager/blob/main/SETTINGS.md)** for every key — defaults, append-vs-replace semantics, the wake-word rules (matching, the auto-added labeler, and mixed-mode priority), the labeler banner, and the timing table. The timings default for a **local model** answering over minutes, not milliseconds.

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
