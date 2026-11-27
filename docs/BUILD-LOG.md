# Mail — build log & how it works

**Date:** 27 November 2026
**For:** Rob (TBN)
**What it is:** A no-brand desktop email app for a client. It connects several mailboxes, reads them, and has an AI assistant on the side (Gemini-in-Gmail style) that reads full emails and answers questions. Everything runs on the person's own computer.

---

## 1. In plain words — what it does

- **Connect a mailbox once.** Enter an email; the app figures out the provider and walks you through a one-time key (or Microsoft sign-in). Read-only — it never sends, deletes or changes anything.
- **Read your real inbox.** A clean list with sender avatars, unread dots, preview text, and a reader that strips out tracking-link spam so emails read like plain text.
- **Open and read PDFs.** Attachments open in their own window, and the assistant can read what's inside (invoices, etc.).
- **Ask the assistant.** Pick an email and ask "summarise this" / "what do they want?", or switch to "All mail" and ask "any unpaid invoices?" It only reads the emails it needs and shows which ones it used.
- **Your choice of AI.** A free model on your own computer (Ollama), or your own key for OpenAI, Claude, DeepSeek, or any compatible service.
- **Make it yours.** A box for standing instructions the assistant always follows, and keyword chips to watch. Drag the dividers to resize panes; it remembers your layout.
- **Live refresh.** New mail appears on its own; there's also a manual refresh and a 90-second safety check.
- **No brand.** The app is just called "Mail" — no TBN, no logo.

---

## 2. What it works with

| Provider | How it connects | Status |
|---|---|---|
| Gmail | One-time app password (guided) | ✅ Working, tested live (TBN Gmail) |
| Yahoo, iCloud, Zoho | App / app-specific password (guided per provider) | ✅ Built |
| Business / custom domain (plain mail server) | Password + optional server box | ✅ Built |
| Outlook / Hotmail / Live & **work Microsoft 365** | "Sign in with Microsoft" (OAuth) | ✅ Built — needs a one-time Microsoft app ID, not yet tested end-to-end |

The app auto-detects when a **company domain** (you@company.com) is actually Microsoft 365 and offers the Microsoft sign-in, with a manual switch either way.

---

## 3. How it's built (technical)

- **Shell:** Electron + plain HTML/CSS/JS (no framework). One codebase builds Mac and Windows.
- **Mail:** `imapflow` (IMAP) + `mailparser`. Connections are **kept alive per account** (a pool) so opening mail is instant. `html-to-text` converts HTML emails to clean text; long tracking URLs are collapsed to `[link]`.
- **Live mail:** IMAP IDLE — the server's `exists` event tells the app new mail arrived; a 90s poll is the backup.
- **PDF:** `pdf-parse` extracts text so the AI can read attachments; PDFs open in a Chromium window.
- **AI:** a small module that streams from Ollama (local), OpenAI-compatible endpoints (OpenAI, DeepSeek via `api.deepseek.com`, OpenRouter, etc.) or Anthropic. The assistant gets the open email, or for "all mail" the app searches, reads the top matches in full, and feeds those — sized so small local models cope.
- **Microsoft sign-in:** `lib/ms-oauth.js` — OAuth2 auth-code flow with PKCE (public client, no secret) in a real Microsoft sign-in window, so password/OTP/admin-link all work. Scope is read-only IMAP (`IMAP.AccessAsUser.All`). IMAP then authenticates with the token (XOAUTH2); the token auto-refreshes. Microsoft-365-behind-a-custom-domain is detected via Microsoft's `getuserrealm` endpoint.
- **Privacy:** mail, keys and chat stay on the computer. API keys and the Microsoft refresh token are encrypted with the OS keychain (Electron `safeStorage`). Only the emails needed to answer a question are sent to the AI the person chose.
- **Login detection ("cybersecurity" bit):** the app decrypts Chrome's cookie vault locally to see which Google accounts are signed in, only to offer one-tap connect — it does **not** use those to read mail.

**Files:** `06-Projects/mail-reader/app/` — `main.js` (backend), `preload.js`, `renderer/` (the UI), `lib/` (`imap-reader.js`, `ms-oauth.js`, `ai.js`, `chrome-detect.js`). Design doc: `docs/specs/2026-11-27-mail-reader-design.md`.

---

## 4. The path we took (and dead ends)

1. **First idea — read the mail straight from the browser's saved login.** I decrypted Chrome's cookie vault (worked) but Google blocks replaying those cookies outside the real browser (401 / bounced to login). Then an embedded Google sign-in failed because your 2FA security key can't complete inside an app window. Google's "basic HTML" mail view (which I'd planned to read) had also been retired. **All dead ends — pivoted.**
2. **Pivot — direct IMAP with a one-time app key.** Reliable, reads the full mailbox. Connected to your TBN Gmail and it worked.
3. **Then refined, in order:** real UI (avatars, unread dots, reader) → resizable panes (saved) → DeepSeek option → assistant instructions + keywords → faster opening (kept-alive connections) + previews + clean bodies + PDF reading → live auto-refresh → made the Connect dialog adapt per provider → **Sign in with Microsoft** for Outlook/work mail, including auto-detecting Microsoft behind company domains.

---

## 5. Honest caveats

- **"Without the company knowing":** everything the assistant does stays on the computer and is invisible to the employer. But connecting a work mailbox still shows up in the company's sign-in logs like any mail app. I did not and will not build anything to hide that or get around company security. For discretion, the Microsoft app should be registered under a **personal** Microsoft account, not the work one.
- **Microsoft needs a one-time setup** (registering the app to get an app ID). Some stricter companies also need IT to approve it, or have mail access switched off — then it can't connect.
- **Mac build is unsigned** for now (first open needs right-click → Open); signing is a later add.

---

## 6. Still to do

- Do the 10-minute Microsoft setup and test the sign-in end-to-end.
- **True multi-mailbox** — right now a second account replaces the first; next step is several mailboxes sharing one inbox.
- **Search all mail + folders** (Sent, Starred) and "load older".
- **Package** as a real `.dmg` / Windows `.exe`.

---

## 7. How this was made (tools & skills)

- **Brainstorming skill** (Superpowers) — shaped the idea and the one-page design before any code, including a reviewer pass that caught gaps.
- **Electron + Node** build, driven from the terminal; the live app driven and screenshotted with the computer-use tools to verify each change on screen.
- **Chrome / Comet** (your browser) used to open Google's app-password page for the first Gmail connection.
- **Libraries:** imapflow, mailparser, html-to-text, pdf-parse, plus Microsoft's public OAuth and realm endpoints.
- A **design doc** and this build log kept alongside the code so the whole thing can be handed over or picked up later.
