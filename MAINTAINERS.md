# LLM Chat Exporter (unpacked extension)

No build step, no npm, no Node. This is loaded straight into Chrome as-is.

Works on **ChatGPT**, **Claude**, **Gemini**, and **DeepSeek**.

## Install (one-time, ~30 seconds)

1. Unzip this folder somewhere you won't move/delete it (e.g. `~/llm-export-ext`).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Done. No further setup, no login window, nothing else to configure.

## Use it

1. Go to `chatgpt.com`, `claude.ai`, `gemini.google.com`, or `chat.deepseek.com`, open (or
   continue) any conversation, log in as normal — your regular Chrome, your regular login,
   nothing special.
2. A small green **"⬇ Export [site] chat"** button appears in the bottom-right corner.
3. Click it. It will scroll through the full conversation (this can take a little while on
   very long chats — that's expected, see below), convert everything to Markdown, and
   download a `.md` file named after the conversation title.
4. Nothing closes, nothing logs you out, you can keep chatting immediately after.

## What changed from v0.1 (why long chats used to lose messages)

ChatGPT, Claude, Gemini, and DeepSeek all **virtualize** their message lists: once a
conversation is long, messages that scroll far out of view get removed from the DOM
entirely, to keep the page fast. They get re-mounted when you scroll back to them.

v0.1 scrolled to the top to force the full history to load, then read the DOM **once** at
the very end. By the time scrolling finished, messages near the bottom had often been
unmounted again — so long conversations (the "3000+ line" case) silently lost their tail.

v0.2 fixes this by taking a "snapshot" of whatever's currently mounted at many points
during scrolling — first while scrolling up to force history to load, then again while
sweeping back down in small steps — and merging those snapshots together into one
ordered, deduplicated list (`mergeSnapshotInto` in `content.js`). This is why the export
now takes a bit longer on long chats: it's genuinely walking the whole conversation
instead of trusting a single end-of-scroll snapshot.

## How multi-site support works

Each site gets an **adapter** in `content.js` (`ADAPTERS.chatgpt`, `.claude`, `.gemini`,
`.deepseek`) that tells the shared engine three things:
- how to find each message "turn" and its role (user/assistant),
- how to find the scrolling container,
- how to get the conversation title.

Everything else — the HTML→Markdown conversion, the scroll-and-merge logic, the download —
is shared code.

For sites where only one role has a stable selector (e.g. Claude only reliably marks the
*user* bubble; DeepSeek only reliably marks the *assistant* answer via `div.ds-markdown`),
`rowBasedExtractor()` uses a "find the nearest common ancestor of all known anchors" trick
to locate the message-list container without needing to know the site's actual (often
hashed/auto-generated) class names, then treats every other row as the other role.

## Notes / limitations

- Images are referenced by URL in the Markdown (`![alt](url)`), not downloaded as files.
- Claude's "Artifacts" panels and DeepSeek's "thinking" panels are not specially handled —
  they'll come through as plain text if they're inline in the message, or may be skipped
  if they render in a separate panel outside the message row.
- **Selectors will drift.** None of these sites publish their DOM structure, and Claude,
  Gemini, and DeepSeek in particular are known to change class names between releases
  (DeepSeek's especially — they're hashed and rotate often). If the button stops finding
  messages on a given site, the fix is almost always updating that site's adapter object
  near the top of `content.js`. To find the new selectors, open DevTools Console on the
  site and run:
  ```js
  [...document.querySelectorAll('[data-testid], [data-message-author-role], [data-role]')]
    .map(el => el.outerHTML.slice(0, 80))
  ```
  to see what attributes are actually on the message elements right now.
- To add another site entirely, add a new entry to `ADAPTERS` in `content.js` with
  `hostTest`, `extractTurns`, `findScrollContainer`, and `getTitle`, then add its URL to
  `matches` in `manifest.json`.
