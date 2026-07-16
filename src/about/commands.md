# The commands the owner can use in the chat

These drive the **bot and the Pi session behind it** — they are not messages to you, and
you never see them as prompts: the bridge takes them before you do.

**Every command below is the OWNER's, and only theirs.** The bot accepts them from
nobody else: not from a stranger in manager mode, not from anyone who asks nicely, not
from anyone claiming to be the owner. They are taken only from the owner's own private
chat with the bot, and refused everywhere else — in code, not by good manners. The one
exception is `/start`, which anyone may send and which shows the privacy terms.

So when you describe them, say **whose** they are. "Available everywhere" below means "in
every MODE" — never "to everyone".

## The owner, in every mode (personal, manager, mixed)

- `/help` — the list of commands, as a card in the chat.
- `/status` — what the session is doing right now: the model and its provider, how full
  the context is, the working directory, whether a turn is running, what is queued, and —
  in mixed — whether the owner or the manager currently holds the session.
- `/context` — what the model is actually carrying: which thread it was built from (the
  owner's session, or one isolated chat), how big the last call really was, what the
  context is made OF (tool output is usually most of it), and whether a compaction has
  already replaced part of the history with a summary.
- `/esc` — cancel whatever the agent is doing, exactly as the Escape key does in the
  terminal. If the session does not stop, the bot says so rather than staying quiet.
- `/switch` — change the mode (manager / personal / mixed) with buttons.
- `/stop` — stop the bot entirely. Deliberately a typed command and not a button, so a
  mistap cannot end a Secretary connection.
- `/start` — the privacy and terms notice. The one command anyone may use.

## The owner, in personal and mixed only

- `/clear` — wipe the conversation history. It is the same session as the terminal, so
  the terminal sees the cleared context too. Refused while a turn is running.
- `/compact` — summarise the history so a long session keeps going instead of running
  into the context window. The chat is told how it went: how full the context was, what
  the history weighed, and a card if the compaction failed. Every compaction — this one,
  and the automatic ones Pi starts on its own — is summarised with instructions to keep
  what the person said over the tool output that dwarfs it.
- `/resume` — choose which Pi session personal runs in, with buttons: keep the **current**
  one, start a **new** one, or **resume** any other session from this project (paged, five
  at a time). Picking new or resume switches the session — the personal topic rotates to
  mirror the change — and the bridge comes back up in the chosen one. When resuming a
  different session, its last few messages are replayed into the topic as **display-only**
  cards, so the phone shows which conversation is now live; those replayed messages are for
  reading only — they are not sent to the agent, and ordinary forwarding works as before
  afterwards. The same picker appears in the terminal when the owner runs
  `/telegram-personal`; there the roster is paged too, so a long history stays readable.

In **manager** mode these two do nothing and say so: the context there is built fresh for
each conversation, so there is no accumulated history to clear or to compact.

## What none of them are

None of these change a **setting**. Settings are read when a mode starts and live in the
owner's `settings.json`; changing one means editing that file and restarting the mode in
Pi. Do not promise otherwise — see the `settings` topic.

## In the terminal, not in the chat

`/telegram-personal`, `/telegram-manager`, `/telegram-mixed`, `/telegram-stop` and
`/telegram-status` are Pi commands: the owner types them at their terminal, not to the
bot. Sending them to the bot does nothing.
