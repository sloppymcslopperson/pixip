# Reftags

A reftag is a pointer to one message. The grammar lives in one place:
`src/client/reftags.js` (`src/reftags.ts` is its typed re-export). Do not copy
the regex into the client, the hub or an extension.

## Grammar

```
[pixip-ref=history/<logicalSessionId>/<entryId>]
[pixip-ref=history/<logicalSessionId>/msg:<role>:<timestamp>]
[pixip-ref=inbox/<inboxMessageId>]
```

- `history` addresses a transcript block. Use the Pi `entryId` when the entry
  has one; use `msg:<role>:<timestamp>` for a block painted from a live event
  that has no entry id yet. The key is the one `coverageKey()` derives in
  `src/jsonl.ts`.
- `inbox` addresses one inbox message by its id (archived messages included).
- The session component is required. `/fork` and `/clone` copy the JSONL with
  the same entry ids, so an entry id alone is ambiguous. Logical session ids are
  minted (`SessionIndexRecord.logicalId`), so `history` and `inbox` cannot
  collide with one.
- `role` is a lowercase Pi role (`user`, `assistant`). `timestamp` is integer
  milliseconds.

## Charset

Strict, so prose is never swallowed:

- session/entry/inbox components: `[A-Za-z0-9._-]+`
- role: `[a-z][a-z0-9]*`
- timestamp: digits only

Brackets are required. There is no bare-address alias in prose, the composer or
the scanner. A literal `[pixip-ref=…]` that does not match stays literal text.

## API

`src/client/reftags.js` exports:

- `formatRefTag(ref)` — structured ref to tag, `null` when invalid.
- `parseRefTag(text)` — one tag to structured ref, `null` when it is not
  exactly one tag.
- `scanRefTags(text)` — every tag in order, each `{ ref, tag, start, end }`.
- `messageKey(entryOrMessage)` — the `msg:<role>:<timestamp>` key, agreeing with
  `coverageKey()`/`coverageKeys()`.
- `refForEntry(sessionId, entry)` — entry id when present, otherwise the live
  message key.

All are total functions: malformed or unknown input returns `null`/`[]` and
never throws.

## Resolving

For an agent without pixip, resolve a history tag from `sessions.json` plus the
JSONL: find the logical session, pick the JSONL file that contains the entry id
(or the message with the covering role/timestamp), and read that entry. Inbox
tags resolve from `<data-dir>/inbox.json`. Ticket 40 adds `pixip ref` for the
same lookup with `--json`.
