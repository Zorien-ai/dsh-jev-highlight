/**
 * Read-only DOM text mapping for the CSS Custom Highlight API.
 *
 * The agent output DOM must never be touched: instead of wrapping matches, we
 * flatten the text nodes of a candidate region into one string with a reverse
 * map (`normalized offset -> raw offset -> DOM text node offset`) and build
 * `Range` objects from it. The browser paints those via `::highlight()`.
 *
 * Two normalisation modes:
 * - `markdown` (paragraph / list item / table row): `unit.text` is raw markdown
 *   (backticks, `**`, link syntax, …) while the rendered DOM has the markers
 *   gone, so markers are dropped on *both* sides. A second "tight" variant
 *   ignores whitespace entirely because CJK rendering may delete the spaces a
 *   markdown source carries around inline code / punctuation.
 * - `verbatim` (code blocks): the code text is matched literally (newlines
 *   collapsed to single spaces), because code may legitimately contain `*`,
 *   `` ` `` or `_`.
 */

/** One text node's slice inside the flattened raw string. */
export interface TextPosition {
  node: Text
  start: number
  end: number
}

/** A flattened region: raw text, text-node index and normalised views. */
export interface FlattenedRegion {
  root: Element
  /** Concatenated text nodes with synthetic separators between block boundaries. */
  raw: string
  positions: TextPosition[]
  /** Whitespace-collapsed (+ markdown-stripped when loose) view and its map to `raw` indices. */
  text: string
  map: number[]
  /** Whitespace-only-stripped view of `text` and its map to `raw` indices (loose mode only). */
  tight?: { text: string; map: number[] }
}

/** Matched span in normalised coordinates. */
export interface MatchSpan {
  start: number
  end: number
}

const LOOSE_SKIP = new Set(['*', '`', '_', '~', '\\'])

/** Elements whose boundaries behave like rendered whitespace. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'thead', 'tbody', 'tfoot',
  'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'section', 'article',
  'header', 'footer', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'main', 'nav', 'aside',
  'details', 'summary', 'form', 'fieldset', 'address',
])

/** Subtrees that never carry agent answer text. */
const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO'])

/** Attributes marking UI chrome (never agent output). */
const EXCLUDED_ATTRIBUTES = ['data-jev-highlight-ui', 'data-code-block-banner', 'data-lexical-editor', 'data-composer-input', 'data-composer-dock']

/** Word characters used for the "tight" (whitespace-insensitive) search. */
const WHITESPACE = /\s/u

function isElement(node: Node): node is Element {
  return node.nodeType === 1
}

/** True when a subtree belongs to plugin/chrome UI that must not be searched. */
export function isExcludedElement(element: Element): boolean {
  if (EXCLUDED_TAGS.has(element.tagName)) return true
  for (const attribute of EXCLUDED_ATTRIBUTES) {
    if (element.hasAttribute(attribute)) return true
  }
  if (element.getAttribute('contenteditable') === 'true' || element.getAttribute('aria-hidden') === 'true') return true
  return false
}

function pushSeparator(state: { raw: string; buffer: string }): void {
  if (state.buffer.length === 0) return
  if (WHITESPACE.test(state.buffer.charAt(state.buffer.length - 1))) return
  state.buffer += ' '
  state.raw += ' '
}

/**
 * Flatten a DOM region into searchable text.
 *
 * Block-level elements and `<br>` contribute one synthetic separating space so
 * that table cells and consecutive blocks match the host's `matchText`
 * (`cells.join(' ')`) and paragraph units.
 */
export function flattenRegion(root: Element, loose: boolean): FlattenedRegion {
  const positions: TextPosition[] = []
  const state = { raw: '', buffer: '' }

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node as Text
      const data = text.data
      if (data.length === 0) return
      const start = state.raw.length
      for (const character of data) {
        state.raw += character
        state.buffer += character
      }
      positions.push({ node: text, start, end: state.raw.length })
      return
    }
    if (!isElement(node)) return
    if (isExcludedElement(node)) return
    const block = BLOCK_TAGS.has(node.tagName.toLowerCase())
    if (block) pushSeparator(state)
    for (const child of node.childNodes) {
      if (isElement(child) && child.tagName === 'BR') {
        pushSeparator(state)
        continue
      }
      walk(child)
    }
    if (block) pushSeparator(state)
  }

  walk(root)

  let text = ''
  const map: number[] = []
  for (let index = 0; index < state.raw.length; index += 1) {
    const character = state.raw.charAt(index)
    if (WHITESPACE.test(character)) {
      if (text.length === 0 || text.charAt(text.length - 1) === ' ') continue
      text += ' '
      map.push(index)
      continue
    }
    if (loose && LOOSE_SKIP.has(character)) continue
    text += character
    map.push(index)
  }

  const region: FlattenedRegion = { root, raw: state.raw, positions, text, map }
  if (loose) {
    let tight = ''
    const tightMap: number[] = []
    for (let index = 0; index < text.length; index += 1) {
      const character = text.charAt(index)
      const rawIndex = map[index]
      if (rawIndex === undefined) continue
      if (WHITESPACE.test(character)) continue
      tight += character
      tightMap.push(rawIndex)
    }
    region.tight = { text: tight, map: tightMap }
  }
  return region
}

/**
 * Normalise a `unit.text` needle the same way `flattenRegion` normalises the
 * haystack. Link/image syntax is reduced to its visible label first.
 */
export function normalizeNeedle(text: string, loose: boolean): string {
  let source = text.replace(/\r\n?/gu, '\n')
  if (loose) {
    source = source
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/<[^>]*>/gu, '')
      .replace(/&amp;/gu, '&')
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&nbsp;/gu, ' ')
  }
  let normalized = ''
  for (const character of source) {
    if (WHITESPACE.test(character)) {
      if (normalized.length === 0 || normalized.charAt(normalized.length - 1) === ' ') continue
      normalized += ' '
      continue
    }
    if (loose && LOOSE_SKIP.has(character)) continue
    normalized += character
  }
  return normalized
}

/** Whitespace-only-stripped variant of an already normalised needle. */
export function tighten(needle: string): string {
  let tight = ''
  for (const character of needle) {
    if (WHITESPACE.test(character)) continue
    tight += character
  }
  return tight
}

/** Locate one raw offset inside the flattened text-node index. */
function positionAt(positions: readonly TextPosition[], offset: number): TextPosition | undefined {
  let low = 0
  let high = positions.length - 1
  let best: TextPosition | undefined
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = positions[middle]
    if (candidate === undefined) break
    if (candidate.start <= offset) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/** Map a normalised span back to raw offsets; `end` is exclusive. */
function rawSpan(region: FlattenedRegion, variant: { text: string; map: number[] }, span: MatchSpan): MatchSpan | null {
  const startRaw = variant.map[span.start]
  if (startRaw === undefined) return null
  const endRaw = span.end >= variant.map.length ? region.raw.length : variant.map[span.end]
  if (endRaw === undefined || endRaw <= startRaw) return null
  return { start: startRaw, end: endRaw }
}

/** Build a DOM Range for a normalised span, possibly crossing text nodes. */
export function rangeFromSpan(region: FlattenedRegion, variant: { text: string; map: number[] }, span: MatchSpan): Range | null {
  const raw = rawSpan(region, variant, span)
  if (raw === null) return null
  const startPosition = positionAt(region.positions, raw.start)
  const endPosition = positionAt(region.positions, Math.max(raw.start, raw.end - 1))
  if (startPosition === undefined || endPosition === undefined) return null
  const startOffset = Math.min(Math.max(0, raw.start - startPosition.start), startPosition.node.data.length)
  const endOffset = Math.min(Math.max(endPosition.start + 1, raw.end) - endPosition.start, endPosition.node.data.length)
  if (startOffset < 0 || endOffset < 0) return null
  const range = document.createRange()
  try {
    range.setStart(startPosition.node, startOffset)
    range.setEnd(endPosition.node, endOffset)
  } catch {
    return null
  }
  return range
}

/** A located match: normalised span, its variant and the DOM Range. */
export interface LocatedSpan {
  start: number
  end: number
  variant: 'text' | 'tight'
  range: Range
}

/**
 * Find an already-normalised needle inside one flattened region and return the
 * normalised span together with the constructed Range.
 *
 * Tries the whitespace-collapsed view first, then its whitespace-free variant
 * (CJK rendering can delete spaces around inline code/punctuation).
 */
export function findNormalizedSpan(region: FlattenedRegion, normalized: string): LocatedSpan | null {
  const trimmed = normalized.trim()
  if (trimmed === '') return null
  const direct = region.text.indexOf(trimmed)
  if (direct !== -1) {
    const range = rangeFromSpan(region, { text: region.text, map: region.map }, { start: direct, end: direct + trimmed.length })
    if (range !== null) return { start: direct, end: direct + trimmed.length, variant: 'text', range }
  }
  const tightNeedle = tighten(trimmed)
  const tight = region.tight
  if (tight === undefined || tightNeedle === '') return null
  const tightIndex = tight.text.indexOf(tightNeedle)
  if (tightIndex === -1) return null
  const range = rangeFromSpan(region, tight, { start: tightIndex, end: tightIndex + tightNeedle.length })
  if (range === null) return null
  return { start: tightIndex, end: tightIndex + tightNeedle.length, variant: 'tight', range }
}

/** Find an already-normalised needle inside one flattened region. */
export function findNormalizedInRegion(region: FlattenedRegion, normalized: string): Range | null {
  return findNormalizedSpan(region, normalized)?.range ?? null
}

/** Convenience wrapper: normalise a raw `unit.text` needle then search one region. */
export function findInRegion(region: FlattenedRegion, needle: string, loose: boolean): Range | null {
  return findNormalizedInRegion(region, normalizeNeedle(needle, loose))
}

/** True when a previously built Range still points into the live document. */
export function isRangeAlive(range: Range): boolean {
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false
  try {
    return range.toString().length > 0
  } catch {
    return false
  }
}
