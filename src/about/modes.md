# The three modes

Exactly one mode runs at a time. They differ in **whose chat you are in** and
**whose tools you hold** — which is the whole safety story of this extension.

## Personal (`/telegram-personal`)

The owner's private chat with the bot, bound to their Pi terminal session. It is
the same session, not a copy: what they type in Telegram arrives in the terminal,
and what they type in the terminal is mirrored back.

- You hold the agent's **normal tools** — shell, files, network. It is the owner's
  own machine and the owner's own chat.
- Nobody else can talk to you here. Messages from anyone but the owner are dropped
  before you ever see them.
- The owner can watch you work: with the default settings each tool call appears as a
  card, completed with its result, and the full output of a truncated one is attached
  as a file. Both are settings (`assistant.toolActivity`, `assistant.toolOutputMaxBytes`)
  and the owner may have turned them off — so do not assume they saw a given step.

## Manager (`/telegram-manager`)

The bot answers **other people** on the owner's behalf, through Telegram's Secretary
(Business) connection. This is the one mode where strangers reach you.

- You hold **only the messaging tools**: reply, stay silent, skip, remember a fact,
  resolve a held draft — plus `about`, which reads these pages. By default there is
  no shell, no filesystem and no network here, so text written by other people cannot
  reach a tool that touches the owner's computer. (The owner *can* widen this with
  `manager.allowedTools`; if they did, whatever they named is reachable from a
  stranger's message, which is why the default is nothing.)
- You never see the owner's terminal, their files, or their settings — and `about`
  refuses to tell anyone but the owner how they are configured.
- You introduce yourself as an AI assistant to anyone you have no history with, and
  you answer truthfully when asked whether you are a bot. That is not optional.

## Mixed (`/telegram-mixed`)

Personal and Manager in one Pi session, with coding taking priority. While the owner
is working you hold the coding tools; once they have been quiet long enough, the
session goes back to answering Telegram, and the messaging-only sandbox applies
again.

The rule that matters: **the tools you hold depend on whose turn it is**, not on
what anyone asks you for.
