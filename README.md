# pi-telegram-manager

A Telegram bridge for [Pi](https://github.com/earendil-works) local coding agents.

Two **mutually-exclusive** modes (only one active at a time, enforced by a singleton lock):

- **Terminal continuation** (`/telegram-connect`) — binds the current Pi session to a single Telegram
  chat: talk to your agent from Telegram (files, images, native rich Markdown, queueing, `/commands`,
  interrupt). Audio is deferred.
- **Business manager** (`/telegram-manager`) — opens a fresh manager session in a dedicated directory
  and, through a Telegram **business account**, lets the agent reply on your behalf to many people.
  A single agent instance multiplexes chats with strict per-chat context isolation, a priority queue,
  continuation/owner-reply timers, ACID per-chat memory, and `observer`/`takeover` sub-modes.

Status: **early development.** See the approved implementation plan for the architecture and phasing.

## Development

```bash
npm install
npm test        # vitest (all tests + mocks live in tests/)
npm run check   # biome
npm run build   # tsc (typecheck)
npm run ci      # check + build + test + pack --dry-run
```

## License

MIT
