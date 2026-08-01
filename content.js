(function () {
  'use strict';

  // Guard against double-injection.
  if (window.__llmExportInjected) return;
  window.__llmExportInjected = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // =====================================================================
  // 0. WHY THIS FILE IS SHAPED THE WAY IT IS
  // ---------------------------------------------------------------------
  // Every one of these sites (ChatGPT, Claude, Gemini, DeepSeek) virtualizes
  // its message list once a conversation gets long: messages that scroll far
  // out of view are removed from the DOM entirely to keep the page fast.
  //
  // The old version of this script scrolled to the top to force the full
  // history to load, then ran ONE extraction pass at the very end. By the
  // time scrolling finished, messages near the bottom had often been
  // unmounted again — so long conversations silently lost their tail end.
  // That's the "3000+ line chats don't save everything" bug.
  //
  // The fix: extract a "snapshot" of whatever's currently mounted at many
  // points during scrolling (up AND down), and merge those snapshots
  // together into one ordered, deduplicated list. See mergeSnapshotInto().
  // =====================================================================

  // ---------------------------------------------------------------------
  // 1. Generic DOM helpers shared by every site adapter.
  // ---------------------------------------------------------------------

  // Elements that are UI chrome, not conversation content, and should never
  // end up in the exported Markdown (copy/like/edit buttons, icons, screen
  // reader-only labels, etc.)
  const STRIP_SELECTORS = [
    'button',
    'svg',
    'style',
    'script',
    'textarea',
    '[role="toolbar"]',
    '.sr-only',
    '.visually-hidden',
    '.screen-reader-only',
    '[aria-hidden="true"]',
  ];

  function cleanClone(el) {
    const clone = el.cloneNode(true);
    for (const sel of STRIP_SELECTORS) {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    }
    return clone;
  }

  function findScrollContainer(anchorSelector) {
    const explicit = document.querySelector('main [class*="scroll"]') || document.querySelector('main');
    if (explicit && explicit.scrollHeight > explicit.clientHeight) return explicit;

    const anchor = anchorSelector ? document.querySelector(anchorSelector) : null;
    let el = anchor ? anchor.parentElement : null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Given a list of anchor elements (e.g. every user-message bubble), find
  // the nearest common ancestor. Its direct children are (almost always)
  // the individual "turn rows" of the conversation — this lets us find the
  // message-list container without knowing the site's actual class names.
  function commonAncestor(a, b) {
    const ancestorsA = [];
    let el = a;
    while (el) {
      ancestorsA.push(el);
      el = el.parentElement;
    }
    el = b;
    while (el) {
      if (ancestorsA.includes(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findRowsContainer(anchors) {
    if (anchors.length === 0) return null;
    if (anchors.length === 1) return anchors[0].parentElement;
    let ancestor = anchors[0];
    for (let i = 1; i < anchors.length; i += 1) {
      ancestor = commonAncestor(ancestor, anchors[i]);
      if (!ancestor) return null;
    }
    return ancestor;
  }

  // Builds an extractTurns() function for sites where one role (e.g. the
  // user bubble, or DeepSeek's `.ds-markdown` answer block) is reliably
  // selectable, and the other role just is "whatever else is in the row".
  function rowBasedExtractor({ anchorSelector, anchorRole, otherRole, anchorContentSelector }) {
    return function extractTurns() {
      const anchors = Array.from(document.querySelectorAll(anchorSelector));
      if (anchors.length === 0) return [];

      const container = findRowsContainer(anchors);
      if (!container) {
        return anchors.map((a) => ({
          role: anchorRole,
          el: anchorContentSelector ? a.querySelector(anchorContentSelector) || a : a,
        }));
      }

      return Array.from(container.children)
        .map((row) => {
          const anchorEl = row.matches(anchorSelector) ? row : row.querySelector(anchorSelector);
          if (anchorEl) {
            const contentEl = anchorContentSelector ? anchorEl.querySelector(anchorContentSelector) || anchorEl : anchorEl;
            return { role: anchorRole, el: contentEl };
          }
          if (!row.textContent || !row.textContent.trim()) return null;
          return { role: otherRole, el: row };
        })
        .filter(Boolean);
    };
  }

  // ---------------------------------------------------------------------
  // 2. Minimal HTML -> Markdown converter. Unknown/custom elements (e.g.
  //    Gemini's <user-query>/<model-response>) fall through to the
  //    default case and just get unwrapped, which is what we want.
  // ---------------------------------------------------------------------
  function tableToMarkdown(node) {
    const rows = Array.from(node.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const cellsOf = (row) => Array.from(row.children).map((c) => elementToMarkdown(c).trim().replace(/\n+/g, ' '));
    const header = cellsOf(rows[0]);
    let out = `| ${header.join(' | ')} |\n`;
    out += `| ${header.map(() => '---').join(' | ')} |\n`;
    for (let i = 1; i < rows.length; i += 1) {
      out += `| ${cellsOf(rows[i]).join(' | ')} |\n`;
    }
    return out;
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case 'p':
        return `${elementToMarkdown(node).trim()}\n\n`;
      case 'br':
        return '\n';
      case 'strong':
      case 'b':
        return `**${elementToMarkdown(node)}**`;
      case 'em':
      case 'i':
        return `*${elementToMarkdown(node)}*`;
      case 'code':
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
          return elementToMarkdown(node);
        }
        return `\`${node.textContent}\``;
      case 'pre': {
        const codeEl = node.querySelector('code');
        const langMatch = codeEl?.className.match(/language-(\S+)/);
        const lang = langMatch ? langMatch[1] : '';
        const codeText = (codeEl ? codeEl.textContent : node.textContent).replace(/\n$/, '');
        return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
      }
      case 'ul': {
        let out = '';
        for (const li of node.children) out += `- ${elementToMarkdown(li).trim()}\n`;
        return `${out}\n`;
      }
      case 'ol': {
        let out = '';
        let i = 1;
        for (const li of node.children) {
          out += `${i}. ${elementToMarkdown(li).trim()}\n`;
          i += 1;
        }
        return `${out}\n`;
      }
      case 'li':
        return elementToMarkdown(node);
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return `${'#'.repeat(Number(tag[1]))} ${elementToMarkdown(node).trim()}\n\n`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        return `[${elementToMarkdown(node)}](${href})`;
      }
      case 'img': {
        const alt = node.getAttribute('alt') || 'image';
        const src = node.getAttribute('src') || '';
        return `![${alt}](${src})`;
      }
      case 'blockquote':
        return `${elementToMarkdown(node).trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'hr':
        return '\n---\n\n';
      case 'table':
        return `${tableToMarkdown(node)}\n`;
      case 'thead':
      case 'tbody':
      case 'tr':
      case 'th':
      case 'td':
        return '';
      default:
        return elementToMarkdown(node); // unwrap unknown containers/custom elements
    }
  }

  function elementToMarkdown(node) {
    let out = '';
    for (const child of node.childNodes) out += nodeToMarkdown(child);
    return out;
  }

  // ---------------------------------------------------------------------
  // 3. Site adapters. Each one tells the generic engine how to find
  //    message turns, the scroll container, and the conversation title.
  // ---------------------------------------------------------------------
  const ADAPTERS = {
    chatgpt: {
      id: 'chatgpt',
      assistantLabel: 'ChatGPT',
      hostTest: (h) => /(^|\.)chatgpt\.com$/.test(h) || /(^|\.)chat\.openai\.com$/.test(h),
      extractTurns() {
        return Array.from(document.querySelectorAll('[data-message-author-role]')).map((turn) => ({
          role: turn.getAttribute('data-message-author-role') || 'assistant',
          el: turn.querySelector('.markdown') || turn,
        }));
      },
      findScrollContainer: () => findScrollContainer('[data-message-author-role]'),
      getTitle: () => document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT Conversation',
    },

    claude: {
      id: 'claude',
      assistantLabel: 'Claude',
      hostTest: (h) => /(^|\.)claude\.ai$/.test(h),
      // Claude doesn't label assistant turns with a stable attribute, but
      // human turns have `data-testid="user-message"`. We use that as an
      // anchor and treat every other row in the same list as Claude's turn.
      extractTurns: rowBasedExtractor({
        anchorSelector: '[data-testid="user-message"]',
        anchorRole: 'user',
        otherRole: 'assistant',
      }),
      findScrollContainer: () => findScrollContainer('[data-testid="user-message"]'),
      getTitle: () => document.title.replace(/\s*[-|]\s*Claude\s*$/i, '').trim() || 'Claude Conversation',
    },

    gemini: {
      id: 'gemini',
      assistantLabel: 'Gemini',
      hostTest: (h) => /(^|\.)gemini\.google\.com$/.test(h),
      // Gemini renders custom elements <user-query> and <model-response>
      // inside a <div class="conversation-container"> per exchange.
      extractTurns() {
        const containers = Array.from(document.querySelectorAll('.conversation-container'));
        const turns = [];
        for (const c of containers) {
          const uq = c.querySelector('user-query');
          const mr = c.querySelector('model-response');
          if (uq) turns.push({ role: 'user', el: uq });
          if (mr) turns.push({ role: 'assistant', el: mr });
        }
        if (turns.length > 0) return turns;
        // Fallback: grab the custom elements directly, in DOM order.
        return Array.from(document.querySelectorAll('user-query, model-response')).map((n) => ({
          role: n.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant',
          el: n,
        }));
      },
      findScrollContainer: () =>
        document.querySelector('infinite-scroller.chat-history') ||
        document.querySelector('infinite-scroller') ||
        findScrollContainer('model-response'),
      getTitle: () => document.title.replace(/\s*[-|]\s*Gemini\s*$/i, '').trim() || 'Gemini Conversation',
    },

    deepseek: {
      id: 'deepseek',
      assistantLabel: 'DeepSeek',
      hostTest: (h) => /(^|\.)chat\.deepseek\.com$/.test(h),
      // DeepSeek's own class names are hashed and churn between releases,
      // but `div.ds-markdown` (the rendered answer body) has stayed stable
      // across several site versions, so we anchor on that.
      extractTurns: rowBasedExtractor({
        anchorSelector: 'div.ds-markdown',
        anchorRole: 'assistant',
        otherRole: 'user',
      }),
      findScrollContainer: () => findScrollContainer('div.ds-markdown'),
      getTitle: () => document.title.replace(/\s*[-|]\s*DeepSeek.*$/i, '').trim() || 'DeepSeek Conversation',
    },
  };

  function detectAdapter() {
    const host = location.hostname;
    return Object.values(ADAPTERS).find((a) => a.hostTest(host)) || null;
  }

  // ---------------------------------------------------------------------
  // 4. Snapshot capture + merge. This is the fix for the data-loss bug.
  // ---------------------------------------------------------------------
  function captureSnapshot(adapter) {
    return adapter
      .extractTurns()
      .map((t) => {
        if (!t.el) return null;
        const cleaned = cleanClone(t.el);
        const markdown = elementToMarkdown(cleaned).trim();
        if (!markdown) return null;
        return { role: t.role, markdown };
      })
      .filter(Boolean);
  }

  const keyOf = (t) => `${t.role}\u0000${t.markdown}`;

  // Merges a new snapshot into the running accumulator, preserving relative
  // order. Matching is positional (advances a pointer through the
  // accumulator as it goes) rather than a global unique-set, so two
  // genuinely separate turns with identical text (e.g. two "Thanks!"
  // replies) don't get collapsed into one.
  function mergeSnapshotInto(accumulator, snapshot) {
    const result = [];
    let ai = 0;
    for (const item of snapshot) {
      const itemKey = keyOf(item);
      let matchIdx = -1;
      for (let k = ai; k < accumulator.length; k += 1) {
        if (keyOf(accumulator[k]) === itemKey) {
          matchIdx = k;
          break;
        }
      }
      if (matchIdx === -1) {
        result.push(item);
      } else {
        for (let m = ai; m <= matchIdx; m += 1) result.push(accumulator[m]);
        ai = matchIdx + 1;
      }
    }
    for (let m = ai; m < accumulator.length; m += 1) result.push(accumulator[m]);
    return result;
  }

  // ---------------------------------------------------------------------
  // 5. Scroll the conversation and accumulate snapshots along the way.
  //    Phase 1 scrolls to the top repeatedly to force full history to
  //    load. Phase 2 sweeps back down in small steps — this is what
  //    recaptures messages that got unmounted while we were up top.
  // ---------------------------------------------------------------------
  async function loadAndExtractAll(adapter, onProgress) {
    const container = adapter.findScrollContainer();
    let accumulator = [];

    const snapshotAndMerge = (label) => {
      accumulator = mergeSnapshotInto(accumulator, captureSnapshot(adapter));
      onProgress?.(label, accumulator.length);
    };

    // Phase 1: scroll to top until height stabilizes (forces lazy-loaded
    // older history to fetch/mount).
    let lastHeight = -1;
    let stableCount = 0;
    for (let attempt = 0; attempt < 400 && stableCount < 3; attempt += 1) {
      container.scrollTop = 0;
      await sleep(350);
      snapshotAndMerge('Loading full history…');
      const height = container.scrollHeight;
      if (height === lastHeight) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastHeight = height;
    }

    // Phase 2: sweep downward in increments, snapshotting as we go, to
    // recover anything virtualized out while we were scrolled to the top.
    container.scrollTop = 0;
    await sleep(200);
    let stepStable = 0;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const before = container.scrollTop;
      const step = Math.max(200, Math.floor(container.clientHeight * 0.6) || 400);
      container.scrollTop = before + step;
      await sleep(220);
      snapshotAndMerge(`Scanning conversation… (${accumulator.length} messages so far)`);
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
      if (container.scrollTop === before || atBottom) {
        stepStable += 1;
        if (stepStable >= 2) break;
      } else {
        stepStable = 0;
      }
    }

    // Final capture at rest.
    await sleep(150);
    snapshotAndMerge('Finishing up…');

    return accumulator;
  }

  // ---------------------------------------------------------------------
  // 6. Build + download the Markdown file.
  // ---------------------------------------------------------------------
  function slugify(s) {
    return (
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 80) || 'conversation'
    );
  }

  function buildDocument(adapter, title, messages) {
    let out = `# ${title}\n\n`;
    for (const m of messages) {
      const heading = m.role === 'user' ? 'You' : m.role === 'assistant' ? adapter.assistantLabel : m.role;
      out += `### ${heading}\n\n${m.markdown}\n\n`;
    }
    return out;
  }

  function downloadMarkdown(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------------
  // 7. The button.
  // ---------------------------------------------------------------------
  function injectButton(adapter) {
    if (document.getElementById('llm-export-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'llm-export-btn';
    btn.textContent = `⬇ Export ${adapter.assistantLabel} chat`;
    document.body.appendChild(btn);

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const originalText = btn.textContent;

      try {
        const messages = await loadAndExtractAll(adapter, (label, count) => {
          btn.textContent = `${label} ${count ? `(${count})` : ''}`;
        });

        if (messages.length === 0) {
          alert('No messages found on this page — is a conversation open?');
          return;
        }

        const title = adapter.getTitle();
        const doc = buildDocument(adapter, title, messages);
        downloadMarkdown(doc, `${adapter.id}-${slugify(title)}.md`);

        btn.textContent = `✓ Saved ${messages.length} messages`;
      } catch (err) {
        console.error('[llm-export] failed:', err);
        alert(`Export failed: ${err.message}`);
      } finally {
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 2500);
      }
    });
  }

  const adapter = detectAdapter();
  if (adapter) {
    injectButton(adapter);
    // These are all single-page apps; re-check occasionally in case the
    // button gets removed by a full re-render (cheap no-op if already there).
    setInterval(() => injectButton(adapter), 3000);
  }
})();
