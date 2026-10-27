/**
 * Streaming semantic splitter: unit types, chunk boundaries, context, flush.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StreamingSplitter, splitMarkdownText } from '../../lib/index.js'

function makeSplitter(overrides = {}) {
  return new StreamingSplitter({
    sessionId: 'session-1',
    attemptId: 'attempt-1',
    blockIndex: 0,
    ...overrides,
  })
}

test('paragraph is emitted the moment its blank-line terminator arrives', () => {
  const splitter = makeSplitter()
  assert.deepEqual(splitter.push('Hello world'), [])
  const units = splitter.push('\n\n')
  assert.equal(units.length, 1)
  assert.equal(units[0].type, 'paragraph')
  assert.equal(units[0].text, 'Hello world')
  assert.equal(units[0].id, 'session-1:attempt-1:0:0')
  assert.deepEqual(units[0].context, {})
})

test('multi-line paragraph keeps its lines and ids stay ordered', () => {
  const splitter = makeSplitter()
  const units = [...splitter.push('first line\nsecond line\n\n'), ...splitter.push('next\n\n')]
  assert.equal(units.length, 2)
  assert.equal(units[0].text, 'first line\nsecond line')
  assert.equal(units[1].id, 'session-1:attempt-1:0:1')
})

test('heading context is attached to following units', () => {
  const splitter = makeSplitter()
  const units = [...splitter.push('# Setup\n\nThe value is 42.\n\n'), ...splitter.push('## Deep dive\n\nMore text.\n\n')]
  assert.equal(units.length, 2)
  assert.equal(units[0].context.heading, 'Setup')
  assert.equal(units[1].context.heading, 'Deep dive')
  assert.equal(splitter.heading, 'Deep dive')
})

test('context.before carries the previous unit last line, bounded', () => {
  const splitter = makeSplitter({ beforeLimit: 20 })
  const units = [...splitter.push('alpha beta gamma delta\n\n'), ...splitter.push('second paragraph\n\n')]
  assert.equal(units[1].context.before, 'alpha beta gamma delta'.slice(-20))
  assert.ok(units[1].context.before.length <= 20)
})

test('seeded heading/before ground the first unit of a new block', () => {
  const splitter = makeSplitter({ initialHeading: 'Carried heading', initialBefore: 'previous last line' })
  const units = splitter.push('content\n\n')
  assert.equal(units[0].context.heading, 'Carried heading')
  assert.equal(units[0].context.before, 'previous last line')
})

test('seeded question grounds every unit of the block', () => {
  const splitter = makeSplitter({ initialQuestion: 'What is the answer?' })
  const units = splitter.push('first\n\nsecond\n\n')
  assert.equal(units.length, 2)
  assert.equal(units[0].context.question, 'What is the answer?')
  assert.equal(units[1].context.question, 'What is the answer?')
  assert.equal(splitter.seededQuestion, 'What is the answer?')
})

test('list items strip markers; a new item releases the previous one', () => {
  const splitter = makeSplitter()
  const units = splitter.push('- first item\n- second item\n')
  assert.equal(units.length, 1)
  assert.equal(units[0].type, 'list_item')
  assert.equal(units[0].text, 'first item')
  const flushed = splitter.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].text, 'second item')
})

test('ordered list items and indented continuations are folded into one unit', () => {
  const splitter = makeSplitter()
  const units = [...splitter.push('1. first step\n   continued detail\n'), ...splitter.flush()]
  assert.equal(units.length, 1)
  assert.equal(units[0].type, 'list_item')
  assert.equal(units[0].text, 'first step\ncontinued detail')
})

test('code fence split across chunks produces one code_block without fences', () => {
  const splitter = makeSplitter()
  const first = splitter.push('before paragraph\n\n```js\nconst a = 1\n')
  assert.equal(first.length, 1)
  assert.equal(first[0].type, 'paragraph')
  assert.equal(first[0].text, 'before paragraph')
  assert.deepEqual(splitter.push('const b = 2\n'), [])
  const units = [...splitter.push('```\n\n'), ...splitter.flush()]
  assert.equal(units.length, 1)
  assert.equal(units[0].type, 'code_block')
  assert.equal(units[0].text, 'const a = 1\nconst b = 2')
})

test('unclosed fence is flushed as a code_block', () => {
  const splitter = makeSplitter()
  assert.deepEqual(splitter.push('```py\nprint(1)\n'), [])
  const units = splitter.flush()
  assert.equal(units.length, 1)
  assert.equal(units[0].type, 'code_block')
  assert.equal(units[0].text, 'print(1)')
})

test('table rows: text keeps pipes for Jev, matchText is DOM friendly, separator skipped', () => {
  const splitter = makeSplitter()
  const units = splitter.push('| name | value |\n| --- | --- |\n| alpha | 1 |\n')
  assert.equal(units.length, 2)
  assert.equal(units[0].type, 'table_row')
  assert.equal(units[0].text, 'name | value')
  assert.equal(units[0].matchText, 'name value')
  assert.equal(units[1].text, 'alpha | 1')
  assert.equal(units[1].matchText, 'alpha 1')
})

test('escaped pipes inside a table cell are preserved', () => {
  const splitter = makeSplitter()
  const units = splitter.push('| a \\| b | c |\n')
  assert.equal(units.length, 1)
  assert.equal(units[0].text, 'a | b | c')
})

test('horizontal rules are skipped, blockquotes stay paragraphs', () => {
  const splitter = makeSplitter()
  const units = [...splitter.push('---\n\n> quoted line\n\n'), ...splitter.flush()]
  assert.equal(units.length, 1)
  assert.equal(units[0].type, 'paragraph')
  assert.equal(units[0].text, '> quoted line')
})

test('CRLF streams behave like LF streams', () => {
  const splitter = makeSplitter()
  const units = splitter.push('hello\r\n\r\n')
  assert.equal(units.length, 1)
  assert.equal(units[0].text, 'hello')
})

test('splitMarkdownText handles a mixed document', () => {
  const markdown = [
    '# Title',
    '',
    'Intro paragraph.',
    '',
    '- item one',
    '- item two',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '| key | value |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    'Final paragraph.',
    '',
  ].join('\n')
  const units = splitMarkdownText(markdown, { sessionId: 's', attemptId: 'a', blockIndex: 3 })
  const types = units.map((unit) => unit.type)
  assert.deepEqual(types, ['paragraph', 'list_item', 'list_item', 'code_block', 'table_row', 'table_row', 'paragraph'])
  assert.equal(units[0].context.heading, 'Title')
  assert.equal(units[0].text, 'Intro paragraph.')
  assert.equal(units[3].text, 'const answer = 42')
  assert.equal(units[4].text, 'key | value')
  assert.equal(units[5].text, 'a | 1')
  assert.equal(units[5].matchText, 'a 1')
  assert.equal(units[6].context.heading, 'Title')
  assert.equal(units[0].id.startsWith('s:a:3:'), true)
})

test('each push returns only newly completed units (streaming immediacy)', () => {
  const splitter = makeSplitter()
  assert.equal(splitter.push('a').length, 0)
  assert.equal(splitter.push('b').length, 0)
  assert.equal(splitter.push('\n').length, 0) // paragraph has no blank line yet
  assert.equal(splitter.push('\n').length, 1)
  assert.equal(splitter.bufferedCharacters, 0)
})

test('flush resets the splitter so no text is emitted twice', () => {
  const splitter = makeSplitter()
  splitter.push('one\n\n')
  splitter.flush()
  const units = [...splitter.flush(), ...splitter.push('two\n\n')]
  assert.equal(units.length, 1)
  assert.equal(units[0].text, 'two')
  assert.equal(units[0].id.endsWith(':1'), true)
})
