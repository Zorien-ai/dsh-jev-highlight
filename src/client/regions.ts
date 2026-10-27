/**
 * Candidate agent-output regions.
 *
 * Preference order (see docs/dom-notes.md), verified against the real Harness
 * Web UI on 2026-10-20:
 *
 * 1. markdown roots under a finished assistant answer
 *    (`assistant-step` + `group-part="response"`), class contains `markdown`;
 * 2. the whole answer node (same flow item) when the markdown class is gone;
 * 3. any `assistant-step` that is not the reasoning trace;
 * 4. generic leaf blocks inside the transcript (`p`, `li`, `pre`, `tr`) minus
 *    composer/sidebar/plugin UI.
 *
 * Everything is read-only: the mapper never inserts, wraps or moves nodes.
 */

import { isExcludedElement } from './textmap.js'

/** Primary region selector: final assistant markdown roots. */
const RESPONSE_MARKDOWN = '[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] [class*="markdown"]'
/** Secondary: the entire answer node. */
const RESPONSE_NODE = '[data-chat-group-part="response"] [data-slot="conversation.chat.node"]'
/** Tertiary: any assistant step that is not reasoning. */
const ASSISTANT_STEP = '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])'
/** Generic leaf blocks used when no data attributes exist (fixtures, older builds). */
const GENERIC_BLOCKS = 'p, li, pre, table, tr, blockquote, h1, h2, h3, h4, h5, h6'

/** UI chrome trees that must never be searched. */
const EXCLUDED_SUBTREE = [
  '[data-slot="sidebar"]',
  '[data-slot="rightbar"]',
  '[data-slot="shell.overlay"]',
  '[data-slot="conversation.composer"]',
  '[data-slot="conversation.input.dock"]',
  '[data-composer-dock]',
  '[data-composer-card]',
  '[data-lexical-editor]',
  '[data-sidebar-right-session]',
  '[data-sidebar-right-panel]',
  '[data-jev-highlight-ui]',
  '[data-code-block-banner]',
].join(',')

/** Scroll/transcript roots in preference order. */
const CONTAINER_SELECTORS = ['[data-conversation-scroll]', '[data-chat-flow]', '[data-conversation-region="chat"]', 'main']

/** Root element that the MutationObserver can watch; body is the safe fallback. */
export function findChatContainer(doc: Document): Element | null {
  for (const selector of CONTAINER_SELECTORS) {
    const element = doc.querySelector(selector)
    if (element !== null) return element
  }
  return null
}

/** True when an element sits under plugin chrome / composer / sidebar. */
export function isInExcludedSubtree(element: Element): boolean {
  return element.closest(EXCLUDED_SUBTREE) !== null
}

function hasMeaningfulText(element: Element): boolean {
  if (element.textContent === null) return false
  return element.textContent.trim().length > 0
}

/** Keep only outermost matches of a selector list (nested duplicates removed). */
function outermost(elements: readonly Element[]): Element[] {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)))
}

/** Keep only elements that are not empty shells and not plugin UI. */
function usable(elements: readonly Element[], container: Element | null): Element[] {
  const result: Element[] = []
  for (const element of elements) {
    if (!element.isConnected) continue
    if (isInExcludedSubtree(element)) continue
    if (element.closest('[data-chat-flow-kind="tool-call"]') !== null) continue
    if (element.closest('[data-chat-group-part="reasoning"]') !== null) continue
    if (!hasMeaningfulText(element)) continue
    if (container !== null && !container.contains(element)) continue
    result.push(element)
  }
  return result
}

/**
 * Collect the current candidate roots, in document order.
 *
 * Returns an empty array while there is no agent output yet; the caller simply
 * retries on the next DOM mutation.
 */
export function collectRegionRoots(doc: Document): Element[] {
  const container = findChatContainer(doc)

  const markdown = usable(outermost([...doc.querySelectorAll(RESPONSE_MARKDOWN)]), container)
  if (markdown.length > 0) return markdown

  const nodes = usable(outermost([...doc.querySelectorAll(RESPONSE_NODE)]), container)
  if (nodes.length > 0) return nodes

  const steps = usable(outermost([...doc.querySelectorAll(ASSISTANT_STEP)]), container)
  if (steps.length > 0) return steps

  const scopes = container === null ? [] : [container]
  for (const scope of scopes) {
    const blocks = [...scope.querySelectorAll(GENERIC_BLOCKS)].filter((element) => {
      if (isExcludedElement(element)) return false
      if (isInExcludedSubtree(element)) return false
      if (element.closest('[data-chat-group-part="reasoning"]') !== null) return false
      if (element.closest('[data-chat-flow-kind="tool-call"]') !== null) return false
      if (element.closest('table') !== null && element.tagName !== 'TR') return false
      if (element.tagName === 'TR') return element.closest('table') !== null
      return hasMeaningfulText(element)
    })
    const leaves = outermost(blocks.filter((element) => element.tagName !== 'LI' || element.querySelector('p, ul, ol') === null))
    if (leaves.length > 0) return leaves
  }

  return []
}

/** Element the MutationObserver should watch (transcript when available, body else). */
export function findObservationRoot(doc: Document): Element {
  return findChatContainer(doc) ?? doc.body
}
