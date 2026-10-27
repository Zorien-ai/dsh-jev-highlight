# Client-half verification report (Jev highlight)

Date: 2026-10-20. Half: **client (browser)**. Companion evidence: `docs/dom-notes.md`
(real-GUI DOM investigation), `docs/client-gui-probe-*.png`, `docs/client-fixture-*.png`,
`docs/client-real-chip.png`.

## 1. Repro

```powershell
cd "<repo>"
node scripts/build.mjs                      # build ok: lib/index.js, lib/client.js
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 0 errors
node test/client/serve-fixture.mjs 8123     # prints http://127.0.0.1:8123/test/client/highlight-fixture.html
# open that URL in a browser: phase 1 runs automatically.
# then in devtools: await window.__fixture.phase2()
# full structured report: window.__fixtureReport  (checks[] + phases.phase1/phase2)
```

The fixture page (`test/client/highlight-fixture.html` + `fixture-driver.js`) loads the **real
`lib/client.js`** through a stub `window.__ModuleLoader__`, overrides `window.fetch` to mock
`/jev-highlight/{state,units,toggle}` (including a 700 ms "host not mounted" 404 window), and
supplies a minimal React shim so the actual chip component renders into a DOM node that mimics
`[data-slot="conversation.composer.dock"]`.

Final result: **`document.title = "FIXTURE ALL OK"`, 41/41 checks pass, 0 console messages,
only 3 network requests (fixture html, driver, lib/client.js), all HTTP 200.**

## 2. What the 41 checks cover

Boot + phase 1 (27 checks, automatic on load; screenshots taken in this state):

1. loader result: id `@local/dsh-jev-highlight`, factory returns `inject=['slots','locale']` +
   `apply`, and `req('react')` resolves from the module table;
2. **three highlight names**: `CSS.highlights` keys are exactly `jev-critical`, `jev-medium`,
   `jev-low`;
3. counts: critical 2 (paragraph with inline `<code>`/`<strong>`, plus a table row via
   `matchText`), medium 1 (list item split by inline `<strong>`), low 2 (code block matched
   verbatim with `\n`, plus warning paragraph);
4. matches are cross-text-node `Range`s and the matched text is asserted per bucket;
5. **exclusions**: no range inside the composer/`[data-lexical-editor]`, the sidebar, or a
   `tool-call` node, even though those subtrees contain the same needle strings
   (`composer text: priority highlighter 不应被搜索`, `sidebar priority message`);
6. **DOM invariance**: deep signature (tags + every attribute + text, sorted) and node count of
   `[data-conversation-scroll]` are byte-identical before/after highlighting (39 to 39 nodes);
   no `<mark>`, no wrapper nodes, no injected attributes;
7. chip: registered in `conversation.composer.dock` with order 40, mounted with **undefined
   props** (like the real slot), shows host counts `2 / 1 / 3`, has a toggle button, renders the
   translated label `Jev`;
8. **registration options are only real-slot options**: keys are a subset of
   `name/id/order/label` (no `locale`, no `inject`);
9. locale: dictionaries registered for `zh`, `zh-CN`, `en`;
10. silent host-not-ready retry: the first poll round receives 404 for both route candidates and
    the client keeps retrying without console errors until the mock host "mounts".

Phase 2 (`await window.__fixture.phase2()`, 14 checks):

- **streaming**: appending text nodes / a new paragraph to the markdown root triggers the
  MutationObserver -> rAF remap; the late verdict for the appended paragraph becomes highlighted
  (low 2 -> 3) while the already-mapped medium Range survives unchanged; DOM count only grows by
  the two nodes the fixture itself appended (39 -> 41);
- **toggle**: clicking the chip POSTs `{"enabled":false}`, removes all three names
  (`CSS.highlights.size === 0`), chip flips `data-enabled="false"` + `aria-pressed="false"` and
  releases `busy`; clicking again POSTs `{"enabled":true}` and restores all ranges;
- **cleanup / dispose**: running every `ctx.effect` disposer removes all highlight names,
  removes `style[data-jev-highlight]`, unmounts the chip and stops host polling
  (`units` request count unchanged, 11 -> 11, over the following 700 ms);
- **unsupported fallback**: with `CSS.highlights` hidden (configurable in Chrome), a second
  `apply()` neither throws nor injects the highlight stylesheet, and still registers the chip
  (it would render the localized "unsupported" copy).

## 3. The four acceptance items and their evidence

| Acceptance item | Evidence |
| --- | --- |
| `CSS.highlights` has the three names | phase1 check + report field `phases.phase1.highlights` = `{size:3, keys:['jev-critical','jev-medium','jev-low'], counts:{...}}`; screenshot `docs/client-fixture-phase1.png` (solid orange = critical, pale wash = medium, faint wash + dotted underline = low) |
| Chip counts | report `phases.phase1.chipText` = `Jev213开` (dots + counts 2/1/3 + ON), screenshot `docs/client-fixture-phase1.png` (bottom dock); real installed instance chip screenshot `docs/client-real-chip.png`; toggle evidence in `phases.phase2.toggle.calls` = `[{enabled:false},{enabled:true}]` |
| Agent output DOM unchanged | report `phases.phase1.before/after` signature equality, `nodes 39 === 39`, plus real GUI probe: `[data-chat-flow]` 4893 -> 4893 nodes, `[data-chat-node-key]` sequence identical, **0 MutationObserver records in 700 ms** with highlights active (`docs/dom-notes.md` section 4); screenshots `docs/client-gui-probe-critical.png`, `docs/client-fixture-streaming.png` |
| Unload cleanup | report `phases.phase2.cleanup` = `{highlights.size:0, styles:0, chips:0, pollsBefore:11, pollsAfter:11}`; also verified on the real GUI probe (remove names + `<style>` -> `CSS.highlights.size === 0`) |

Raw report (captured at run time):

```json
{
  "ok": true,
  "passed": 41,
  "total": 41,
  "phase1Highlights": { "size": 3, "keys": ["jev-critical","jev-medium","jev-low"],
                        "counts": {"jev-critical":2,"jev-medium":1,"jev-low":2} },
  "chipText": "Jev213开",
  "domIntegrity": { "before": 39, "afterHighlights": 39 },
  "cleanup": { "highlights": {"size":0,"counts":{"jev-critical":0,"jev-medium":0,"jev-low":0}},
               "styles": 0, "chips": 0, "pollsBefore": 11, "pollsAfter": 11 },
  "unsupported": { "threw": false, "styleInjected": 0, "chipRegistered": true },
  "registrationOptions": ["name", "id", "order"],
  "consoleMessages": 0,
  "network": ["highlight-fixture.html 200", "fixture-driver.js 200", "lib/client.js 200"]
}
```

## 4. Real-GUI evidence (read-only)

Chrome DevTools MCP, isolated browser context, throwaway `dsh web` dev instance provided by the
Lead at `http://127.0.0.1:10232` (the desktop GUI on `127.0.0.1:10223` requires its own launch
token cookie and was never touched). Findings in `docs/dom-notes.md`; scripts driven:
flattened 3 real assistant markdown roots, matched markdown-with-`**` text across 5 text nodes,
matched a table row via cell text and a code block verbatim, registered the three highlight
names, screenshotted the rendering (`docs/client-gui-probe-critical.png`,
`docs/client-gui-probe-levels.png`), then removed all probe styles/highlights and verified the
transcript DOM was untouched (0 mutations, identical node keys).

## 4b. Real installed instance: integration bug found and fixed

The installed-profile validation by the Lead exposed a real bug that the fixture could not catch:
the real `conversation.composer.dock` registration schema accepts only `id`/`order`/`label`
(**no `locale`, no `inject` prop channel**), so the chip registered with extra options was
silently rejected, and the component would have received no `controller`/`t` props.

Fix (in `src/client/controller.ts` + `src/client/chip.ts`):

- `createChipComponent(React, translator, controller)` now receives the controller through the
  factory closure (`controllerArg`), so the chip works with **zero slot props**; `props.t` /
  `props.controller` remain optional fallbacks;
- registration is exactly `slots.register({ name: CHIP_SLOT, id: CHIP_ID, order: 40 }, Chip)`;
- locale dictionaries are still registered in `apply()` (`ctx.locale.register(NS, lang, dict)`)
  and the translator is bound there (`ctx.locale.bind(NS)`).

The fixture was tightened to mirror the real slot (mount with **undefined props**, assert the
registration keys are a subset of `name/id/order/label`); it now passes 41/41.

Verified live on the Lead's installed temporary instance (`http://127.0.0.1:10302`, own isolated
browser context, only selected a read-only session):

- `[data-slot="conversation.composer.dock"]` children: activity pill, usage pill, **and
  `div.jev-highlight-chip`** (text `Jev000开`, `data-ready="true"`, `data-supported="true"`);
- `style[data-jev-highlight]` present; `CSS.highlights.size` 0 with no verdicts yet (expected);
- **toggle round-trip**: click -> chip `data-enabled="false"` and `GET jev-highlight/state`
  returns `enabled:false`; click again -> `enabled:true` (state restored to its original value);
- 0 console errors; screenshot `docs/client-real-chip.png` (chip visible at the composer dock).

## 5. Known limits and notes

- The client does **not** send the optional `sessionId` filter: the Host's session identity
  (`agent.id`) is not guaranteed to equal the DOM's `[data-conversation-session]` value, and a
  mismatched filter would silently return zero units forever. The client polls the global
  `since` cursor and lets text mapping decide what belongs to the visible transcript (units from
  other sessions simply never match; the store is bounded at 2000 units).
- A live model stream was not captured in the bare sandbox (no usable key at the time), so
  streaming growth is simulated in the fixture through the same MutationObserver path the real
  renderer triggers. The installed-instance check above shows the chip and toggle live; the
  verifier's E2E run covers the full verdict -> highlight path with a mock Jev.
- Region selectors prefer the verified Harness attributes
  (`[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] [class*="markdown"]`)
  with three structural fallbacks; if a future build renames everything, the generic leaf-block
  fallback still applies, and the client stays inert (no error) when nothing matches.
- `low` cannot use a left color bar: `::highlight()` only accepts `color`, `background-color`,
  `text-decoration*`, `text-shadow`; it renders as a much fainter wash plus a dotted underline,
  deliberately weaker than `medium`.
- Client files (all under the client-half write scope):
  `src/client.ts`, `src/client/{types,http,textmap,regions,styles,highlighter,polling,chip,controller}.ts`,
  `test/client/{highlight-fixture.html,fixture-driver.js,serve-fixture.mjs}`,
  `docs/{dom-notes.md,client-verification.md,client-gui-probe-*.png,client-fixture-*.png,client-real-chip.png}`.
