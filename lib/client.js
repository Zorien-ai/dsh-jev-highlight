"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/client/types.ts
  var LEVELS = ["critical", "medium", "low"];
  var HIGHLIGHT_NAMES = {
    critical: "jev-critical",
    medium: "jev-medium",
    low: "jev-low"
  };
  var NS = "jev-highlight";

  // src/client/http.ts
  var PREFIXES = ["jev-highlight/", "/jev-highlight/"];
  var HostUnavailableError = class extends Error {
    constructor(status) {
      super(status === void 0 ? "jev-highlight host route unreachable" : `jev-highlight host route returned HTTP ${String(status)}`);
      __publicField(this, "status");
      this.name = "HostUnavailableError";
      this.status = status;
    }
  };
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function createHostApi(options = {}) {
    const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    let resolvedPrefix = null;
    let mounted = false;
    async function request(path, init) {
      const prefixes = resolvedPrefix === null ? PREFIXES : [resolvedPrefix];
      let lastStatus;
      let lastError;
      for (const prefix of prefixes) {
        try {
          const response = await fetchImpl(`${prefix}${path}`, { cache: "no-store", ...init });
          if (!response.ok) {
            lastStatus = response.status;
            continue;
          }
          const body = await response.json();
          if (!isRecord(body)) {
            lastError = new Error("jev-highlight host route returned a non-object JSON body");
            continue;
          }
          resolvedPrefix = prefix;
          mounted = true;
          return body;
        } catch (cause) {
          lastError = cause;
        }
      }
      if (lastError instanceof Error && lastStatus === void 0) {
        throw new HostUnavailableError();
      }
      throw new HostUnavailableError(lastStatus);
    }
    return {
      get(path) {
        return request(path, { method: "GET", headers: { accept: "application/json" } });
      },
      post(path, body) {
        return request(path, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      },
      mounted() {
        return mounted;
      }
    };
  }

  // src/client/textmap.ts
  var LOOSE_SKIP = /* @__PURE__ */ new Set(["*", "`", "_", "~", "\\"]);
  var BLOCK_TAGS = /* @__PURE__ */ new Set([
    "p",
    "div",
    "li",
    "ul",
    "ol",
    "tr",
    "td",
    "th",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "pre",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "section",
    "article",
    "header",
    "footer",
    "figure",
    "figcaption",
    "dl",
    "dt",
    "dd",
    "main",
    "nav",
    "aside",
    "details",
    "summary",
    "form",
    "fieldset",
    "address"
  ]);
  var EXCLUDED_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BUTTON", "TEXTAREA", "INPUT", "SELECT", "SVG", "CANVAS", "VIDEO", "AUDIO"]);
  var EXCLUDED_ATTRIBUTES = ["data-jev-highlight-ui", "data-code-block-banner", "data-lexical-editor", "data-composer-input", "data-composer-dock"];
  var WHITESPACE = /\s/u;
  function isElement(node) {
    return node.nodeType === 1;
  }
  function isExcludedElement(element) {
    if (EXCLUDED_TAGS.has(element.tagName)) return true;
    for (const attribute of EXCLUDED_ATTRIBUTES) {
      if (element.hasAttribute(attribute)) return true;
    }
    if (element.getAttribute("contenteditable") === "true" || element.getAttribute("aria-hidden") === "true") return true;
    return false;
  }
  function pushSeparator(state) {
    if (state.buffer.length === 0) return;
    if (WHITESPACE.test(state.buffer.charAt(state.buffer.length - 1))) return;
    state.buffer += " ";
    state.raw += " ";
  }
  function flattenRegion(root, loose) {
    const positions = [];
    const state = { raw: "", buffer: "" };
    const walk = (node) => {
      if (node.nodeType === 3) {
        const text2 = node;
        const data = text2.data;
        if (data.length === 0) return;
        const start = state.raw.length;
        for (const character of data) {
          state.raw += character;
          state.buffer += character;
        }
        positions.push({ node: text2, start, end: state.raw.length });
        return;
      }
      if (!isElement(node)) return;
      if (isExcludedElement(node)) return;
      const block = BLOCK_TAGS.has(node.tagName.toLowerCase());
      if (block) pushSeparator(state);
      for (const child of node.childNodes) {
        if (isElement(child) && child.tagName === "BR") {
          pushSeparator(state);
          continue;
        }
        walk(child);
      }
      if (block) pushSeparator(state);
    };
    walk(root);
    let text = "";
    const map = [];
    for (let index = 0; index < state.raw.length; index += 1) {
      const character = state.raw.charAt(index);
      if (WHITESPACE.test(character)) {
        if (text.length === 0 || text.charAt(text.length - 1) === " ") continue;
        text += " ";
        map.push(index);
        continue;
      }
      if (loose && LOOSE_SKIP.has(character)) continue;
      text += character;
      map.push(index);
    }
    const region = { root, raw: state.raw, positions, text, map };
    if (loose) {
      let tight = "";
      const tightMap = [];
      for (let index = 0; index < text.length; index += 1) {
        const character = text.charAt(index);
        const rawIndex = map[index];
        if (rawIndex === void 0) continue;
        if (WHITESPACE.test(character)) continue;
        tight += character;
        tightMap.push(rawIndex);
      }
      region.tight = { text: tight, map: tightMap };
    }
    return region;
  }
  function normalizeNeedle(text, loose) {
    let source = text.replace(/\r\n?/gu, "\n");
    if (loose) {
      source = source.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/<[^>]*>/gu, "").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&nbsp;/gu, " ");
    }
    let normalized = "";
    for (const character of source) {
      if (WHITESPACE.test(character)) {
        if (normalized.length === 0 || normalized.charAt(normalized.length - 1) === " ") continue;
        normalized += " ";
        continue;
      }
      if (loose && LOOSE_SKIP.has(character)) continue;
      normalized += character;
    }
    return normalized;
  }
  function tighten(needle) {
    let tight = "";
    for (const character of needle) {
      if (WHITESPACE.test(character)) continue;
      tight += character;
    }
    return tight;
  }
  function positionAt(positions, offset) {
    let low = 0;
    let high = positions.length - 1;
    let best;
    while (low <= high) {
      const middle = low + high >> 1;
      const candidate = positions[middle];
      if (candidate === void 0) break;
      if (candidate.start <= offset) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }
  function rawSpan(region, variant, span) {
    const startRaw = variant.map[span.start];
    if (startRaw === void 0) return null;
    const endRaw = span.end >= variant.map.length ? region.raw.length : variant.map[span.end];
    if (endRaw === void 0 || endRaw <= startRaw) return null;
    return { start: startRaw, end: endRaw };
  }
  function rangeFromSpan(region, variant, span) {
    const raw = rawSpan(region, variant, span);
    if (raw === null) return null;
    const startPosition = positionAt(region.positions, raw.start);
    const endPosition = positionAt(region.positions, Math.max(raw.start, raw.end - 1));
    if (startPosition === void 0 || endPosition === void 0) return null;
    const startOffset = Math.min(Math.max(0, raw.start - startPosition.start), startPosition.node.data.length);
    const endOffset = Math.min(Math.max(endPosition.start + 1, raw.end) - endPosition.start, endPosition.node.data.length);
    if (startOffset < 0 || endOffset < 0) return null;
    const range = document.createRange();
    try {
      range.setStart(startPosition.node, startOffset);
      range.setEnd(endPosition.node, endOffset);
    } catch {
      return null;
    }
    return range;
  }
  function findNormalizedSpan(region, normalized) {
    const trimmed = normalized.trim();
    if (trimmed === "") return null;
    const direct = region.text.indexOf(trimmed);
    if (direct !== -1) {
      const range2 = rangeFromSpan(region, { text: region.text, map: region.map }, { start: direct, end: direct + trimmed.length });
      if (range2 !== null) return { start: direct, end: direct + trimmed.length, variant: "text", range: range2 };
    }
    const tightNeedle = tighten(trimmed);
    const tight = region.tight;
    if (tight === void 0 || tightNeedle === "") return null;
    const tightIndex = tight.text.indexOf(tightNeedle);
    if (tightIndex === -1) return null;
    const range = rangeFromSpan(region, tight, { start: tightIndex, end: tightIndex + tightNeedle.length });
    if (range === null) return null;
    return { start: tightIndex, end: tightIndex + tightNeedle.length, variant: "tight", range };
  }
  function isRangeAlive(range) {
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false;
    try {
      return range.toString().length > 0;
    } catch {
      return false;
    }
  }

  // src/client/regions.ts
  var RESPONSE_MARKDOWN = '[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] [class*="markdown"]';
  var RESPONSE_NODE = '[data-chat-group-part="response"] [data-slot="conversation.chat.node"]';
  var ASSISTANT_STEP = '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])';
  var GENERIC_BLOCKS = "p, li, pre, table, tr, blockquote, h1, h2, h3, h4, h5, h6";
  var EXCLUDED_SUBTREE = [
    '[data-slot="sidebar"]',
    '[data-slot="rightbar"]',
    '[data-slot="shell.overlay"]',
    '[data-slot="conversation.composer"]',
    '[data-slot="conversation.input.dock"]',
    "[data-composer-dock]",
    "[data-composer-card]",
    "[data-lexical-editor]",
    "[data-sidebar-right-session]",
    "[data-sidebar-right-panel]",
    "[data-jev-highlight-ui]",
    "[data-code-block-banner]"
  ].join(",");
  var CONTAINER_SELECTORS = ["[data-conversation-scroll]", "[data-chat-flow]", '[data-conversation-region="chat"]', "main"];
  function findChatContainer(doc) {
    for (const selector of CONTAINER_SELECTORS) {
      const element = doc.querySelector(selector);
      if (element !== null) return element;
    }
    return null;
  }
  function isInExcludedSubtree(element) {
    return element.closest(EXCLUDED_SUBTREE) !== null;
  }
  function hasMeaningfulText(element) {
    if (element.textContent === null) return false;
    return element.textContent.trim().length > 0;
  }
  function outermost(elements) {
    return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
  }
  function usable(elements, container) {
    const result = [];
    for (const element of elements) {
      if (!element.isConnected) continue;
      if (isInExcludedSubtree(element)) continue;
      if (element.closest('[data-chat-flow-kind="tool-call"]') !== null) continue;
      if (element.closest('[data-chat-group-part="reasoning"]') !== null) continue;
      if (!hasMeaningfulText(element)) continue;
      if (container !== null && !container.contains(element)) continue;
      result.push(element);
    }
    return result;
  }
  function collectRegionRoots(doc) {
    const container = findChatContainer(doc);
    const markdown = usable(outermost([...doc.querySelectorAll(RESPONSE_MARKDOWN)]), container);
    if (markdown.length > 0) return markdown;
    const nodes = usable(outermost([...doc.querySelectorAll(RESPONSE_NODE)]), container);
    if (nodes.length > 0) return nodes;
    const steps = usable(outermost([...doc.querySelectorAll(ASSISTANT_STEP)]), container);
    if (steps.length > 0) return steps;
    const scopes = container === null ? [] : [container];
    for (const scope of scopes) {
      const blocks = [...scope.querySelectorAll(GENERIC_BLOCKS)].filter((element) => {
        if (isExcludedElement(element)) return false;
        if (isInExcludedSubtree(element)) return false;
        if (element.closest('[data-chat-group-part="reasoning"]') !== null) return false;
        if (element.closest('[data-chat-flow-kind="tool-call"]') !== null) return false;
        if (element.closest("table") !== null && element.tagName !== "TR") return false;
        if (element.tagName === "TR") return element.closest("table") !== null;
        return hasMeaningfulText(element);
      });
      const leaves = outermost(blocks.filter((element) => element.tagName !== "LI" || element.querySelector("p, ul, ol") === null));
      if (leaves.length > 0) return leaves;
    }
    return [];
  }

  // src/client/styles.ts
  var STYLE_ATTRIBUTE = "data-jev-highlight";
  var CHIP_CLASS = "jev-highlight-chip";
  var HIGHLIGHT_CSS = `
::highlight(jev-critical){
  background-color: rgba(255, 138, 0, 0.62);
  color: #1a1206;
}
::highlight(jev-medium){
  background-color: rgba(255, 190, 26, 0.42);
}
::highlight(jev-low){
  background-color: rgba(255, 214, 102, 0.18);
  text-decoration: underline dotted rgba(196, 132, 0, 0.9);
  text-underline-offset: 2px;
}
@media (prefers-color-scheme: dark){
  ::highlight(jev-critical){
    background-color: rgba(255, 145, 0, 0.52);
    color: #fff7ed;
  }
  ::highlight(jev-medium){
    background-color: rgba(255, 190, 26, 0.3);
  }
  ::highlight(jev-low){
    background-color: rgba(255, 214, 102, 0.12);
    text-decoration: underline dotted rgba(255, 200, 90, 0.9);
    text-underline-offset: 2px;
  }
}
.${CHIP_CLASS}{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  box-sizing: border-box;
}
.${CHIP_CLASS}[data-enabled="false"]{
  opacity: 0.55;
}
.${CHIP_CLASS} .jev-chip-label{
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.${CHIP_CLASS} .jev-chip-count{
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-variant-numeric: tabular-nums;
}
.${CHIP_CLASS} .jev-chip-dot{
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.${CHIP_CLASS} .jev-chip-dot[data-level="critical"]{
  background: #ff8a00;
}
.${CHIP_CLASS} .jev-chip-dot[data-level="medium"]{
  background: #e6aa18;
}
.${CHIP_CLASS} .jev-chip-dot[data-level="low"]{
  background: #b99b5e;
  opacity: 0.5;
}
.${CHIP_CLASS} .jev-chip-toggle{
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.${CHIP_CLASS} .jev-chip-toggle:hover{
  background: color-mix(in srgb, currentColor 24%, transparent);
}
.${CHIP_CLASS} .jev-chip-toggle[data-on="true"]{
  color: #0f7b46;
}
.${CHIP_CLASS} .jev-chip-status{
  font-size: 11px;
  opacity: 0.8;
}
`;

  // src/client/highlighter.ts
  var MAX_ATTEMPTS = 400;
  var MAX_REMEMBERED_UNITS = 2e3;
  function isLevel(value) {
    return value === "critical" || value === "medium" || value === "low";
  }
  function makeUnitRecord(verdict, level) {
    const loose = verdict.type !== "code_block";
    const source = typeof verdict.matchText === "string" && verdict.matchText !== "" ? verdict.matchText : verdict.text;
    const normalized = normalizeNeedle(source, loose);
    if (normalized.trim() === "") return null;
    return { seq: verdict.seq, unitId: verdict.unitId, level, loose, normalized, range: null, attempts: 0 };
  }
  function createHighlighter(options) {
    const { window: win } = options;
    const doc = win.document;
    const unsupported = options.unsupported;
    const registry = win.CSS?.highlights;
    const highlightCtor = win.Highlight;
    const units = /* @__PURE__ */ new Map();
    let enabled = true;
    let disposed = false;
    let style = null;
    let observer = null;
    let frameRequested = false;
    let frameHandle = null;
    let timeoutHandle = null;
    if (!unsupported) {
      style = doc.createElement("style");
      style.setAttribute(STYLE_ATTRIBUTE, "styles");
      style.textContent = HIGHLIGHT_CSS;
      if (doc.head !== null) doc.head.appendChild(style);
      const MutationObserverCtor = win.MutationObserver;
      if (MutationObserverCtor !== void 0) {
        observer = new MutationObserverCtor(() => scheduleRemap());
        const target = doc.body ?? doc.documentElement;
        if (target !== null) {
          try {
            observer.observe(target, { subtree: true, childList: true, characterData: true });
          } catch {
            observer = null;
          }
        } else {
          observer = null;
        }
      }
    }
    function scheduleRemap() {
      if (disposed || unsupported || frameRequested) return;
      frameRequested = true;
      const run = () => {
        frameRequested = false;
        frameHandle = null;
        timeoutHandle = null;
        if (disposed) return;
        try {
          remapInternal();
        } catch (error) {
          console.error("[jev-highlight] DOM remap failed", error);
        }
      };
      if (typeof win.requestAnimationFrame === "function") {
        frameHandle = win.requestAnimationFrame(run);
      } else if (typeof win.setTimeout === "function") {
        timeoutHandle = win.setTimeout(run, 16);
      } else {
        run();
      }
    }
    function rebuildHighlights() {
      if (unsupported || registry === void 0 || highlightCtor === void 0) return;
      for (const level of LEVELS) {
        const name = HIGHLIGHT_NAMES[level];
        if (!enabled) {
          registry.delete(name);
          continue;
        }
        const ranges = [];
        for (const record of units.values()) {
          if (record.level === level && record.range !== null && isRangeAlive(record.range)) ranges.push(record.range);
        }
        if (ranges.length === 0) {
          registry.delete(name);
          continue;
        }
        try {
          registry.set(name, new highlightCtor(...ranges));
        } catch (error) {
          console.error("[jev-highlight] failed to register highlight", name, error);
        }
      }
    }
    function remapInternal() {
      if (unsupported) return;
      if (!enabled) {
        rebuildHighlights();
        return;
      }
      const roots = collectRegionRoots(doc);
      const cache = { loose: /* @__PURE__ */ new Map(), verbatim: /* @__PURE__ */ new Map() };
      const flattened = (root, loose) => {
        const bucket = loose ? cache.loose : cache.verbatim;
        const existing = bucket.get(root);
        if (existing !== void 0) return existing;
        const created = flattenRegion(root, loose);
        bucket.set(root, created);
        return created;
      };
      const claimed = /* @__PURE__ */ new Set();
      const ordered = [...units.values()].sort((left, right) => left.seq - right.seq);
      for (const record of ordered) {
        if (record.range !== null && isRangeAlive(record.range)) {
          claimed.add(`${record.level}:alive`);
          continue;
        }
        record.range = null;
        if (record.attempts > MAX_ATTEMPTS) continue;
        let located = false;
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          if (root === void 0) continue;
          const region = flattened(root, record.loose);
          const span = findNormalizedSpan(region, record.normalized);
          if (span === null) continue;
          const key = `${record.loose ? "L" : "V"}:${index}:${span.variant}:${span.start}:${span.end}`;
          if (claimed.has(key)) {
            located = true;
            break;
          }
          claimed.add(key);
          record.range = span.range;
          record.attempts = 0;
          located = true;
          break;
        }
        if (!located) record.attempts += 1;
      }
      rebuildHighlights();
    }
    return {
      ingest(verdicts) {
        if (disposed || unsupported) return;
        let touched = false;
        for (const verdict of verdicts) {
          if (typeof verdict.unitId !== "string" || verdict.unitId === "") continue;
          if (!isLevel(verdict.level)) continue;
          const existing = units.get(verdict.unitId);
          if (existing !== void 0) {
            if (existing.level !== verdict.level) {
              existing.level = verdict.level;
              touched = true;
            }
            continue;
          }
          const record = makeUnitRecord(verdict, verdict.level);
          if (record === null) continue;
          units.set(record.unitId, record);
          touched = true;
        }
        if (units.size > MAX_REMEMBERED_UNITS) {
          const ordered = [...units.values()].sort((left, right) => left.seq - right.seq);
          const overflow = units.size - MAX_REMEMBERED_UNITS;
          for (let index = 0; index < overflow; index += 1) {
            const oldest = ordered[index];
            if (oldest === void 0) break;
            units.delete(oldest.unitId);
          }
        }
        if (touched) scheduleRemap();
      },
      reset() {
        units.clear();
        rebuildHighlights();
      },
      setEnabled(next) {
        if (disposed) return;
        enabled = next;
        if (enabled) scheduleRemap();
        else rebuildHighlights();
      },
      remap() {
        if (disposed) return;
        remapInternal();
      },
      stats() {
        let mapped = 0;
        let pending = 0;
        for (const record of units.values()) {
          if (record.range !== null && isRangeAlive(record.range)) mapped += 1;
          else pending += 1;
        }
        const names = {};
        if (registry !== void 0) {
          for (const level of LEVELS) {
            const name = HIGHLIGHT_NAMES[level];
            const entry = registry.get(name);
            names[name] = entry !== void 0 && entry !== null && typeof entry === "object" && Symbol.iterator in entry ? [...entry].length : 0;
          }
        }
        return { supported: !unsupported, enabled, names, units: units.size, mapped, pending };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (observer !== null) {
          try {
            observer.disconnect();
          } catch {
          }
          observer = null;
        }
        if (frameHandle !== null && typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(frameHandle);
        if (timeoutHandle !== null && typeof win.clearTimeout === "function") win.clearTimeout(timeoutHandle);
        frameHandle = null;
        timeoutHandle = null;
        if (registry !== void 0) {
          for (const level of LEVELS) {
            const name = HIGHLIGHT_NAMES[level];
            try {
              registry.delete(name);
            } catch {
            }
          }
        }
        if (style !== null) {
          style.remove();
          style = null;
        }
        units.clear();
      }
    };
  }
  function supportsHighlights(win) {
    return win.CSS?.highlights !== void 0 && typeof win.Highlight === "function";
  }

  // src/client/polling.ts
  var UNITS_VISIBLE_MS = 600;
  var UNITS_HIDDEN_MS = 2500;
  var STATE_VISIBLE_MS = 2500;
  var STATE_HIDDEN_MS = 8e3;
  var UNITS_FAILURE_MS = [800, 1500, 3e3, 4e3];
  var STATE_FAILURE_MS = [1500, 3e3, 6e3, 1e4];
  var UNITS_LIMIT = 100;
  var STATE_AFTER_UNITS_MS = 300;
  var MAX_DELAY_MS = 6e4;
  function toCounts(value) {
    const record = typeof value === "object" && value !== null ? value : {};
    const read = (key) => {
      const candidate = record[key];
      const parsed = typeof candidate === "number" ? candidate : Number(candidate);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
    };
    return { critical: read("critical"), medium: read("medium"), low: read("low") };
  }
  function isVerdict(value) {
    if (typeof value !== "object" || value === null) return false;
    const record = value;
    return typeof record.unitId === "string" && record.unitId !== "" && typeof record.text === "string" && typeof record.level === "string";
  }
  function createPoller(options) {
    const { window: win, api, highlighter, supported } = options;
    const doc = win.document;
    const listeners = /* @__PURE__ */ new Set();
    let state = {
      ready: false,
      supported,
      keyConfigured: true,
      enabled: true,
      counts: { critical: 0, medium: 0, low: 0 },
      model: "",
      busy: false,
      error: null
    };
    let disposed = false;
    let since = 0;
    let thresholdsSignature = null;
    let unitsFailures = 0;
    let stateFailures = 0;
    let unitsTimer = null;
    let stateTimer = null;
    let started = false;
    let dueStateRefresh = false;
    const notify = () => {
      if (disposed) return;
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("[jev-highlight] chip listener failed", error);
        }
      }
      options.onUpdate?.();
    };
    const hidden = () => doc.visibilityState === "hidden";
    function thresholdSignature(body) {
      const raw = body.thresholds;
      if (typeof raw !== "object" || raw === null) return null;
      const record = raw;
      const read = (key) => {
        const value = record[key];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      };
      const critical = read("critical");
      const medium = read("medium");
      const low = read("low");
      if (critical === null || medium === null || low === null) return null;
      return `${critical}/${medium}/${low}`;
    }
    function applyStateBody(body) {
      const countsSource = body.counts ?? body.state;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : void 0;
      const model = typeof body.model === "string" ? body.model : state.model;
      const keyConfigured = typeof body.keyConfigured === "boolean" ? body.keyConfigured : state.keyConfigured;
      const notice = typeof body.notice === "string" && body.notice !== "" ? body.notice : typeof body.error === "string" && body.error !== "" ? body.error : null;
      const ok = body.ok !== false;
      if (!ok) return;
      const signature = thresholdSignature(body);
      if (signature !== null) {
        const changed = thresholdsSignature !== null && signature !== thresholdsSignature;
        thresholdsSignature = signature;
        if (changed) {
          since = 0;
          highlighter.reset();
          scheduleUnits(0);
        }
      }
      state = {
        ...state,
        ready: true,
        keyConfigured,
        enabled: keyConfigured && (enabled ?? state.enabled),
        counts: countsSource === void 0 ? state.counts : toCounts(countsSource),
        model,
        error: notice
      };
      notify();
    }
    function scheduleUnits(delay) {
      if (disposed) return;
      if (unitsTimer !== null) win.clearTimeout(unitsTimer);
      unitsTimer = win.setTimeout(pullUnits, Math.min(MAX_DELAY_MS, Math.max(0, delay)));
    }
    function scheduleState(delay) {
      if (disposed) return;
      if (stateTimer !== null) win.clearTimeout(stateTimer);
      stateTimer = win.setTimeout(pullState, Math.min(MAX_DELAY_MS, Math.max(0, delay)));
    }
    async function pullUnits() {
      if (disposed) return;
      unitsTimer = null;
      let delay = hidden() ? UNITS_HIDDEN_MS : UNITS_VISIBLE_MS;
      try {
        const query = `units?since=${String(since)}&limit=${String(UNITS_LIMIT)}`;
        const body = await api.get(query);
        unitsFailures = 0;
        const rawUnits = body.units;
        const units = Array.isArray(rawUnits) ? rawUnits.filter(isVerdict) : [];
        const seq = typeof body.seq === "number" && Number.isFinite(body.seq) ? body.seq : null;
        if (seq !== null && seq > since) since = seq;
        if (units.length < UNITS_LIMIT && seq !== null && seq === since) {
        }
        if (units.length > 0) {
          highlighter.ingest(units);
          scheduleState(STATE_AFTER_UNITS_MS);
        }
        if (!state.ready) {
          delay = hidden() ? UNITS_HIDDEN_MS : UNITS_VISIBLE_MS;
        }
      } catch (error) {
        unitsFailures += 1;
        const backoff = UNITS_FAILURE_MS[Math.min(unitsFailures - 1, UNITS_FAILURE_MS.length - 1)] ?? UNITS_FAILURE_MS[0];
        delay = hidden() ? backoff * 3 : backoff;
        if (state.ready) {
          state = { ...state, error: error instanceof Error ? error.message : String(error) };
          notify();
        }
      }
      scheduleUnits(delay);
    }
    async function pullState() {
      if (disposed) return;
      stateTimer = null;
      dueStateRefresh = false;
      let delay = hidden() ? STATE_HIDDEN_MS : STATE_VISIBLE_MS;
      try {
        const body = await api.get("state");
        stateFailures = 0;
        applyStateBody(body);
      } catch (error) {
        stateFailures += 1;
        const backoff = STATE_FAILURE_MS[Math.min(stateFailures - 1, STATE_FAILURE_MS.length - 1)] ?? STATE_FAILURE_MS[0];
        delay = hidden() ? backoff * 2 : backoff;
        if (state.ready) {
          state = { ...state, error: error instanceof Error ? error.message : String(error) };
          notify();
        }
      }
      scheduleState(delay);
    }
    function refreshSoon() {
      if (dueStateRefresh) return;
      dueStateRefresh = true;
      scheduleState(STATE_AFTER_UNITS_MS);
    }
    function onVisibilityChange() {
      if (disposed) return;
      if (hidden()) {
        scheduleUnits(UNITS_HIDDEN_MS);
        scheduleState(STATE_HIDDEN_MS);
        return;
      }
      scheduleUnits(0);
      scheduleState(0);
    }
    return {
      start() {
        if (disposed || started) return;
        started = true;
        if (typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibilityChange);
        scheduleUnits(0);
        scheduleState(0);
      },
      refreshState() {
        refreshSoon();
      },
      toggle() {
        if (disposed || state.busy) return;
        state = { ...state, busy: true };
        notify();
        void (async () => {
          try {
            const body = await api.post("toggle", { enabled: !state.enabled });
            const rawState = typeof body.state === "object" && body.state !== null ? body.state : null;
            const nextEnabled = typeof body.enabled === "boolean" ? body.enabled : rawState !== null && typeof rawState.enabled === "boolean" ? rawState.enabled : !state.enabled;
            state = {
              ...state,
              enabled: nextEnabled,
              counts: rawState !== null && rawState.counts !== void 0 ? toCounts(rawState.counts) : state.counts,
              model: rawState !== null && typeof rawState.model === "string" ? rawState.model : state.model,
              error: null
            };
            highlighter.setEnabled(nextEnabled);
          } catch (error) {
            state = { ...state, error: error instanceof Error ? error.message : String(error) };
          } finally {
            state = { ...state, busy: false };
            notify();
            refreshSoon();
          }
        })();
      },
      getState() {
        return { ...state, counts: { ...state.counts } };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibilityChange);
        if (unitsTimer !== null) win.clearTimeout(unitsTimer);
        if (stateTimer !== null) win.clearTimeout(stateTimer);
        unitsTimer = null;
        stateTimer = null;
        listeners.clear();
      }
    };
  }

  // src/client/chip.ts
  var ZH = {
    "chip.label": "Jev",
    "chip.title": "Jev \u91CD\u70B9\u9AD8\u4EAE",
    "chip.toggleAria": "\u5F00\u542F\u6216\u5173\u95ED Jev \u91CD\u70B9\u9AD8\u4EAE",
    "chip.on": "\u5F00",
    "chip.off": "\u5173",
    "chip.enabled": "\u9AD8\u4EAE\u5DF2\u5F00\u542F",
    "chip.disabled": "\u9AD8\u4EAE\u5DF2\u5173\u95ED",
    "chip.critical": "\u91CD\u70B9",
    "chip.medium": "\u4E2D\u7B49",
    "chip.low": "\u5F31",
    "chip.counts": "\u91CD\u70B9 {critical} \xB7 \u4E2D\u7B49 {medium} \xB7 \u5F31 {low}",
    "chip.unsupported": "\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u9AD8\u4EAE",
    "chip.waiting": "\u7B49\u5F85 Host\u2026",
    "chip.noKey": "\u7F3A API key",
    "chip.error": "\u8DEF\u7531\u9519\u8BEF\uFF1A{error}",
    "chip.model": "\u6A21\u578B\uFF1A{model}",
    "settings.tab": "Jev \u9AD8\u4EAE",
    "settings.title": "Jev \u91CD\u70B9\u9AD8\u4EAE",
    "settings.intro": "\u7528 StartLux\uFF08\u56FD\u4EA7\u51B3\u7B56\u6A21\u578B\uFF0CBamboo Relay\uFF09\u6216 TypeSafe Jev \u5224\u65AD agent \u6D41\u5F0F\u8F93\u51FA\u4E2D\u7684\u91CD\u70B9\u5185\u5BB9\uFF0C\u5E76\u6309\u7F6E\u4FE1\u5EA6\u5F3A\u5EA6\u9AD8\u4EAE\u3002API Key \u53EA\u5199\u5165\u5BBF\u4E3B\uFF0C\u4E0D\u4F1A\u8FD4\u56DE\u6D4F\u89C8\u5668\u3002",
    "settings.loading": "\u8BFB\u53D6\u4E2D\u2026",
    "settings.provider": "\u63D0\u4F9B\u65B9",
    "settings.startlux": "StartLux-Decision\uFF08Bamboo Relay\uFF09",
    "settings.jev": "TypeSafe Jev",
    "settings.model": "\u6A21\u578B",
    "settings.endpoint": "\u63A5\u53E3",
    "settings.thinkMode": "\u601D\u8003\u6A21\u5F0F",
    "settings.thinkLabel": "\u601D\u8003\u6A21\u5F0F",
    "settings.think.never": "never\uFF08\u6700\u5FEB\uFF09",
    "settings.think.auto": "auto\uFF08\u4E0D\u786E\u5B9A\u624D\u601D\u8003\uFF09",
    "settings.think.always": "always\uFF08\u6BCF\u9898\u90FD\u601D\u8003\uFF09",
    "settings.thinkDefaultLabel": "\u9ED8\u8BA4",
    "settings.thinkHint": "never \u6700\u5FEB\uFF08\u7EA6 1s/\u8BF7\u6C42\uFF09\uFF1Bauto \u53EA\u5728 top<0.6 \u65F6\u601D\u8003\uFF08\u7EA6 3\u20134s\uFF09\uFF1Balways \u6BCF\u9898\u90FD\u601D\u8003\uFF08\u7EA6 5\u20136s\uFF09\u3002\u4FEE\u6539\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002",
    "settings.thinkSaved": "\u601D\u8003\u6A21\u5F0F\u5DF2\u5207\u6362\u4E3A {mode}\uFF0C\u7ACB\u5373\u751F\u6548\u3002",
    "settings.thinkFailed": "\u5207\u6362\u601D\u8003\u6A21\u5F0F\u5931\u8D25\uFF1A{error}",
    "settings.thresholds": "\u9AD8\u4EAE\u9608\u503C",
    "settings.thresholdCritical": "\u91CD\u70B9 critical \u2265",
    "settings.thresholdMedium": "\u4E2D\u7B49 medium \u2265",
    "settings.thresholdLow": "\u5F31 low \u2265",
    "settings.presetSensitive": "\u654F\u611F preset",
    "settings.presetConservative": "\u4FDD\u5B88 preset",
    "settings.presetDefault": "\u6062\u590D\u9ED8\u8BA4",
    "settings.thresholdsSave": "\u4FDD\u5B58\u9608\u503C",
    "settings.thresholdsSource": "\u5F53\u524D\u6765\u6E90",
    "settings.thresholdsSourceSettings": "\u8BBE\u7F6E\u9875\u8986\u76D6",
    "settings.thresholdsSourceConfig": "\u914D\u7F6E\u9ED8\u8BA4\uFF08\u654F\u611F preset\uFF09",
    "settings.thresholdsDirty": "\u6709\u672A\u4FDD\u5B58\u4FEE\u6539",
    "settings.thresholdsHint": "\u53D6\u503C 0\u20131\uFF0C\u9700\u6EE1\u8DB3 critical \u2265 medium \u2265 low\u3002\u4FDD\u5B58\u540E\u4F1A\u91CD\u7B97\u5DF2\u5224\u5B9A\u5185\u5BB9\u7684\u6863\u4F4D\u5E76\u7ACB\u5373\u5237\u65B0\u9AD8\u4EAE\uFF1B\u6062\u590D\u9ED8\u8BA4\u4F1A\u5220\u9664\u8BBE\u7F6E\u9875\u8986\u76D6\uFF0C\u56DE\u5230\u914D\u7F6E\u9ED8\u8BA4\u3002StartLux \u9ED8\u8BA4 .52/.37/.24\uFF0CJev \u9ED8\u8BA4 .85/.65/.45\u3002",
    "settings.thresholdsSaved": "\u9608\u503C\u5DF2\u4FDD\u5B58\uFF0C\u5DF2\u6709\u9AD8\u4EAE\u5DF2\u6309\u65B0\u9608\u503C\u91CD\u7B97\u3002",
    "settings.thresholdsReset": "\u5DF2\u6062\u590D\u9ED8\u8BA4\u9608\u503C\u3002",
    "settings.thresholdsInvalid": "\u9608\u503C\u5FC5\u987B\u662F 0\u20131 \u7684\u6570\u5B57\uFF0C\u4E14 critical \u2265 medium \u2265 low\u3002",
    "settings.thresholdsFailed": "\u9608\u503C\u4FDD\u5B58\u5931\u8D25\uFF1A{error}",
    "settings.keyStatus": "API Key",
    "settings.keyConfigured": "\u5DF2\u914D\u7F6E",
    "settings.keyMissing": "\u672A\u914D\u7F6E",
    "settings.keyFile": "Key \u6587\u4EF6",
    "settings.keyHelp": "\u5728\u8FD9\u91CC\u7C98\u8D34 Bamboo / StartLux API Key\uFF08\u901A\u5E38\u4EE5 bk- \u5F00\u5934\uFF09\uFF0C\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002",
    "settings.jevKeyHelp": "\u5F53\u524D\u4F7F\u7528 TypeSafe Jev\uFF1A\u8BF7\u5728\u542F\u52A8\u73AF\u5883\u91CC\u8BBE\u7F6E JEV_API_KEY\uFF0C\u6216\u5199\u5165 $DSH_HOME/.credentials.yaml \u7684 jevApiKey\uFF08\u672C\u9875\u7684 Key \u8F93\u5165\u53EA\u7528\u4E8E StartLux\uFF09\u3002",
    "settings.keyPlaceholder": "\u7C98\u8D34 StartLux / Bamboo API Key",
    "settings.show": "\u663E\u793A",
    "settings.hide": "\u9690\u85CF",
    "settings.save": "\u4FDD\u5B58",
    "settings.clear": "\u6E05\u9664",
    "settings.check": "\u6D4B\u8BD5\u8FDE\u63A5",
    "settings.saved": "API Key \u5DF2\u4FDD\u5B58\uFF0C\u5224\u65AD\u5DF2\u542F\u7528\u3002",
    "settings.cleared": "API Key \u5DF2\u6E05\u9664\uFF0C\u5224\u65AD\u5DF2\u6682\u505C\u3002",
    "settings.saveFailed": "\u4FDD\u5B58\u5931\u8D25\uFF1A{error}",
    "settings.requestFailed": "\u8BF7\u6C42\u5931\u8D25\uFF1A{error}",
    "settings.checkOk": "\u8FDE\u63A5\u6B63\u5E38\uFF1A{latency}ms\uFF0C\u6A21\u578B {model}\uFF0C\u5065\u5EB7\u95EE\u9898 P(yes)={answer}",
    "settings.checkFailed": "\u8FDE\u63A5\u5931\u8D25\uFF1A{error}",
    "settings.needSaveFirst": "\u8BF7\u5148\u5728\u4E0A\u65B9\u7C98\u8D34 API Key \u5E76\u70B9\u51FB\u201C\u4FDD\u5B58\u201D\uFF08\u6216\u76F4\u63A5\u70B9\u201C\u6D4B\u8BD5\u8FDE\u63A5\u201D\uFF0C\u4F1A\u81EA\u52A8\u5148\u4FDD\u5B58\uFF09\u3002",
    "settings.unknownError": "\u672A\u77E5\u9519\u8BEF",
    "settings.securityHint": "Key \u4EE5 0600\uFF08\u5C3D\u529B\uFF09\u5199\u5165\u672C\u673A key \u6587\u4EF6\uFF1B\u754C\u9762\u4E0E\u65E5\u5FD7\u90FD\u4E0D\u4F1A\u56DE\u663E\u3002"
  };
  var EN = {
    "chip.label": "Jev",
    "chip.title": "Jev importance highlight",
    "chip.toggleAria": "Toggle Jev importance highlight",
    "chip.on": "On",
    "chip.off": "Off",
    "chip.enabled": "Highlight enabled",
    "chip.disabled": "Highlight disabled",
    "chip.critical": "critical",
    "chip.medium": "medium",
    "chip.low": "low",
    "chip.counts": "critical {critical} \xB7 medium {medium} \xB7 low {low}",
    "chip.unsupported": "Highlight API unsupported",
    "chip.waiting": "Waiting for host\u2026",
    "chip.noKey": "API key missing",
    "chip.error": "route error: {error}",
    "chip.model": "model: {model}",
    "settings.tab": "Jev Highlight",
    "settings.title": "Jev importance highlight",
    "settings.intro": "Judge important streamed agent content with StartLux (domestic decision model via Bamboo Relay) or TypeSafe Jev, then highlight it by confidence. The API key is written host-side only and never returned to the browser.",
    "settings.loading": "Loading\u2026",
    "settings.provider": "Provider",
    "settings.startlux": "StartLux-Decision (Bamboo Relay)",
    "settings.jev": "TypeSafe Jev",
    "settings.model": "Model",
    "settings.endpoint": "Endpoint",
    "settings.thinkMode": "Think mode",
    "settings.thinkLabel": "Think mode",
    "settings.think.never": "never (fastest)",
    "settings.think.auto": "auto (only when unsure)",
    "settings.think.always": "always (every question)",
    "settings.thinkDefaultLabel": "Default",
    "settings.thinkHint": "never \u22481s/request; auto thinks only when top<0.6 (\u22483\u20134s); always thinks on every question (\u22485\u20136s). Changes apply immediately, no restart.",
    "settings.thinkSaved": "Think mode switched to {mode}; applied immediately.",
    "settings.thinkFailed": "Failed to switch think mode: {error}",
    "settings.thresholds": "Highlight thresholds",
    "settings.thresholdCritical": "critical \u2265",
    "settings.thresholdMedium": "medium \u2265",
    "settings.thresholdLow": "low \u2265",
    "settings.presetSensitive": "Sensitive preset",
    "settings.presetConservative": "Conservative preset",
    "settings.presetDefault": "Restore default",
    "settings.thresholdsSave": "Save thresholds",
    "settings.thresholdsSource": "Source",
    "settings.thresholdsSourceSettings": "Settings override",
    "settings.thresholdsSourceConfig": "Config default (sensitive preset)",
    "settings.thresholdsDirty": "unsaved changes",
    "settings.thresholdsHint": "Values 0\u20131 with critical \u2265 medium \u2265 low. Saving re-levels existing verdicts and refreshes highlights immediately; Restore default removes the Settings override. StartLux default .52/.37/.24, Jev default .85/.65/.45.",
    "settings.thresholdsSaved": "Thresholds saved; existing highlights re-levelled.",
    "settings.thresholdsReset": "Restored the default thresholds.",
    "settings.thresholdsInvalid": "Thresholds must be numbers in 0\u20131 with critical \u2265 medium \u2265 low.",
    "settings.thresholdsFailed": "Failed to save thresholds: {error}",
    "settings.keyStatus": "API key",
    "settings.keyConfigured": "Configured",
    "settings.keyMissing": "Missing",
    "settings.keyFile": "Key file",
    "settings.keyHelp": "Paste the Bamboo / StartLux API key here (usually starts with bk-). Saving takes effect immediately, no restart.",
    "settings.jevKeyHelp": "TypeSafe Jev is active: set JEV_API_KEY in the launching environment or write jevApiKey into $DSH_HOME/.credentials.yaml (this input only stores StartLux keys).",
    "settings.keyPlaceholder": "Paste StartLux / Bamboo API key",
    "settings.show": "Show",
    "settings.hide": "Hide",
    "settings.save": "Save",
    "settings.clear": "Clear",
    "settings.check": "Test connection",
    "settings.saved": "API key saved; judging is enabled.",
    "settings.cleared": "API key cleared; judging is paused.",
    "settings.saveFailed": "Save failed: {error}",
    "settings.requestFailed": "Request failed: {error}",
    "settings.checkOk": "Endpoint OK: {latency}ms, model {model}, health P(yes)={answer}",
    "settings.checkFailed": "Connection failed: {error}",
    "settings.needSaveFirst": "Paste the API key above and click Save first (or click Test connection, which saves it automatically).",
    "settings.unknownError": "unknown error",
    "settings.securityHint": "The key is written to a local key file (mode 0600, best effort); the UI and logs never echo it."
  };
  var DICTS = { zh: ZH, "zh-CN": ZH, en: EN };
  function format(template, params) {
    if (params === void 0) return template;
    return template.replace(/\{(\w+)\}/gu, (match, token) => {
      const value = params[token];
      return value === void 0 ? match : String(value);
    });
  }
  function guessLanguage() {
    const language = typeof navigator === "object" && navigator !== null && typeof navigator.language === "string" ? navigator.language : "en";
    return language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  function createTranslator(locale) {
    const fallbackDictionary = guessLanguage() === "zh" ? ZH : EN;
    if (locale !== void 0 && typeof locale.bind === "function") {
      try {
        const bound = locale.bind(NS);
        if (typeof bound === "function") {
          return (key, params) => {
            try {
              const value = bound(key);
              if (typeof value === "string" && value !== key) return format(value, params);
            } catch {
            }
            const fallback = fallbackDictionary[key] ?? EN[key] ?? key;
            return format(fallback, params);
          };
        }
      } catch {
      }
    }
    return (key, params) => format(fallbackDictionary[key] ?? EN[key] ?? key, params);
  }
  function renderCount(React, key, level, label, count, title) {
    return React.createElement(
      "span",
      { key, className: "jev-chip-count", title, "aria-label": `${title} ${String(count)}` },
      React.createElement("span", { className: "jev-chip-dot", "data-level": level, "aria-hidden": "true" }),
      React.createElement("span", null, String(count))
    );
  }
  function createChipComponent(React, initialTranslator, controllerArg) {
    return function JevHighlightChip(slotProps) {
      const controller = controllerArg ?? slotProps?.controller;
      const t = slotProps !== void 0 && typeof slotProps.t === "function" ? slotProps.t : initialTranslator;
      const [view, setView] = React.useState(() => controller === void 0 ? null : controller.getState());
      React.useEffect(() => {
        if (controller === void 0) return void 0;
        return controller.subscribe(() => {
          setView(controller.getState());
        });
      }, [controller]);
      if (controller === void 0 || view === null) return null;
      const on = view.enabled;
      const status = !view.supported ? t("chip.unsupported") : !view.keyConfigured ? t("chip.noKey") : !view.ready ? t("chip.waiting") : null;
      const titleParts = [t("chip.title"), on ? t("chip.enabled") : t("chip.disabled")];
      if (!view.keyConfigured) titleParts.push(t("chip.noKey"));
      if (view.model !== "") titleParts.push(t("chip.model", { model: view.model }));
      if (view.error !== null) titleParts.push(t("chip.error", { error: view.error }));
      const title = titleParts.join(" \xB7 ");
      const children = [
        React.createElement("span", { key: "label", className: "jev-chip-label" }, t("chip.label"))
      ];
      if (status !== null) {
        children.push(React.createElement("span", { key: "status", className: "jev-chip-status" }, status));
      } else {
        children.push(renderCount(React, "count-critical", "critical", t("chip.critical"), view.counts.critical, t("chip.critical")));
        children.push(renderCount(React, "count-medium", "medium", t("chip.medium"), view.counts.medium, t("chip.medium")));
        children.push(renderCount(React, "count-low", "low", t("chip.low"), view.counts.low, t("chip.low")));
      }
      children.push(
        React.createElement(
          "button",
          {
            key: "toggle",
            type: "button",
            className: "jev-chip-toggle",
            "data-on": on ? "true" : "false",
            disabled: view.busy || !view.keyConfigured,
            "aria-label": t("chip.toggleAria"),
            "aria-pressed": on ? "true" : "false",
            onClick: (event) => {
              if (typeof event === "object" && event !== null && "stopPropagation" in event && typeof event.stopPropagation === "function") {
                ;
                event.stopPropagation();
              }
              if (!view.busy && view.keyConfigured) controller.toggle();
            }
          },
          view.busy ? "\u2026" : !view.keyConfigured ? t("chip.noKey") : on ? t("chip.on") : t("chip.off")
        )
      );
      return React.createElement(
        "div",
        {
          className: CHIP_CLASS,
          "data-jev-highlight-ui": "",
          "data-enabled": on ? "true" : "false",
          "data-supported": view.supported ? "true" : "false",
          "data-key-configured": view.keyConfigured ? "true" : "false",
          "data-ready": view.ready ? "true" : "false",
          title,
          role: "group",
          "aria-label": title
        },
        ...children
      );
    };
  }

  // src/client/settings.ts
  var CSS = `
.jev-settings{display:flex;flex-direction:column;gap:16px;max-width:760px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary)}
.jev-settings h2{margin:0;font-size:16px;line-height:1.4;font-weight:600}
.jev-settings p{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.jev-settings-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;background:var(--dsw-alias-bg-base)}
.jev-settings-row{display:grid;grid-template-columns:132px minmax(0,1fr);gap:8px;font-size:13px;line-height:1.5;align-items:start}
.jev-settings-key{color:var(--dsw-alias-label-secondary)}
.jev-settings-value{word-break:break-all;font-variant-numeric:tabular-nums}
.jev-settings-status{display:inline-flex;align-items:center;gap:6px;font-weight:600}
.jev-settings-status[data-ok="true"]{color:#0f7b46}
.jev-settings-status[data-ok="false"]{color:#b45309}
.jev-settings-inputRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.jev-settings input[type=password],.jev-settings input[type=text]{flex:1 1 280px;min-width:0;height:32px;padding:0 10px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px}
.jev-settings button{height:30px;padding:0 12px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.jev-settings button:hover:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent)}
.jev-settings button:disabled{opacity:.55;cursor:default}
.jev-settings button[data-primary="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 46%,transparent)}
.jev-settings-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c)}
.jev-settings-message{font-size:12px;line-height:1.5;padding:8px 10px;border-radius:7px;background:color-mix(in srgb,currentColor 7%,transparent)}
.jev-settings-message[data-kind="error"]{color:#b45309}
.jev-settings-message[data-kind="ok"]{color:#0f7b46}
.jev-settings-modeRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}
.jev-settings-modeBtn[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 50%,transparent);font-weight:600}
.jev-settings-thresholdRow{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;font-size:13px}
.jev-settings-thresholdRow label{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary)}
.jev-settings-thresholdRow input{width:92px;height:30px;padding:0 8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;font-variant-numeric:tabular-nums}
.jev-settings-thresholdSource{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c)}
`;
  function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function readProvider(value) {
    const record = asRecord(value);
    if (record === null) return null;
    const provider = typeof record.provider === "string" ? record.provider : "";
    if (provider === "") return null;
    return {
      provider,
      model: typeof record.model === "string" ? record.model : "",
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
      endpointPath: typeof record.endpointPath === "string" ? record.endpointPath : "",
      thinkMode: typeof record.thinkMode === "string" ? record.thinkMode : "",
      keyConfigured: record.keyConfigured === true,
      keySource: typeof record.keySource === "string" ? record.keySource : null,
      keyFile: typeof record.keyFile === "string" ? record.keyFile : "",
      keyRequired: record.keyRequired === true,
      thresholds: readThresholds(record.thresholds),
      thresholdsSource: record.thresholdsSource === "settings" ? "settings" : "config"
    };
  }
  var DEFAULT_THRESHOLD_VIEW = { critical: 0.52, medium: 0.37, low: 0.24 };
  function readThresholds(value) {
    const record = asRecord(value);
    if (record === null) return { ...DEFAULT_THRESHOLD_VIEW };
    const read = (key) => {
      const candidate = record[key];
      return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : DEFAULT_THRESHOLD_VIEW[key];
    };
    return { critical: read("critical"), medium: read("medium"), low: read("low") };
  }
  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function createSettingsComponent(React, api, t) {
    return function JevHighlightSettings() {
      const [provider, setProvider] = React.useState(null);
      const [draft, setDraft] = React.useState("");
      const [reveal, setReveal] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [check, setCheck] = React.useState(null);
      const [thresholds, setThresholds] = React.useState({
        critical: "",
        medium: "",
        low: "",
        dirty: false
      });
      const refresh = async () => {
        try {
          const body = await api.get("provider");
          const next = readProvider(body.provider);
          if (next !== null) setProvider(next);
          if (next !== null) {
            setThresholds(
              (previous) => previous.dirty ? previous : {
                critical: String(next.thresholds.critical),
                medium: String(next.thresholds.medium),
                low: String(next.thresholds.low),
                dirty: false
              }
            );
          }
        } catch {
        }
      };
      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => {
          void refresh();
        }, 5e3);
        return () => {
          clearInterval(timer);
        };
      }, [api]);
      const run = async (operation) => {
        if (busy) return;
        setBusy(true);
        try {
          await operation();
        } catch (error) {
          setMessage({ kind: "error", text: t("settings.requestFailed", { error: errorText(error) }) });
        } finally {
          setBusy(false);
        }
      };
      const saveDraft = async () => {
        const body = await api.post("key", { action: "save", key: draft });
        const status = readProvider(body.provider);
        if (status !== null) setProvider(status);
        if (body.ok === true) {
          setDraft("");
          setCheck(null);
          setMessage({ kind: "ok", text: t("settings.saved") });
          await refresh();
          return true;
        }
        setMessage({
          kind: "error",
          text: t("settings.saveFailed", { error: typeof body.error === "string" ? body.error : t("settings.unknownError") })
        });
        return false;
      };
      const save = () => {
        if (draft.trim() === "") return;
        void run(async () => {
          await saveDraft();
        });
      };
      const clear = () => {
        void run(async () => {
          const body = await api.post("key", { action: "clear" });
          const status = readProvider(body.provider);
          if (status !== null) setProvider(status);
          setDraft("");
          setCheck(null);
          setMessage(
            body.ok === true ? { kind: "ok", text: t("settings.cleared") } : { kind: "error", text: t("settings.saveFailed", { error: typeof body.error === "string" ? body.error : t("settings.unknownError") }) }
          );
        });
      };
      const applyThresholdStatus = (body) => {
        const status = readProvider(body.provider);
        if (status !== null) setProvider(status);
        const values = readThresholds(body.thresholds);
        setThresholds({ critical: String(values.critical), medium: String(values.medium), low: String(values.low), dirty: false });
      };
      const presetThresholds = (critical, medium, low) => {
        setThresholds({ critical: String(critical), medium: String(medium), low: String(low), dirty: true });
      };
      const saveThresholds = () => {
        const numbers = {
          critical: Number(thresholds.critical),
          medium: Number(thresholds.medium),
          low: Number(thresholds.low)
        };
        if (!Number.isFinite(numbers.critical) || !Number.isFinite(numbers.medium) || !Number.isFinite(numbers.low)) {
          setMessage({ kind: "error", text: t("settings.thresholdsInvalid") });
          return;
        }
        void run(async () => {
          const body = await api.post("thresholds", numbers);
          if (body.ok === true) {
            applyThresholdStatus(body);
            setMessage({ kind: "ok", text: t("settings.thresholdsSaved") });
          } else {
            setMessage({
              kind: "error",
              text: t("settings.thresholdsFailed", { error: typeof body.error === "string" ? body.error : t("settings.unknownError") })
            });
          }
        });
      };
      const resetThresholds = () => {
        void run(async () => {
          const body = await api.post("thresholds", { action: "reset" });
          if (body.ok === true) {
            applyThresholdStatus(body);
            setMessage({ kind: "ok", text: t("settings.thresholdsReset") });
          } else {
            setMessage({
              kind: "error",
              text: t("settings.thresholdsFailed", { error: typeof body.error === "string" ? body.error : t("settings.unknownError") })
            });
          }
        });
      };
      const test = () => {
        void run(async () => {
          if (provider !== null && !provider.keyConfigured) {
            if (draft.trim() === "") {
              setMessage({ kind: "error", text: t("settings.needSaveFirst") });
              return;
            }
            const saved = await saveDraft();
            if (!saved) return;
          }
          const body = await api.post("check", {});
          const result = {
            ok: body.ok === true,
            provider: typeof body.provider === "string" ? body.provider : void 0,
            model: typeof body.model === "string" ? body.model : void 0,
            latencyMs: typeof body.latencyMs === "number" ? body.latencyMs : void 0,
            modelReturned: typeof body.modelReturned === "string" ? body.modelReturned : void 0,
            answer: typeof body.answer === "number" ? body.answer : void 0,
            error: typeof body.error === "string" ? body.error : void 0
          };
          setCheck(result);
        });
      };
      const selectThinkMode = (mode) => {
        void run(async () => {
          const body = await api.post("think", { mode });
          const status = readProvider(body.provider);
          if (status !== null) setProvider(status);
          if (body.ok === true) {
            setMessage({
              kind: "ok",
              text: t("settings.thinkSaved", { mode: mode === "default" ? t("settings.thinkDefaultLabel") : t(`settings.think.${mode}`) })
            });
          } else {
            setMessage({
              kind: "error",
              text: t("settings.thinkFailed", {
                error: typeof body.error === "string" ? body.error : t("settings.unknownError")
              })
            });
          }
        });
      };
      const providerLabel = provider === null ? t("settings.loading") : provider.provider === "startlux" ? t("settings.startlux") : t("settings.jev");
      const statusOk = provider !== null && provider.keyConfigured;
      const isStartLux = provider !== null && provider.provider === "startlux";
      const rows = [];
      const row = (key, value) => {
        rows.push(
          React.createElement(
            "div",
            { className: "jev-settings-row", key },
            React.createElement("span", { className: "jev-settings-key" }, t(key)),
            React.createElement("span", { className: "jev-settings-value" }, value)
          )
        );
      };
      row("settings.provider", providerLabel);
      if (provider !== null) {
        row("settings.model", provider.model);
        row("settings.endpoint", `${provider.baseUrl}${provider.endpointPath}`);
        if (provider.provider === "startlux") row("settings.thinkMode", t(`settings.think.${provider.thinkMode}`));
        row(
          "settings.keyStatus",
          React.createElement(
            "span",
            { className: "jev-settings-status", "data-ok": statusOk ? "true" : "false" },
            statusOk ? t("settings.keyConfigured") : t("settings.keyMissing"),
            provider.keySource !== null ? React.createElement("span", { className: "jev-settings-hint" }, ` \xB7 ${provider.keySource}`) : null
          )
        );
        if (provider.provider === "startlux") row("settings.keyFile", provider.keyFile);
      }
      const checkNode = check === null ? null : React.createElement(
        "div",
        { className: "jev-settings-message", "data-kind": check.ok ? "ok" : "error", key: "check" },
        check.ok ? t("settings.checkOk", {
          latency: check.latencyMs !== void 0 ? String(check.latencyMs) : "?",
          model: check.modelReturned !== void 0 ? check.modelReturned : check.model !== void 0 ? check.model : "",
          answer: check.answer !== void 0 ? check.answer.toFixed(3) : "n/a"
        }) : t("settings.checkFailed", {
          error: check.error !== void 0 && /No StartLux API key|not configured/iu.test(check.error) ? t("settings.needSaveFirst") : check.error !== void 0 ? check.error : t("settings.unknownError")
        })
      );
      return React.createElement(
        "div",
        { className: "jev-settings" },
        React.createElement("style", { key: "style" }, CSS),
        React.createElement("h2", null, t("settings.title")),
        React.createElement("p", null, t("settings.intro")),
        React.createElement("div", { className: "jev-settings-card" }, ...rows),
        React.createElement(
          "div",
          { className: "jev-settings-card" },
          React.createElement("p", null, isStartLux ? t("settings.keyHelp") : t("settings.jevKeyHelp")),
          React.createElement(
            "div",
            { className: "jev-settings-inputRow" },
            React.createElement("input", {
              type: reveal ? "text" : "password",
              value: draft,
              placeholder: t("settings.keyPlaceholder"),
              autoComplete: "new-password",
              spellCheck: false,
              disabled: busy || !isStartLux,
              onChange: (event) => {
                setDraft(typeof event?.target?.value === "string" ? event.target.value : "");
              },
              onKeyDown: (event) => {
                if (event?.key !== "Enter" || busy || !isStartLux || draft.trim() === "") return;
                if (typeof event.preventDefault === "function") event.preventDefault();
                save();
              }
            }),
            React.createElement(
              "button",
              { type: "button", disabled: busy || !isStartLux, onClick: () => setReveal(!reveal) },
              reveal ? t("settings.hide") : t("settings.show")
            ),
            React.createElement(
              "button",
              { type: "button", "data-primary": "true", disabled: busy || !isStartLux || draft.trim() === "", onClick: save },
              t("settings.save")
            ),
            React.createElement("button", { type: "button", disabled: busy || !isStartLux, onClick: clear }, t("settings.clear")),
            React.createElement("button", { type: "button", disabled: busy || provider === null, onClick: test }, t("settings.check"))
          ),
          React.createElement("div", { className: "jev-settings-hint" }, t("settings.securityHint")),
          isStartLux ? React.createElement(
            "div",
            { className: "jev-settings-modeRow", key: "think-mode" },
            React.createElement("span", { className: "jev-settings-key" }, t("settings.thinkLabel")),
            ...["never", "auto", "always"].map(
              (mode) => React.createElement(
                "button",
                {
                  type: "button",
                  className: "jev-settings-modeBtn",
                  key: mode,
                  "data-active": provider?.thinkMode === mode ? "true" : "false",
                  disabled: busy,
                  onClick: () => selectThinkMode(mode)
                },
                t(`settings.think.${mode}`)
              )
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "jev-settings-modeBtn",
                key: "default",
                disabled: busy,
                onClick: () => selectThinkMode("default")
              },
              t("settings.thinkDefaultLabel")
            )
          ) : null,
          isStartLux ? React.createElement("div", { className: "jev-settings-hint" }, t("settings.thinkHint")) : null,
          React.createElement(
            "div",
            { className: "jev-settings-card", key: "thresholds" },
            React.createElement("p", null, t("settings.thresholds")),
            React.createElement(
              "div",
              { className: "jev-settings-thresholdRow" },
              ...[
                ["critical", t("settings.thresholdCritical")],
                ["medium", t("settings.thresholdMedium")],
                ["low", t("settings.thresholdLow")]
              ].map(
                ([key, label]) => React.createElement(
                  "label",
                  { key },
                  label,
                  React.createElement("input", {
                    type: "number",
                    min: "0",
                    max: "1",
                    step: "0.01",
                    value: thresholds[key],
                    disabled: busy,
                    onChange: (event) => {
                      const value = typeof event?.target?.value === "string" ? event.target.value : "";
                      setThresholds((previous) => ({ ...previous, [key]: value, dirty: true }));
                    }
                  })
                )
              )
            ),
            React.createElement(
              "div",
              { className: "jev-settings-inputRow" },
              React.createElement(
                "button",
                { type: "button", disabled: busy, onClick: () => presetThresholds(0.52, 0.37, 0.24) },
                t("settings.presetSensitive")
              ),
              React.createElement(
                "button",
                { type: "button", disabled: busy, onClick: () => presetThresholds(0.63, 0.4, 0.25) },
                t("settings.presetConservative")
              ),
              React.createElement("button", { type: "button", disabled: busy, onClick: resetThresholds }, t("settings.presetDefault")),
              React.createElement(
                "button",
                { type: "button", "data-primary": "true", disabled: busy, onClick: saveThresholds },
                t("settings.thresholdsSave")
              )
            ),
            React.createElement(
              "div",
              { className: "jev-settings-thresholdSource" },
              `${t("settings.thresholdsSource")}: ${provider?.thresholdsSource === "settings" ? t("settings.thresholdsSourceSettings") : t("settings.thresholdsSourceConfig")}${thresholds.dirty ? ` \xB7 ${t("settings.thresholdsDirty")}` : ""}`
            ),
            React.createElement("div", { className: "jev-settings-hint" }, t("settings.thresholdsHint"))
          ),
          checkNode,
          message !== null ? React.createElement("div", { className: "jev-settings-message", "data-kind": message.kind }, message.text) : null
        )
      );
    };
  }

  // src/client/controller.ts
  var CHIP_SLOT = "conversation.composer.dock";
  var CHIP_ID = "jev-highlight-chip";
  function highlightWindow(win) {
    return {
      document: win.document,
      CSS: win.CSS,
      Highlight: win.Highlight,
      requestAnimationFrame: (callback) => win.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) => win.cancelAnimationFrame(handle),
      setTimeout: (callback, delay) => win.setTimeout(callback, delay),
      clearTimeout: (handle) => win.clearTimeout(handle),
      MutationObserver: win.MutationObserver
    };
  }
  function applyClientHalf(ctx, React, win = window) {
    if (typeof win.document === "undefined") return;
    const locale = ctx.locale;
    if (locale !== void 0 && typeof locale.register === "function") {
      for (const [language, dictionary] of Object.entries(DICTS)) {
        try {
          const disposer = locale.register(NS, language, dictionary);
          if (typeof disposer === "function" && typeof ctx.effect === "function") {
            const cleanup = disposer;
            ctx.effect(() => cleanup);
          }
        } catch (error) {
          console.error("[jev-highlight] failed to register locale dictionary", language, error);
        }
      }
    }
    const translate = createTranslator(locale);
    const supported = supportsHighlights(highlightWindow(win));
    const highlighter = createHighlighter({ window: highlightWindow(win), unsupported: !supported });
    const api = createHostApi();
    const poller = createPoller({
      window: {
        document: win.document,
        setTimeout: (callback, delay) => win.setTimeout(callback, delay),
        clearTimeout: (handle) => win.clearTimeout(handle)
      },
      api,
      highlighter,
      supported
    });
    try {
      ctx.effect(() => () => {
        try {
          poller.dispose();
        } finally {
          highlighter.dispose();
        }
      });
    } catch (error) {
      console.error("[jev-highlight] failed to register disposer", error);
    }
    poller.start();
    const Chip = createChipComponent(React, translate, poller);
    const Settings = createSettingsComponent(React, api, translate);
    const slots = ctx.slots;
    if (slots !== void 0 && typeof slots.inject === "function" && typeof slots.register === "function") {
      try {
        const disposer = slots.inject(
          "settings.plugins.tab",
          () => slots.register(
            {
              name: "settings.plugins.tab",
              id: "jev-highlight",
              order: 60,
              label: () => translate("settings.tab")
            },
            Settings
          )
        );
        if (typeof disposer === "function" && typeof ctx.effect === "function") ctx.effect(() => disposer);
      } catch (error) {
        console.error("[jev-highlight] failed to register the settings tab", error);
      }
      try {
        const disposer = slots.inject(
          CHIP_SLOT,
          () => slots.register(
            {
              name: CHIP_SLOT,
              id: CHIP_ID,
              order: 40
            },
            Chip
          )
        );
        if (typeof disposer === "function" && typeof ctx.effect === "function") ctx.effect(() => disposer);
      } catch (error) {
        console.error("[jev-highlight] failed to register the status chip", error);
      }
    }
  }

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "@local/dsh-jev-highlight",
    factory(req) {
      const React = req("react");
      const plugin = {
        inject: ["slots", "locale"],
        apply(ctx) {
          try {
            applyClientHalf(ctx, React);
          } catch (error) {
            console.error("[jev-highlight] failed to apply the client half", error);
          }
        }
      };
      return plugin;
    }
  });
})();
