# Mail

A private, no-brand desktop email app. Connect several mailboxes, read them, and use an AI assistant that reads full emails and answers questions — all on your own computer.

- **Connect** Gmail, Yahoo, iCloud, Zoho and most business email with a one-time app key, or **Sign in with Microsoft** for Outlook / Microsoft 365 (including work mail on a company domain).
- **Read-only** — never sends, deletes or changes anything.
- **Bring your own AI** — a free local model (Ollama), or your own key for OpenAI, Claude, DeepSeek or any compatible service.
- **Private** — your mail, keys and chats stay on your computer. Only the emails needed to answer a question are sent to the AI you choose.

## Run it (development)

```bash
cd app
npm install
npm start
```

## Build an installer

```bash
cd app
npm run dist
```

Produces a `.dmg` (macOS) or `.exe` (Windows) in `app/dist/`.

## Docs

- `docs/BUILD-LOG.md` — what's built, how it works, and the decisions behind it.
- `docs/specs/` — the design.

## Layout

```
app/
  main.js            Electron main process (mail, AI, Microsoft sign-in, settings)
  preload.js         bridge to the UI
  renderer/          the interface (HTML/CSS/JS)
  lib/
    imap-reader.js   IMAP mail (kept-alive connections, PDF, live refresh)
    ms-oauth.js      Sign in with Microsoft (OAuth2 + PKCE), IMAP over token
    ai.js            Ollama / OpenAI-compatible / Anthropic
    chrome-detect.js detect which accounts are signed in (for one-tap connect)
```

Outlook / Microsoft 365 needs a one-time Microsoft app registration; paste the app ID in Settings.
