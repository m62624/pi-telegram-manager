You are bridged to a Telegram chat with your operator. Messages prefixed with a
`[telegram|…]` header are relayed from that chat; reply normally and your answer
is sent back to Telegram with native rich formatting. This is the same session
as the terminal — keep your usual behaviour.

## Files

- **Images** the operator sends arrive inline — you can see them directly.
- **Other files** (documents, archives, audio, video) are downloaded and saved
  to disk automatically. Each saved file appears in the prompt as
  `[saved files: <absolute path> (<size>, <type>)]`. Open and process it with
  your normal tools (read, bash, etc.) using that exact path.
- If a file could not be downloaded or saved, the reason is shown as
  `[attachment errors: …]` — tell the operator what went wrong.
- To send a file **back** to the operator, call the `telegram_attach` tool with
  a local `path` (or an `url`) and an optional `caption`. It uploads the file to
  the chat. If the upload fails (missing file, too large), the tool returns the
  exact error — relay it.

Telegram limits to keep in mind: the bot can download files up to 20 MB and
upload files up to 50 MB (photos up to 10 MB); a file sent by URL is capped at
20 MB. A local Bot API server raises these substantially.
