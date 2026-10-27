/**
 * Streaming markdown semantic splitter.
 *
 * The client highlights semantic units, not fixed-size windows: a paragraph, a
 * list item, a fenced code block or a table row are the units Jev judges. This
 * splitter consumes the assistant `text-delta` stream incrementally:
 *
 * - complete units are returned as soon as their terminator is observed, so
 *   the client can highlight before the message finishes;
 * - an incomplete trailing line, an open code fence, an in-progress list item
 *   and a partially streamed table stay buffered across `push()` calls;
 * - `flush()` closes whatever is pending at `block-end`/stream-end.
 *
 * Grounding context: the nearest preceding markdown heading (across blocks,
 * fed in through `initialHeading`) and the last line of the previous unit.
 * Neither is ever empty-string; absent fields are omitted.
 */
import type { ContentUnit, UnitType } from '../contract.js'

/**
 * Splitter output. `matchText` is the DOM-searchable variant required by the
 * client for table rows: `text` keeps markdown pipes for Jev, while rendered
 * cells contain only the cell text joined with spaces.
 */
export type SplitUnit = ContentUnit & { matchText?: string }

export interface SplitterOptions {
  sessionId: string
  attemptId: string
  blockIndex: number
  /** Heading carried over from an earlier text block of the same message. */
  initialHeading?: string
  /** Last line of the previous unit (bounded). */
  initialBefore?: string
  /** User request for the current turn, injected as `[question]` in the state. */
  initialQuestion?: string
  /** Maximum characters kept from the previous unit for grounding. */
  beforeLimit?: number
  /** Ordinal offset used when a block is reprocessed from its final text. */
  startOrdinal?: number
  /** Upper bound of remembered unit texts used for duplicate suppression. */
  dedupeLimit?: number
}

export const DEFAULT_BEFORE_LIMIT = 240

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/u
const TABLE_ROW = /^[ \t]*\|/u
const HORIZONTAL_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u
const TABLE_SEPARATOR_CELL = /^:?-+:?$/u

function stripClosingHashes(text: string): string {
  const stripped = text.replace(/[ \t]+#+[ \t]*$/u, '')
  return stripped.trim()
}

function isTableSeparator(line: string): boolean {
  const text = line.trim()
  if (!text.includes('-')) return false
  const stripped = text.replace(/^\|/u, '').replace(/\|$/u, '')
  const cells = stripped.split('|').map((cell) => cell.trim())
  if (cells.length === 0) return false
  return cells.every((cell) => cell !== '' && TABLE_SEPARATOR_CELL.test(cell))
}

/** Split a markdown table row into trimmed cell texts (escaped `\|` supported). */
export function tableRowCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (character === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}

function lastLine(text: string): string {
  const lines = text.split('\n')
  return (lines[lines.length - 1] ?? '').trim()
}

function truncateBefore(before: string, limit: number): string {
  if (!(limit > 0) || before.length <= limit) return before
  return before.slice(before.length - limit).trim()
}

interface FenceState {
  char: string
  length: number
  lines: string[]
}

export class StreamingSplitter {
  readonly sessionId: string
  readonly attemptId: string
  readonly blockIndex: number

  private readonly beforeLimit: number
  private readonly dedupeLimit: number
  private readonly initialHeading: string | undefined
  private readonly initialBefore: string | undefined
  private readonly initialQuestion: string | undefined

  private buffer = ''
  private headingText: string | undefined
  private beforeText: string | undefined
  private questionText: string | undefined
  private paragraphLines: string[] = []
  private listItem: { lines: string[] } | null = null
  private fence: FenceState | null = null
  private ordinal: number
  private readonly seenTexts = new Set<string>()

  constructor(options: SplitterOptions) {
    this.sessionId = options.sessionId
    this.attemptId = options.attemptId
    this.blockIndex = options.blockIndex
    this.beforeLimit = options.beforeLimit ?? DEFAULT_BEFORE_LIMIT
    this.dedupeLimit = options.dedupeLimit ?? 256
    this.initialHeading = options.initialHeading
    this.initialBefore = options.initialBefore
    this.initialQuestion = options.initialQuestion
    this.headingText = options.initialHeading
    this.beforeText = options.initialBefore
    this.questionText = options.initialQuestion
    this.ordinal = options.startOrdinal ?? 0
  }

  /** Nearest heading observed so far (block-scoped; the pipeline persists it). */
  get heading(): string | undefined {
    return this.headingText
  }

  /** Last line of the last emitted unit (grounding for the next unit). */
  get before(): string | undefined {
    return this.beforeText
  }

  /** Heading the splitter was seeded with, needed when a block is reprocessed. */
  get seededHeading(): string | undefined {
    return this.initialHeading
  }

  get seededBefore(): string | undefined {
    return this.initialBefore
  }

  /** User request the splitter was seeded with (block-end reprocessing). */
  get seededQuestion(): string | undefined {
    return this.initialQuestion
  }

  /** Next ordinal; feed it as `startOrdinal` to avoid duplicate ids on reprocess. */
  get nextOrdinal(): number {
    return this.ordinal
  }

  /** Characters buffered because no line terminator arrived yet. */
  get bufferedCharacters(): number {
    return this.buffer.length
  }

  /** Feed one streaming delta; returns the units that became complete. */
  push(text: string): SplitUnit[] {
    if (typeof text !== 'string' || text === '') return []
    this.buffer += text
    if (this.buffer.indexOf('\n') === -1) return []
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    const units: SplitUnit[] = []
    for (const line of lines) {
      const emitted = this.consumeLine(line)
      if (emitted.length > 0) units.push(...emitted)
    }
    return units
  }

  /** Close every pending construct (block-end / stream-end). */
  flush(): SplitUnit[] {
    const units: SplitUnit[] = []
    if (this.buffer !== '') {
      const pending = this.buffer
      this.buffer = ''
      const emitted = this.consumeLine(pending)
      if (emitted.length > 0) units.push(...emitted)
    }
    if (this.fence !== null) {
      const text = this.fence.lines.join('\n').replace(/\n+$/u, '')
      this.fence = null
      const unit = this.emitUnit('code_block', text, { skipTrim: true })
      if (unit !== null) units.push(unit)
    }
    for (const unit of this.flushCurrent()) units.push(unit)
    return units
  }

  private consumeLine(rawLine: string): SplitUnit[] {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (this.fence !== null) {
      if (this.isFenceClose(line)) {
        const text = this.fence.lines.join('\n').replace(/\n+$/u, '')
        this.fence = null
        const unit = this.emitUnit('code_block', text, { skipTrim: true })
        return unit === null ? [] : [unit]
      }
      this.fence.lines.push(line)
      return []
    }

    if (line.trim() === '') return this.flushCurrent()

    const fenceMatch = FENCE_OPEN.exec(line)
    if (fenceMatch !== null) {
      const units = this.flushCurrent()
      const marker = fenceMatch[1] ?? '```'
      this.fence = { char: marker.charAt(0) === '~' ? '~' : '`', length: marker.length, lines: [] }
      return units
    }

    const headingMatch = HEADING.exec(line)
    if (headingMatch !== null) {
      const units = this.flushCurrent()
      this.headingText = stripClosingHashes(headingMatch[2] ?? '')
      if (this.headingText === '') this.headingText = undefined
      return units
    }

    if (HORIZONTAL_RULE.test(line)) return this.flushCurrent()

    if (TABLE_ROW.test(line)) {
      const units = this.flushCurrent()
      if (isTableSeparator(line)) return units
      const cells = tableRowCells(line)
      const text = cells.join(' | ')
      const matchText = cells.join(' ')
      const unit = this.emitUnit('table_row', text, {
        matchText: matchText !== text ? matchText : undefined,
      })
      if (unit !== null) units.push(unit)
      return units
    }

    const listMatch = LIST_ITEM.exec(line)
    if (listMatch !== null) {
      const units = this.flushCurrent()
      this.listItem = { lines: [listMatch[3] ?? ''] }
      return units
    }

    if (this.listItem !== null) {
      // Lazy continuation: markdown keeps the line inside the open list item.
      this.listItem.lines.push(line.trimEnd())
      return []
    }

    this.paragraphLines.push(line)
    return []
  }

  private isFenceClose(line: string): boolean {
    const fence = this.fence
    if (fence === null) return false
    const match = FENCE_CLOSE.exec(line)
    if (match === null) return false
    const marker = match[1] ?? ''
    if (marker.charAt(0) !== fence.char) return false
    return marker.length >= fence.length
  }

  private flushCurrent(): SplitUnit[] {
    const units: SplitUnit[] = []
    if (this.listItem !== null) {
      const lines = this.listItem.lines
      this.listItem = null
      const first = (lines[0] ?? '').trim()
      const rest = lines
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const text = [first, ...rest].join('\n').trim()
      const unit = this.emitUnit('list_item', text)
      if (unit !== null) units.push(unit)
    }
    if (this.paragraphLines.length > 0) {
      const text = this.paragraphLines.join('\n')
      this.paragraphLines = []
      const unit = this.emitUnit('paragraph', text)
      if (unit !== null) units.push(unit)
    }
    return units
  }

  private emitUnit(
    type: UnitType,
    rawText: string,
    options: { skipTrim?: boolean; matchText?: string } = {},
  ): SplitUnit | null {
    const text = options.skipTrim === true ? rawText : rawText.trim()
    if (text === '') return null
    // Punctuation-only fragments (e.g. a lone "。" emitted at a streaming
    // block boundary) carry no semantic content and must never consume a Jev
    // request. Code blocks keep symbol-only text because it can be meaningful.
    if (type !== 'code_block' && !/[\p{L}\p{N}]/u.test(text)) return null
    if (this.seenTexts.has(text)) return null

    this.seenTexts.add(text)
    if (this.seenTexts.size > this.dedupeLimit) {
      const oldest = this.seenTexts.values().next()
      if (oldest.done !== true) this.seenTexts.delete(oldest.value)
    }

    const context: ContentUnit['context'] = {}
    if (this.headingText !== undefined && this.headingText !== '') context.heading = this.headingText
    if (this.beforeText !== undefined && this.beforeText !== '') context.before = this.beforeText
    if (this.questionText !== undefined && this.questionText !== '') context.question = this.questionText

    const unit: SplitUnit = {
      id: `${this.sessionId}:${this.attemptId}:${this.blockIndex}:${this.ordinal}`,
      sessionId: this.sessionId,
      attemptId: this.attemptId,
      blockIndex: this.blockIndex,
      type,
      text,
      context,
    }
    this.ordinal += 1
    if (options.matchText !== undefined && options.matchText !== '') unit.matchText = options.matchText
    this.beforeText = truncateBefore(lastLine(text), this.beforeLimit)
    return unit
  }
}

/** Convenience wrapper for a complete (non-streamed) markdown document. */
export function splitMarkdownText(text: string, options: SplitterOptions): SplitUnit[] {
  const splitter = new StreamingSplitter(options)
  const units = splitter.push(text)
  for (const unit of splitter.flush()) units.push(unit)
  return units
}
