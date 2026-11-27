# Mail Reader: design

Date: 27 Nov 2026 · Owner: Rob (TBN) · Status: draft for approval

## Why

Rob wants a Gemini-in-Gmail style assistant that is not tied to one mail provider or one AI vendor. It is built for one person (a client of Rob's) and ships with **no brand name** anywhere: no TBN, no product logo. The person connects all their mailboxes, chooses their own AI (their own API key, or a free model running on their own computer), and chats with an assistant that can read every email in full.

## Goals

1. One desktop app (Mac first, Windows build too) the person installs and double-clicks.
2. Connect several mailboxes at once: Gmail, Outlook/Hotmail/Live, and any other IMAP mailbox (Yahoo, iCloud, Zoho, company mail).
3. Read their mail like a normal mail app: unified inbox, folders, full email view, attachments listed.
4. A chat panel on the right, like Gemini's sidebar, that can:
   - answer about the email that is open ("summarise this", "what do they want from me?")
   - answer across all mail ("what did the bank send me this month?", "any unpaid invoices?", "find the flight booking")
   - read long emails and whole threads in full, not just a preview
   - cite the emails it used, each a click away
5. Bring your own AI: pick a provider in Settings.
   - Local: Ollama (auto-detected on the machine, free, nothing leaves the computer)
   - Cloud with own key: OpenAI, Anthropic (Claude), Google (Gemini), and any OpenAI-compatible endpoint (OpenRouter, Groq, LM Studio, etc.)
6. Private by default: mail, index and keys stay on the computer. The only thing that ever leaves is what is sent to the AI the person chose.

## Non-goals (v1)

- Sending, replying, deleting or moving mail. v1 is read-only, which keeps accounts safe and needs only read permissions. (A "draft a reply" button that copies text is fine; it never sends.)
- A hosted website, user sign-ups, payments, sync across devices.
- Mobile apps.
- Calendar, contacts.

## Anti-goals (failure even if it works)

- Any brand name, logo or "made by" in the app, window title, installer, icon or About box. Window title is just "Mail".
- Mail or keys going anywhere other than the person's computer and their chosen AI.
- The assistant making things up about an email. Every answer about mail must come from emails it actually read, with links to them; if it can't find it, it says so.
- Being slow to open on a big mailbox (tens of thousands of emails).

## Constraints

- Gmail: public apps that read Gmail need Google's paid security review. We avoid it by connecting Gmail over IMAP with a Google **app password** (needs 2-step verification on the account). The app walks the person through making one, step by step.
- Outlook/Hotmail and work Microsoft 365: connected with Microsoft sign-in and read-only Graph access (see "Calls made after review").
- No Apple developer account is listed in Tools We Own, so the Mac build is unsigned: first open needs right-click → Open. Signing can be added later for $99/yr.
- Local models on an ordinary laptop are small; the app must work well with an 8B-class model (short context), not assume a huge one.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **A. Desktop app on their computer (Electron)** | Feels like a real app, one-click install, private, skips Google review, local model works | **Picked** (Rob: "go with your pick") |
| B. Runs on their computer, opens in the browser | Same privacy, less work, but feels like a tool not an app; person must start it | Rejected: worse for a non-technical person |
| C. Hosted website | Needs Google's paid review (months), local models can't reach it, we'd hold their mail | Rejected |

Electron over Tauri: mail (IMAP) and AI libraries are mature in Node; one language end to end; builds for Mac and Windows from the same code.

## How it works

**Stack:** Electron + React + TypeScript (Vite), SQLite (better-sqlite3) with full-text search (FTS5), imapflow for IMAP, mailparser for message bodies, keys in the OS keychain via Electron safeStorage.

**Mail sync**
- Each account: first sync pulls headers for all folders, then full bodies newest-first in the background; progress bar per account. Keeps listening for new mail (IMAP IDLE).
- Stored locally: headers, plain-text body (HTML converted to text for AI and search; HTML shown sanitised in the reader with remote images blocked until clicked), attachment names/sizes, and extracted text of PDF/Word/plain attachments.
- Threads grouped by Message-ID/References.

**Finding the right emails (so the AI can "read everything")**
- Full-text search index over subject, sender, body and attachment text.
- Optional meaning-based search: embeddings made by the chosen AI (Ollama `nomic-embed-text` locally, or the provider's embedding model). Built in the background; app works without it.
- The assistant gets tools instead of the whole mailbox dumped into it:
  - `search_mail(query, from, to, after, before, account, folder, has_attachment)` → list of matches with short snippets
  - `read_email(id)` → full text of one email (long ones split into parts it can page through)
  - `read_thread(id)` → whole conversation
  - `list_recent(account, folder, days)`
- For "go through everything" questions (e.g. "all invoices this year"), it searches, then reads each match in full, summarising in batches so small local models keep up. It shows "Read 23 emails" with the list.
- Models without tool support (some local ones): the app runs the search itself from the question and passes the top emails in full.

**Chat panel**
- Right-hand sidebar, open by default. Two modes, switched by a chip at the top: "This email" (open email/thread loaded in full) and "All mail".
- Answers stream in; each cited email is a chip that opens it.
- Quick buttons: Summarise, What do they want?, Draft a reply (copy only), Key dates & amounts.
- Chat history saved locally, per conversation.

**Settings**
- Accounts: add/remove, re-sync, guided Gmail app-password setup, Microsoft sign-in.
- AI: choose provider and model; paste key (stored in keychain, never shown again); "Test" button; Ollama models listed automatically if Ollama is running.
- Privacy: a clear line stating what is sent to the AI (only the emails it reads to answer you).

**Screen sketch**
```
┌────────────┬──────────────────────┬─────────────────────┬──────────────┐
│ All inboxes│ Search mail…         │ From: Bank          │ Ask about    │
│  Gmail     │ ● Bank   Statement   │ Subject: Statement  │ [This email] │
│  Outlook   │   Jane   Re: quote   │                     │  All mail    │
│  Work      │   Uber   Your trip   │ (full email)        │ ...chat...   │
│ Folders    │   ...                │ 📎 statement.pdf    │ [ask...    ] │
└────────────┴──────────────────────┴─────────────────────┴──────────────┘
```

## Calls made after review (Claude's calls, Rob can overrule)

- **Never changes anything on the mail server.** Opening an email does not mark it read in Gmail/Outlook (fetch with BODY.PEEK). Read-only means fully read-only.
- **Work accounts come first (Rob, 27 Nov: "both but majorly work").** Microsoft accounts (work Microsoft 365 and personal Outlook/Hotmail) connect through Microsoft Graph with read-only mail permission (`Mail.Read`, `offline_access`), not IMAP, because many companies switch IMAP off. Gmail and other mail stay on IMAP. This replaces the Outlook-over-IMAP line in Constraints.
- **Microsoft app registration:** registered once under a TBN Microsoft account, "any account" audience (personal + work/school); its client ID is built into the app. Many companies block staff from approving unverified apps, so we also complete Microsoft publisher verification (free, needs a Microsoft Partner Network ID). If a company still needs IT to approve it, the app shows a ready-made "send this to your IT team" message with the approval link.
- **Google Workspace (work Gmail):** if the company has switched off app passwords, the app explains this and that IT has to allow it; Google sign-in for Workspace is a later add-on.
- **Work laptops:** many can't install extra software like Ollama, so for work use the default AI is a pasted key; the local model stays an option.
- **First sync:** all headers and text bodies, whole history, newest first. Attachment text (PDF, Word, text, under 10 MB) extracted for the last 2 years in the background; older attachments are fetched and read when the assistant or the person opens them.
- **Local model setup:** Settings checks for Ollama. If missing, it shows a one-click link to install it, then downloads a model sized to the computer's memory (≤8 GB RAM: small 2–4B model and a note that cloud will be better; 16 GB+: 8–9B model). If the computer is too weak, cloud key is the suggested default.
- **Updates:** v1 is updated by sending a new installer (no auto-update, as the Mac app is unsigned). First-open help covers macOS's "Open Anyway" in System Settings → Privacy & Security.
- **Windows:** built from the same code and shipped, but only tested on Mac in v1 (no Windows machine here).

## Left to the builder

- Exact folder layout, component library (plain CSS or Tailwind), icons (generic only).
- Batch sizes and chunk lengths for small vs large models.
- Retry/backoff for IMAP errors; how many emails to fetch per batch.
- Test plan, with a test mailbox; packaging config (electron-builder) for .dmg and Windows .exe.

## Done looks like

The person installs the app and connects their work Microsoft 365 mailbox, a personal Outlook and a Gmail account, on a Mac or a Windows PC, picks either a local Ollama model or a pasted API key, and can ask "what do I owe and to whom?" and get an answer that lists the exact emails it read.
