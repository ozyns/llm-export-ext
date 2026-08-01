# LLM Chat Exporter

A Chrome extension that adds an **"Export chat"** button to ChatGPT, Claude, Gemini, and
DeepSeek — saves the current conversation as a clean Markdown file, including full history
on very long conversations.

No build step, no npm, no dependencies, no login screen, no data leaves your browser.

## Supported sites

- [chatgpt.com](https://chatgpt.com) / chat.openai.com
- [claude.ai](https://claude.ai)
- [gemini.google.com](https://gemini.google.com)
- [chat.deepseek.com](https://chat.deepseek.com)

## Why this exists

Long AI chat conversations get **virtualized** by all of these sites — messages that
scroll far out of view are removed from the DOM to keep the page fast. Most simple
"export button" scripts read the page once and silently drop whatever isn't currently
mounted, which shows up as missing messages in the middle or end of long chats.

This extension scrolls through the whole conversation and merges snapshots taken along
the way, so nothing gets dropped regardless of chat length. See
[`content.js`](./content.js) for the details — the merge logic is in `mergeSnapshotInto`.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave, etc.).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repo folder.
5. Open a conversation on any supported site — a green **"⬇ Export chat"** button appears
   bottom-right. Click it.

## Output

A `.md` file named `{site}-{conversation-title}.md`, with headings for each turn and
code blocks, tables, links, and lists preserved.

## Limitations

- Images are linked by URL, not downloaded.
- Selectors will occasionally break when a site redesigns its UI.
- Artifact/canvas panels and "thinking" panels that render outside the main message flow
  aren't specially captured.

## Contributing

Adding a new site is one adapter object in `content.js` (see `ADAPTERS` near the top) plus
a `matches` entry in `manifest.json`. Issues and PRs welcome, especially selector fixes
when a site changes its DOM.

## License

MIT — see [LICENSE](./LICENSE).
