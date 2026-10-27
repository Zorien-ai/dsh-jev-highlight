# Real-GUI DOM notes (Jev highlight client half)

Date: 2026-10-20. Investigated with: Chrome DevTools MCP (own isolated browser context)
against a throwaway `dsh web` dev instance (`http://127.0.0.1:10232`, token URL provided by
the Lead), plus Playwright MCP for the initial navigation. The desktop GUI on
`http://127.0.0.1:10223` answers external browsers with `401 dsh web authentication required`
(its launch token only lives in the Electron window's session cookie), so the dev instance was
used instead. Nothing was written to 10223.

Runtime observed: **Chrome/155.0.0.0**, `window.CSS.highlights` present, `Highlight` constructor
present, `window.__ModuleLoader__` present (standard DSH client bundle host).

## 1. Conversation landmarks (verified live)

| Purpose | Selector | Notes |
| --- | --- | --- |
| transcript scroll viewport | `[data-conversation-scroll]` | scroll container of the chat transcript |
| chat flow root | `[data-chat-flow]` | all flow items live below it |
| one flow item | `[data-chat-flow-kind]` | values seen: `user`, `turn-process`, `assistant-step`, `tool-call`, `turn-tail`, `steering`, `turn-error` |
| assistant answer vs reasoning | `[data-chat-group-part]` | `response` = final assistant answer, `reasoning` = thinking trace |
| per-node identity | `[data-chat-node-key]`, `[data-chat-flow-key]`, `[data-chat-anchor-key]` | stable per rendered node, e.g. `14:assistant-step6:52` |
| turn number | `[data-chat-turn]` | |
| per chat node slot | `[data-slot="conversation.chat.node"]` | each flow item renders through this slot |
| slot outlets (general) | `[data-slot="<slot name>"]` | `display: contents` wrapper for registered slot components |

Live assistant answer structure (verified, one specific step):

```
div[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]
  div[data-slot="conversation.chat.node"]
    div.v5IAXa_root                       (CSS-module class, hashed per build)
      div.v5IAXa_body
        div._markdown_1ypvv_5             <-- markdown root (CSS-module class)
          p / ul / ol / h2 / blockquote / table wrapper / code-block wrapper ...
```

`div._markdown_1ypvv_5` is a CSS-module class: the readable part (`_markdown_`) is stable in
this build but the hash (`1ypvv`) can change between builds. Prefer
`[class*="markdown"]` scoped under `[data-chat-group-part="response"]`, with a structural
fallback.

Markdown child elements are plain semantic tags (`p`, `ol`, `ul`, `li`, `h2`, `strong`, `em`,
`code`, `blockquote`, `table`, `thead`, `tbody`, `tr`, `th`, `td`) with no extra classes. Two
exceptions:

```
div._block_7gxqk_4.md-code-block[data-code-wrap="true"]      (code block card)
  div._bannerWrap_7gxqk_24                                   (toolbar: language label + copy)
  div._content_7gxqk_74[data-code-block-content="true"]      (scroll body)
    pre._plain_7gxqk_103
      code
div._tableScroll_1ypvv_192._tableFill_1ypvv_239              (table scroller)
  table
```

## 2. Text-node layout inside the markdown root (verified)

Text nodes are split by React/markdown rendering exactly as the HTML implies:

| Case | `textContent` | Text nodes |
| --- | --- | --- |
| paragraph with inline code | `promo/openfilm/qianke-promo-79/（54.7 MB，可直接拷进影片库）` | `<code>` text node + `<p>` text node (2 nodes) |
| list item with bold | `项目在 Studio 中打开成功：时长 01:18:28（78.933s）、16 个镜头、22 条字幕轨…` | `li`, `strong`, `li`, `strong`, `li` — 5 nodes |
| table row | `film.html` + `16 条画面轨（…）` | one text node per `<td>`, cell boundary has **no text node** |
| code block | `# 方式 A（推荐长期使用）：…\n# 把 promo\\openfilm…` | a single `<code>` text node containing `\n` |
| list marker | – | `::marker` only, **not** in the DOM text (li `::before` = `none`, `::marker` computed `content: normal`) |

Consequences for the mapper:

1. `Range` must span multiple text nodes (inline `strong`/`code`) — implemented and verified.
2. Table cells have no whitespace between them in `textContent`; the host sends
   `matchText = cells.join(" ")` for `table_row`, so the flattener must insert a synthetic
   space at cell/row boundaries.
3. Code blocks contain literal `\n`; whitespace collapse must be applied to both sides.
4. `unit.text` is **raw markdown** (the host splitter keeps `**`, `` ` ``, `*`, `_`, `~`, escapes,
   link/image syntax). The rendered DOM has the markers gone. The needle therefore goes
   through a markdown-aware loose normalization (strip images/links→alt/label, strip HTML
   tags, decode basic entities, drop `*` `` ` `` `_` `~` `\` on both sides); code blocks use
   verbatim whitespace-collapsed matching instead (code may legitimately contain those chars).
5. Headings are not emitted as units (splitter only keeps them as context), so markdown root
   `h1…h6` text is irrelevant to matching.

## 3. Composer / UI regions to exclude

| Purpose | Selector |
| --- | --- |
| composer card / input | `[data-composer-card]`, `[data-composer-input]`, `[data-composer-overlay]` |
| lexical contenteditable input | `[data-lexical-editor]`, `[contenteditable="true"]`, `textarea`, `input` |
| composer dock (our chip lives here) | `[data-composer-dock]`, `[data-slot="conversation.composer.dock"]` |
| left sidebar | `[data-slot="sidebar"]` descendants, `[data-side="sidebar"]` |
| right sidebar / dockkit | `[data-sidebar-right-*]`, `[data-dockkit-*]` |
| shell overlays | `[data-slot="shell.overlay"]`, `[data-shell-overlay]` |
| non-content | `script`, `style`, `noscript`, `template`, `svg`, `button`, `aria-hidden="true"` |
| our own UI | `[data-jev-highlight-ui]`, `style[data-jev-highlight]` |

Verified composer dock geometry: outlet `[data-slot="conversation.composer.dock"]` has
`display: contents`; its parent `div[data-composer-dock]` is `display:flex; gap:12px;
align-items:center; justify-content:center; padding:4px 0 0`. Existing children are
`span.iq1doa_anchor` pills ~22px high (activity / usage stats). A chip should therefore be a
~22px inline-flex pill with 12px font and `gap: 6px`.

Slot names present live: `conversation.composer.dock`, `conversation.chat.node`,
`conversation.chat.flow`, `conversation.composer`, `conversation.input.dock`, `rightbar`,
`shell.overlay`, … (the full list is in the task/report; `conversation.composer.dock` exists
and is populated by the activity/usage pills, confirming the slot is available.)

## 4. Highlight rendering probe on the real GUI (evidence)

A probe script (same algorithm now shipped in `src/client/textmap.ts`) was run in the dev
instance, against the real markdown DOM:

* flattened candidate regions: 3 markdown roots; lengths 82 / 1399 / 1226 normalised chars;
* found and registered a Range crossing 5 text nodes for a list item whose markdown contained
  `**bold**` markers — the loose normalization matched, and Chrome painted the highlight
  across the inline `<strong>` runs (screenshot `docs/client-gui-probe-critical.png`);
* table row matched via `matchText` (cells joined by space);
* code block matched verbatim (raw `\n` preserved);
* `CSS.highlights` had exactly the three names `jev-critical`, `jev-medium`, `jev-low`;
* **DOM integrity while highlights were active**: `[data-chat-flow]` subtree nodes
  4893 → 4893, `[data-chat-node-key]` sequence identical, MutationObserver recorded
  **0 mutations in 700 ms**. Removing the highlight names and the injected `<style>` restored
  `CSS.highlights.size === 0` and left 0 style nodes. See
  `docs/client-gui-probe-levels.png` (critical solid, medium translucent, low weak+dotted).

Caveat: the screenshot shows the current palette before final tuning; the fixture run
(`docs/client-fixture-*.png`) is the authoritative visual check of the shipped palette.

## 5. Streaming behaviour

`[data-chat-flow]` is a virtualised list of flow items keyed by `data-chat-node-key`; while the
assistant streams, React grows/updates the `assistant-step` / `response` node in place
(characterData and childList mutations below the markdown root). The client therefore:

1. observes `[data-conversation-scroll]` (or `[data-chat-flow]` when present) with a
   `MutationObserver` (`childList`, `characterData`, `subtree`), and only listens to
   attributes when they affect our selectors;
2. coalesces all mutations into one remap per animation frame (`requestAnimationFrame`);
3. re-tries unmatched units on every remap (the DOM can lag the verdict stream);
4. re-maps a unit if the nodes of its previous Range left the document (virtualisation /
   re-render) — mapped Ranges are validated with `isConnected`.

Because a live assistant stream was not available in the throwaway dev instance (no model key
there), streaming growth is simulated in `test/client/highlight-fixture.html`: the fixture
appends new text nodes/paragraphs over time and the same `MutationObserver` path is asserted.

## 6. Fallback strategy (if selectors drift)

The mapper tries, in order:

1. `[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] [class*="markdown"]`
   (deduped to outermost)
2. `[data-chat-group-part="response"] [data-slot="conversation.chat.node"]` — whole answer node
3. `[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])`
4. generic: leaves of `[data-conversation-scroll]` / `main` cleaned by the exclusion table
   above, reduced to markdown-ish block containers (`p, li, pre, table, blockquote, h1..h6`).

If none match, the client stays silent (no highlight, chip keeps working) and retries on the
next DOM mutation — never throws into the host page.
