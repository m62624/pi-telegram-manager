# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/m62624/pi-telegram-manager/security/advisories/new)
on GitHub, or email the address in the commit history. Please do not open a public
issue for anything that could be used against someone's account before it is fixed.

What is in scope: anything that leaks the bot token, exposes one contact's messages
or memory to another, or lets a message from a stranger drive the tool-calling side
of the extension. What is not: how the model words a reply, or what your own
`settings.json` tells it to do.

## Where the real thing lives

There are exactly two places this project is published from, and both are mine:

- **npm** — [`pi-telegram-manager`](https://www.npmjs.com/package/pi-telegram-manager)
- **git** — [github.com/m62624/pi-telegram-manager](https://github.com/m62624/pi-telegram-manager),
  mirrored to [tangled](https://tangled.org/m62624.tngl.sh/pi-telegram-manager)

Anything else — a fork, a re-upload, a package with a similar name — is somebody
else's software, running under somebody else's responsibility.

### Verify a release, do not take my word for it

Releases are published from GitHub Actions with npm **trusted publishing** (OIDC,
no long-lived token), which attaches a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements):
a signed statement binding the tarball to the commit and the workflow run it was
built from. You can check it yourself:

```sh
npm audit signatures            # in a project that depends on it
npm view pi-telegram-manager dist.attestations
```

A tarball that cannot show provenance pointing at this repository was not built
here, whatever its README says.

## Forks, and what a fork can change

The licence is MIT: fork it, change it, ship it. That freedom is real, and so is
its consequence — **a fork is not this project**, and I cannot vouch for one, patch
one, or be responsible for what one does.

Two things are deliberately not configurable in the code I publish (see
[SETTINGS.md](SETTINGS.md#telling-people-it-is-a-bot)):

1. the manager introduces itself as an AI assistant to anyone it has no history
   with;
2. asked whether it is a bot, it says yes.

These live in a bundled instruction block appended **after** any user instructions,
so no `settings.json` reaches them. A fork can of course delete that file — that is
what "open source" means. What it cannot do is make that my software or my doing:
whoever removed the disclosure and pointed a bot at real people is the one who did
it, and under Telegram's [Bot Developer Terms](https://telegram.org/tos/bot-developers)
the developer is "you" — the person whose account holds the bot's credentials.

## What the bot is allowed to do on your machine

In manager and mixed modes the model runs in a **Telegram sandbox**: only the
messaging tools, no shell, no filesystem, no network beyond Telegram. Messages from
strangers therefore cannot reach a tool that touches your computer. If you widen
that yourself with `manager.allowedTools`, you are handing text written by other
people to the tools you named — do it deliberately, or not at all.

Personal mode is the opposite by design: it is *your* chat with *your* agent, with
the tools you already trust it with. Which is why the owner check (`allowedUserId`)
is the one setting the extension refuses to start without.
