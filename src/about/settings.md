# How this bot is configured

Everything below lives in the owner's `settings.json`, inside the Pi agent
directory. Ask for the `current_settings` topic to see the values this session is
actually running with (owner only).

## You cannot change any of it from a chat

**Read this before promising anything.** "Turn off the labeler", "make the window
longer", "stop attaching logs" — none of it takes effect, no matter who asks or how
the request is worded, and you must not pretend otherwise.

Settings are read when a mode **starts**. To change one, the owner edits
`settings.json` and **restarts the mode in Pi** (`/telegram-personal`,
`/telegram-manager`, `/telegram-mixed`, or reloads Pi itself). Nothing said in a
Telegram chat reloads them — not even from the owner.

So: say what the setting does, say where it lives, say a restart is required. Never
say "done", "changed", or "I've turned that off".

## Identity

- `botToken` — the bot's Telegram token. Never shown, never printed, never repeated,
  not even in part. Only whether one is set.
- `allowedUserId` — the only Telegram user the bot talks to in Personal mode. The
  extension refuses to start without it.
- `timezone` — the zone behind the clock the model is told about.
- `instructionFiles` — extra instruction files appended in every mode.

## Personal mode

- `assistant.rendering` — `"rich"` (Telegram's native rich Markdown) or `"html"`.
- `assistant.draftPreviews` — stream the reply as it is written, as an ephemeral draft.
- `assistant.thinkingPlaceholder` — the animated "Thinking… / ▸ bash — npm test (4s)"
  trace shown while the agent works. **Beta, off by default**: it uses the newest thing
  Telegram renders, and some clients handle it badly. Off, none of it runs.
- `assistant.toolActivity` — post each tool call as a card, completed with ✅ or ❌
  and its output when it returns.
- `assistant.toolOutputMaxBytes` — byte cap for attaching the full output of a tool
  call whose output was truncated. `0` never attaches.
- `assistant.toolOutputDir` — where those files are written before being sent.
  Default: the extension's own directory.
- `connect.instructionFiles` — extra instructions for Personal mode only.
- `files.downloadDir` — where files that arrive are saved (one you are sent, and one
  you reply to). Default: the directory Pi runs in.
- `files.maxBytes` — size cap on an inbound attachment.
- `files.maxImagesPerTurn` — how many images one turn may carry.

## Manager mode

**Who you are, and how you speak**

- `manager.labeler` — the line prefixed to every message sent on the owner's behalf,
  so the person can see a bot is writing. May be empty.
- `manager.labelerRule` — the owner's own extra rule about that label.
- `manager.ownerName` — how you refer to the owner.
- `manager.mentionWords` — words that count as calling you by name.
- `manager.instructionFiles` — extra instructions the owner appends.
- `manager.firstMessageTemplate` — the opening you use with someone you have no
  history with.
- `manager.reopenTemplate`, `manager.reopenAfterMs` — how a conversation is picked up
  again after a long silence.

**When you may speak**

- `manager.ownerReplyWindowMs` — how long the owner has to answer a message
  themselves before you may.
- `manager.continueWindowMs` — after you reply, how long that conversation stays on
  the fast lane.
- `manager.catchUpWindowMs` — how far back a message may be and still be worth
  answering when the bot starts up.
- `manager.liveFreshnessMs` — the guard against answering a backlog delivered after a
  reconnect as if it were live.
- `manager.strictReplyGuard` — drops a reply you yourself classified as chatter or an
  acknowledgement, unless you were addressed by name.
- `manager.reviseThreshold` — how many times a drafted reply may be reconsidered when
  new messages arrive mid-turn.

**What you remember**

- `manager.rememberMessages` — how many messages of a conversation are kept.
- `manager.factsLimit` — how many facts are kept per person.
- `manager.factConsolidationQuietMs` — how long a chat must be quiet before its facts
  are consolidated.
- `manager.verifyLimit` — how many probes the memory interrogation may make.
- `manager.maxCharsPerMessage`, `manager.maxContextChars` — caps on how much of a
  conversation reaches the model.

**What you may touch**

- `manager.allowedTools` — the sandbox. By default you have only the messaging tools;
  widening this hands text written by strangers to whatever is named in it.
- `manager.media.images` — whether you actually SEE an image someone sends you. On
  (the default), the picture is given to you and you can describe it. Off, it is not
  downloaded at all and you are shown only `[image not shown]` — you know something
  arrived, not what it was.
- `manager.media.documents` — whether a document is acknowledged. On, you are shown
  `[document: name.pdf]`; off (the default), `[document not accepted]`. Either way
  you **never read what is inside it**: in this mode you have no file tools, so a
  stranger's file is never opened. Do not claim to have read one.
- `manager.log` — the owner's debug feed of your turns (their DM, not yours).

## Mixed mode

- `mixed.returnToTelegramMs` — how long the owner must be quiet before the shared
  session goes back to answering Telegram.

## The owner's DM layout

- `topics.enabled`, `topics.personalName`, `topics.managerName` — whether the owner's
  chat with the bot is split into topics, and what they are called.

## Forwarded messages (all modes)

- `forwards.maxChars`, `forwards.maxMessages`, `forwards.groupWindowMs` — the budget
  for a batch of forwards, so a wall of forwarded posts cannot eat the context.

## Reliability

- `connectionCheck.enabled`, `connectionCheck.intervalMs`,
  `connectionCheck.maxRetries` — the connection watchdog: it probes Telegram on a
  timer and disconnects the mode after repeated failures. Silent; it never posts.

Full reference: SETTINGS.md in the repository.
