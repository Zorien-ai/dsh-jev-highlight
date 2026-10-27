/**
 * Fixture harness for the Jev highlight client half.
 *
 * Loads the real `lib/client.js` bundle through a stub module loader, provides a
 * tiny React shim (the chip only needs createElement/useState/useEffect), mocks
 * the four same-origin host routes with window.fetch, and drives assertions in
 * two phases so the page can be screenshotted while highlights are visible.
 *
 * Phase 1 (auto): plugin boot, staged verdict delivery, highlight assertions,
 *                 DOM-integrity assertions, exclusion assertions.
 * Phase 2 (manual, window.__fixture.phase2()): streaming append, toggle,
 *                 cleanup, optional unsupported-API probe.
 */

/* eslint-disable no-console */
;(function () {
  'use strict'

  const statusEl = document.getElementById('fixture-status')
  const report = {
    ok: false,
    checks: [],
    phases: {},
    errors: [],
    calls: { state: 0, units: 0, toggle: 0, urls: [] },
    progression: [],
  }
  window.__fixture = { report, phase: 'boot' }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text
  }

  function check(name, pass, detail) {
    report.checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail })
    return Boolean(pass)
  }

  function errorsText(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  async function waitFor(predicate, timeoutMs = 4000, intervalMs = 40) {
    const started = performance.now()
    for (;;) {
      let value = false
      try {
        value = Boolean(await predicate())
      } catch (error) {
        report.errors.push(errorsText(error))
      }
      if (value) return true
      if (performance.now() - started > timeoutMs) return false
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  async function nextFrames(count = 3) {
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  // -------------------------------------------------------------------------
  // Minimal React shim: createElement + useState + useEffect + DOM renderer.
  // -------------------------------------------------------------------------

  const hookSlots = []
  let effectsPrev = []
  let scheduled = false
  let rootComponent = null
  let rootContainer = null
  let rootProps = null

  function createElement(type, props, ...children) {
    return { type, props: props === undefined || props === null ? {} : props, children: normalizeChildren(children) }
  }

  function normalizeChildren(children) {
    const result = []
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue
      if (Array.isArray(child)) {
        result.push(...normalizeChildren(child))
        continue
      }
      result.push(child)
    }
    return result
  }

  function scheduleRender() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      renderRoot()
    })
  }

  function useState(initial) {
    const index = hookSlots.length
    hookSlots.push(undefined)
    const holder = { index }
    const current = hookSlots[index]
    if (current === undefined) {
      hookSlots[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = hookSlots[index]
    const setter = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (!Object.is(value, slot.value)) {
        slot.value = value
        setter.__hook = holder
        scheduleRender()
      }
    }
    return [slot.value, setter]
  }

  function useEffect(effect, deps) {
    const index = hookSlots.length
    hookSlots.push(undefined)
    const previous = effectsPrev[index]
    const same = previous !== undefined && deps !== undefined && Array.isArray(previous.deps) && Array.isArray(deps) && previous.deps.length === deps.length && previous.deps.every((value, position) => Object.is(value, deps[position]))
    if (previous !== undefined && !same && typeof previous.cleanup === 'function') previous.cleanup()
    if (same) return
    effectsPrev[index] = { deps: deps === undefined ? undefined : [...deps], cleanup: undefined, effect }
    pendingEffects.push(index)
  }

  let pendingEffects = []

  const miniReact = {
    createElement,
    useState,
    useEffect,
  }

  function toDom(node) {
    if (node === null || node === undefined || node === false) return null
    if (Array.isArray(node)) {
      const fragment = document.createDocumentFragment()
      for (const child of node) {
        const dom = toDom(child)
        if (dom !== null) fragment.appendChild(dom)
      }
      return fragment
    }
    if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node))
    if (typeof node !== 'object' || node.type === undefined) return document.createTextNode(String(node))
    if (typeof node.type === 'function') return toDom(node.type({ ...rootProps, ...node.props, children: node.children }))
    const dom = document.createElement(node.type)
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'children') continue
      if (key === 'className') dom.setAttribute('class', String(value))
      else if (key === 'htmlFor') dom.setAttribute('for', String(value))
      else if (key === 'onClick' && typeof value === 'function') {
        dom.addEventListener('click', (event) => {
          try {
            value(event)
          } catch (error) {
            report.errors.push(errorsText(error))
          }
        })
      } else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'title' || key === 'role' || key === 'type' || key === 'disabled' || key === 'id') {
        dom.setAttribute(key, String(value))
      }
    }
    for (const child of node.children ?? []) {
      const childDom = toDom(child)
      if (childDom !== null) dom.appendChild(childDom)
    }
    return dom
  }

  function renderRoot() {
    if (rootComponent === null || rootContainer === null) return
    hookSlots.length = 0
    pendingEffects = []
    const tree = rootComponent(rootProps)
    const dom = toDom(tree)
    rootContainer.replaceChildren()
    if (dom !== null) rootContainer.appendChild(dom)
    for (const index of pendingEffects) {
      const entry = effectsPrev[index]
      if (entry === undefined || typeof entry.effect !== 'function') continue
      try {
        const cleanup = entry.effect()
        entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      } catch (error) {
        report.errors.push(errorsText(error))
      }
    }
  }

  function mount(component, container, props) {
    rootComponent = component
    rootContainer = container
    rootProps = props
    hookSlots.length = 0
    effectsPrev = []
    renderRoot()
  }

  // -------------------------------------------------------------------------
  // Module loader stub: capture the plugin definition instead of booting boot.
  // -------------------------------------------------------------------------

  const moduleTable = { react: miniReact }
  window.__ModuleLoader__ = {
    load(definition) {
      window.__pluginDefinition = definition
    },
  }
  window.__requireModule = (id) => {
    if (!(id in moduleTable)) throw new Error(`fixture require(${JSON.stringify(id)}) is not available`)
    return moduleTable[id]
  }

  // -------------------------------------------------------------------------
  // Mock host routes (same-origin fetch override).
  // -------------------------------------------------------------------------

  const HOST_READY_DELAY_MS = 700
  const hostReadyAt = performance.now() + HOST_READY_DELAY_MS
  const toggleCalls = []
  let enabled = true
  let stateCalls = 0
  let unitPolls = 0
  const stateCounts = { critical: 2, medium: 1, low: 3 }

  const UNITS = [
    {
      seq: 1,
      unitId: 'unit-p-inline',
      type: 'paragraph',
      text: 'Priority 计算结果：`priority` 是 **加权** 后的核心指标。',
      level: 'critical',
    },
    {
      seq: 2,
      unitId: 'unit-li',
      type: 'list_item',
      text: '列表项一：流式增长的目标文本 **正在** 追加。',
      level: 'medium',
    },
    {
      seq: 3,
      unitId: 'unit-code',
      type: 'code_block',
      text: "const hl = new Highlight(range)\nCSS.highlights.set('jev-low', hl)",
      level: 'low',
    },
    {
      seq: 4,
      unitId: 'unit-row',
      type: 'table_row',
      text: '`priority` | 0.5×核心 + 0.3×可执行',
      matchText: 'priority 0.5×核心 + 0.3×可执行',
      level: 'critical',
    },
    {
      seq: 5,
      unitId: 'unit-warning',
      type: 'paragraph',
      text: '注意：0.45–0.65 区间属于弱信号，不应按中等强度渲染。',
      level: 'low',
    },
    {
      seq: 6,
      unitId: 'unit-none',
      type: 'paragraph',
      text: 'Priority 计算结果：',
      level: 'none',
    },
    {
      seq: 7,
      unitId: 'unit-composer',
      type: 'paragraph',
      text: 'composer text: priority highlighter 不应被搜索',
      level: 'critical',
    },
    {
      seq: 8,
      unitId: 'unit-sidebar',
      type: 'paragraph',
      text: 'sidebar priority message',
      level: 'critical',
    },
    {
      seq: 9,
      unitId: 'unit-stream',
      type: 'paragraph',
      text: '流式追加的第三段落：Range 会在 rAF 后被重新映射。',
      level: 'low',
    },
    {
      seq: 10,
      unitId: 'unit-header-row',
      type: 'table_row',
      text: '名称 | 说明',
      matchText: '名称 说明',
      level: 'none',
    },
  ]

  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, location.href)
    const path = url.pathname
    report.calls.urls.push(path)
    if (!path.endsWith('/jev-highlight/state') && !path.endsWith('/jev-highlight/units') && !path.endsWith('/jev-highlight/toggle')) {
      return new Response('not found', { status: 404 })
    }
    if (performance.now() < hostReadyAt) {
      return new Response('host half not mounted yet', { status: 404 })
    }
    const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

    if (path.endsWith('/jev-highlight/state')) {
      report.calls.state += 1
      stateCalls += 1
      return json({
        ok: true,
        enabled,
        counts: stateCounts,
        capabilities: { highlights: true },
        model: 'jev-1.13-fixture',
        thresholds: { critical: 0.85, medium: 0.65, low: 0.45 },
      })
    }
    if (path.endsWith('/jev-highlight/units')) {
      report.calls.units += 1
      unitPolls += 1
      const since = Number(url.searchParams.get('since') ?? '0')
      // Staged delivery: batch 1 (seq 1-3), batch 2 (4-7), batch 3 (8-10).
      const cutoff = since < 3 ? 3 : since < 7 ? 7 : 10
      const batch = UNITS.filter((unit) => unit.seq > since && unit.seq <= cutoff)
      const seq = batch.length > 0 ? batch[batch.length - 1].seq : since
      return json({ ok: true, units: batch, seq })
    }
    // toggle
    report.calls.toggle += 1
    let body = {}
    try {
      body = JSON.parse(init && typeof init.body === 'string' ? init.body : '{}')
    } catch {
      body = {}
    }
    toggleCalls.push(body)
    if (typeof body.enabled === 'boolean') enabled = body.enabled
    return json({
      ok: true,
      state: { ok: true, enabled, counts: stateCounts, model: 'jev-1.13-fixture', thresholds: { critical: 0.85, medium: 0.65, low: 0.45 } },
    })
  }

  // -------------------------------------------------------------------------
  // Fake Cordis client context: effect disposers, slots, locale.
  // -------------------------------------------------------------------------

  const disposers = []
  const registrations = []
  const localeRegistrations = []
  const dictionaries = {}

  function createFakeContext() {
    const ctx = {
      effect(callback) {
        const cleanup = callback()
        if (typeof cleanup === 'function') {
          disposers.push(cleanup)
          return cleanup
        }
        return () => {}
      },
      on() {
        return () => {}
      },
      get() {
        return undefined
      },
      inject(services, callback) {
        callback(ctx)
        return () => {}
      },
      slots: {
        inject(name, callback) {
          registrations.push({ inject: name })
          return callback()
        },
        register(options, component) {
          registrations.push({ name: options.name, id: options.id, order: options.order, locale: options.locale, component, options })
          return () => {
            const outlet = document.getElementById('dock-outlet')
            if (outlet !== null) outlet.replaceChildren()
          }
        },
      },
      locale: {
        register(namespace, language, dictionary) {
          dictionaries[language] = { ...(dictionaries[language] ?? {}), ...dictionary }
          localeRegistrations.push({ namespace, language })
          return () => {
            /* registration cleanup is not needed in the fixture */
          }
        },
        bind(namespace) {
          return (key) => {
            const dictionary = dictionaries['zh'] ?? {}
            const value = dictionary[key]
            return typeof value === 'string' ? value : key
          }
        },
      },
    }
    return ctx
  }

  // -------------------------------------------------------------------------
  // DOM structure snapshot (tags + attributes + text; used for integrity check).
  // -------------------------------------------------------------------------

  function snapshot(root) {
    const parts = []
    let nodes = 0
    const walk = (node) => {
      if (node.nodeType === 3) {
        parts.push(`#text:${node.data}`)
        return
      }
      if (node.nodeType !== 1) return
      nodes += 1
      const attributes = [...node.attributes]
        .map((attribute) => `${attribute.name}=${attribute.value}`)
        .sort()
        .join('|')
      parts.push(`<${node.tagName}:${attributes}>`)
      for (const child of node.childNodes) walk(child)
      parts.push(`</${node.tagName}>`)
    }
    walk(root)
    return { nodes, signature: parts.join('') }
  }

  function highlightState() {
    const names = ['jev-critical', 'jev-medium', 'jev-low']
    const counts = {}
    for (const name of names) {
      const entry = window.CSS && CSS.highlights ? CSS.highlights.get(name) : undefined
      counts[name] = entry ? [...entry].length : 0
    }
    return { size: window.CSS && CSS.highlights ? CSS.highlights.size : -1, keys: window.CSS && CSS.highlights ? [...CSS.highlights.keys()] : [], counts }
  }

  function textOfHighlight(name) {
    const entry = window.CSS && CSS.highlights ? CSS.highlights.get(name) : undefined
    return entry ? [...entry].map((range) => range.toString()) : []
  }

  function rangesInside(excludedSelector) {
    const names = ['jev-critical', 'jev-medium', 'jev-low']
    const offenders = []
    for (const name of names) {
      const entry = window.CSS && CSS.highlights ? CSS.highlights.get(name) : undefined
      if (!entry) continue
      for (const range of entry) {
        const element = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
        if (element && element.closest(excludedSelector) !== null) offenders.push({ name, selector: excludedSelector, text: range.toString().slice(0, 40) })
      }
    }
    return offenders
  }

  // -------------------------------------------------------------------------
  // Boot + phase 1.
  // -------------------------------------------------------------------------

  function boot() {
    const started = performance.now()
    const definition = window.__pluginDefinition
    if (!definition) {
      report.ok = false
      report.errors.push('module loader did not receive a plugin definition')
      setStatus('fixture: FAILED (no plugin definition)')
      document.title = 'FIXTURE FAIL'
      return
    }
    check('plugin id is @local/dsh-jev-highlight', definition.id === '@local/dsh-jev-highlight', definition.id)
    const plugin = definition.factory(window.__requireModule)
    check('factory returns a plugin with inject + apply', plugin !== null && typeof plugin === 'object' && Array.isArray(plugin.inject) && typeof plugin.apply === 'function', plugin && plugin.inject)
    check('plugin injects slots + locale', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'), plugin.inject)

    window.__fixturePhaseStart = started
    window.__fixture.progressStarted = started
    const context = createFakeContext()
    window.__fixtureContext = context
    window.__fixture.callsBefore = JSON.parse(JSON.stringify(report.calls))
    window.__fixtureContextTransplant = null

    // integrity baseline before apply
    const transcript = document.querySelector('[data-conversation-scroll]')
    window.__fixture.before = snapshot(transcript)
    window.__fixture.chatNodesBefore = transcript.querySelectorAll('*').length

    // progression sampler
    window.__fixture.sampler = setInterval(() => {
      report.progression.push({ t: Math.round(performance.now() - started), highlights: highlightState().counts })
    }, 100)

    try {
      plugin.apply(context)
    } catch (error) {
      report.errors.push(`apply threw: ${errorsText(error)}`)
    }

    // render the chip into the real dock outlet like the slot service would.
    // The real slot passes no props and rejects unknown options (only id/order/label),
    // so the fixture must mount the component with undefined props too.
    const registration = registrations.find((entry) => entry.id === 'jev-highlight-chip' && entry.component)
    check('chip registered in conversation.composer.dock', registration !== undefined && registration.name === 'conversation.composer.dock', registration && { slot: registration.name, id: registration.id })
    if (registration !== undefined) {
      const allowedOptions = ['name', 'id', 'order', 'label']
      const optionKeys = Object.keys(registration.options ?? {})
      check(
        'chip registration passes only real slot options (no locale/inject)',
        optionKeys.every((key) => allowedOptions.includes(key)),
        optionKeys,
      )
      if (registration.component !== undefined) {
        mount(registration.component, document.getElementById('dock-outlet'), undefined)
      }
    }

    void phase1()
  }

  async function phase1() {
    const start = performance.now()
    try {
      const ready = await waitFor(() => document.querySelector('[data-jev-highlight-ui]') !== null && window.CSS.highlights.size > 0, 6000)
      check('highlights appear within 6s (silent 404 retry)', ready, { waitedMs: Math.round(performance.now() - start) })

      await waitFor(() => {
        const state = highlightState()
        return state.counts['jev-critical'] === 2 && state.counts['jev-medium'] === 1 && state.counts['jev-low'] === 2
      }, 4000)

      const highlights = highlightState()
      check('CSS.highlights has exactly the three Jev names', highlights.keys.length === 3 && ['jev-critical', 'jev-medium', 'jev-low'].every((name) => highlights.keys.includes(name)), highlights.keys)
      check('critical ranges = 2 (paragraph inline-code + table matchText)', highlights.counts['jev-critical'] === 2, highlights.counts)
      check('medium ranges = 1 (list item with inline strong)', highlights.counts['jev-medium'] === 1, highlights.counts)
      check('low ranges = 2 (code block + warning paragraph)', highlights.counts['jev-low'] === 2, highlights.counts)

      const critical = textOfHighlight('jev-critical')
      check('critical paragraph matched across text nodes', critical.some((text) => text.includes('Priority 计算结果') && text.includes('加权')), critical)
      // The synthetic cell separator is not a real DOM character, so Range.toString()
      // may show the two cells glued together; compare whitespace-insensitively.
      const tableText = critical.find((text) => text.includes('0.5×核心'))
      check(
        'table_row matched via matchText without pipes',
        tableText !== undefined && tableText.replace(/\s+/gu, '') === 'priority0.5×核心+0.3×可执行',
        critical,
      )
      const medium = textOfHighlight('jev-medium')
      check('list item matched through inline strong nodes', medium.some((text) => text.includes('列表项一') && text.includes('正在') && text.includes('追加')), medium)
      const low = textOfHighlight('jev-low')
      check('code block matched verbatim (newline collapsed)', low.some((text) => text.includes("CSS.highlights.set('jev-low', hl)")), low)
      check('warning paragraph matched', low.some((text) => text.includes('0.45–0.65')), low)

      // exclusions
      check('no highlight inside composer', rangesInside('[data-composer-card], [data-lexical-editor]').length === 0, rangesInside('[data-composer-card], [data-lexical-editor]'))
      check('no highlight inside sidebar', rangesInside('[data-slot="sidebar"]').length === 0, rangesInside('[data-slot="sidebar"]'))
      check('no highlight inside tool-call output', rangesInside('[data-chat-flow-kind="tool-call"]').length === 0, rangesInside('[data-chat-flow-kind="tool-call"]'))

      // unlocatable units stay pending: composer, sidebar, stream not appended yet
      const state = window.__fixtureContext && window.__fixtureContext.__controllerState
      check('streaming unit not mapped before its DOM text exists', low.every((text) => !text.includes('流式追加的第三段落')), low)
      void state

      // DOM integrity
      const transcript = document.querySelector('[data-conversation-scroll]')
      const after = snapshot(transcript)
      check('agent output DOM unchanged (signature)', after.signature === window.__fixture.before.signature, { before: window.__fixture.before.nodes, after: after.nodes })
      check('agent output DOM node count unchanged', after.signature === window.__fixture.before.signature && after.nodes === window.__fixture.before.nodes, { before: window.__fixture.before.nodes, after: after.nodes })
      check('no wrapper/marker attributes injected into transcript', document.querySelectorAll('[data-conversation-scroll] mark, [data-conversation-scroll] [data-jev-highlight]').length === 0)

      // chip
      const chip = document.querySelector('[data-jev-highlight-ui]')
      check('chip mounted in composer dock slot', chip !== null && document.getElementById('dock-outlet').contains(chip), chip && chip.className)
      const countsText = chip ? chip.textContent : ''
      check('chip shows host counts 2/1/3', countsText.includes('2') && countsText.includes('1') && countsText.includes('3'), countsText)
      check('chip has a toggle button', chip ? chip.querySelector('.jev-chip-toggle') !== null : false)

      // locale registration
      check('locale dictionaries registered (zh+zh-CN+en)', localeRegistrations.length >= 3 && localeRegistrations.some((entry) => entry.language === 'en'), localeRegistrations)
      check('chip renders translated label', countsText.includes('Jev'), countsText)

      report.phases.phase1 = {
        waitedMs: Math.round(performance.now() - start),
        highlights,
        critical,
        medium,
        low,
        chipText: countsText,
        before: window.__fixture.before,
        after,
        calls: { ...report.calls, urls: report.calls.urls.slice(-12) },
      }
      report.ok = report.checks.every((entry) => entry.pass)
      window.__fixture.phase = 'highlighted'
      setStatus(`fixture phase1: ${report.ok ? 'OK' : 'FAIL'} · highlights ${JSON.stringify(highlights.counts)} · chip "${countsText}"`)
      document.title = report.ok ? 'FIXTURE PHASE1 OK' : 'FIXTURE PHASE1 FAIL'
      window.__fixtureReport = report
    } catch (error) {
      report.errors.push(errorsText(error))
      window.__fixture.phase = 'error'
      setStatus(`fixture phase1 error: ${errorsText(error)}`)
      document.title = 'FIXTURE PHASE1 ERROR'
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: streaming, toggle, cleanup, unsupported probe.
  // -------------------------------------------------------------------------

  async function phase2() {
    const result = { streaming: null, toggle: null, cleanup: null, unsupported: null }
    try {
      // streaming append: extend the list item and append a new paragraph
      // (idempotent: phase2 may be invoked after a manual append for screenshots)
      const li = document.getElementById('li-stream')
      if (li !== null && li.querySelector('[data-fixture-stream-tail]') === null) {
        const tail = document.createElement('span')
        tail.setAttribute('data-fixture-stream-tail', '')
        tail.textContent = ' 追加的后半句。'
        li.appendChild(tail)
      }
      const appendArea = document.getElementById('append-area')
      if (appendArea !== null && appendArea.childElementCount === 0) {
        const paragraph = document.createElement('p')
        paragraph.textContent = '流式追加的第三段落：Range 会在 rAF 后被重新映射。'
        appendArea.appendChild(paragraph)
      }
      await nextFrames(4)
      await waitFor(() => highlightState().counts['jev-low'] === 3, 3000)
      const afterStream = highlightState()
      const lowStream = textOfHighlight('jev-low')
      check('streaming append maps the late verdict after MutationObserver remap', afterStream.counts['jev-low'] === 3 && lowStream.some((text) => text.includes('流式追加的第三段落')), { counts: afterStream.counts, lowStream })
      const mediumStream = textOfHighlight('jev-medium')
      // The unit was already judged when it ended; later DOM growth belongs to the
      // next unit, so the pre-existing Range must survive unchanged (not extend).
      check(
        'existing medium range survives streaming append',
        mediumStream.length === 1 && mediumStream[0] !== undefined && mediumStream[0].includes('列表项一') && mediumStream[0].includes('追加'),
        mediumStream,
      )

      // DOM integrity after streaming
      const transcript = document.querySelector('[data-conversation-scroll]')
      const after2 = snapshot(transcript)
      check('DOM still unchanged by highlighting (streaming phase)', after2.nodes === window.__fixture.before.nodes + 2, { baseline: window.__fixture.before.nodes, now: after2.nodes })

      result.streaming = { counts: afterStream.counts, lowStream, mediumStream }

      // toggle off
      const chip = document.querySelector('[data-jev-highlight-ui]')
      const toggle = chip ? chip.querySelector('.jev-chip-toggle') : null
      check('chip toggle clickable', toggle !== null)
      if (toggle !== null) {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const toggledOff = await waitFor(() => report.calls.toggle === 1 && highlightState().size === 0, 3000)
        check('toggle POST {enabled:false} clears all highlight names', toggledOff && toggleCalls[0] !== undefined && toggleCalls[0].enabled === false, { calls: toggleCalls, highlights: highlightState() })
        const offChip = document.querySelector('[data-jev-highlight-ui]')
        const offPressed = offChip ? offChip.querySelector('.jev-chip-toggle')?.getAttribute('aria-pressed') : null
        const offDisabled = offChip ? offChip.querySelector('.jev-chip-toggle') !== null && offChip.querySelector('.jev-chip-toggle').textContent !== '…' : false
        check('chip state reports disabled + busy released (closure controller works without slot props)', offChip !== null && offChip.getAttribute('data-enabled') === 'false' && offPressed === 'false' && offDisabled, { enabled: offChip?.getAttribute('data-enabled'), pressed: offPressed })
        await waitFor(() => document.querySelector('[data-jev-highlight-ui]')?.getAttribute('data-enabled') === 'false', 2000)
        check('chip data-enabled flips to false', document.querySelector('[data-jev-highlight-ui]')?.getAttribute('data-enabled') === 'false')

        // toggle back on
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const toggledOn = await waitFor(() => report.calls.toggle === 2 && highlightState().size > 0 && highlightState().counts['jev-critical'] === 2, 3000)
        check('toggle POST {enabled:true} restores highlights', toggledOn && toggleCalls[1] !== undefined && toggleCalls[1].enabled === true, { calls: toggleCalls, highlights: highlightState() })
        result.toggle = { calls: toggleCalls.slice(0, 2), restored: highlightState() }
      }

      // cleanup
      const callsBeforeDispose = report.calls.units
      window.__fixture.sampler && clearInterval(window.__fixture.sampler)
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          report.errors.push(`disposer threw: ${errorsText(error)}`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
      const callsAfterDispose = report.calls.units
      const cleanupState = {
        highlights: highlightState(),
        styles: document.querySelectorAll('style[data-jev-highlight]').length,
        chips: document.querySelectorAll('[data-jev-highlight-ui]').length,
        pollsBefore: callsBeforeDispose,
        pollsAfter: callsAfterDispose,
      }
      check('cleanup removes every Jev highlight name', cleanupState.highlights.size === 0, cleanupState.highlights)
      check('cleanup removes the injected stylesheet', cleanupState.styles === 0, cleanupState.styles)
      check('cleanup unmounts the chip', cleanupState.chips === 0, cleanupState.chips)
      check('cleanup stops host polling', callsAfterDispose - callsBeforeDispose <= 1, cleanupState)
      result.cleanup = cleanupState

      // unsupported probe: hide CSS.highlights, re-apply, expect graceful fallback.
      const descriptor = window.CSS ? Object.getOwnPropertyDescriptor(window.CSS, 'highlights') : undefined
      if (window.CSS !== undefined && descriptor !== undefined && descriptor.configurable) {
        Object.defineProperty(window.CSS, 'highlights', { value: undefined, configurable: true, writable: true })
        const context2 = createFakeContext()
        const plugin = window.__pluginDefinition.factory(window.__requireModule)
        let threw = false
        try {
          plugin.apply(context2)
        } catch {
          threw = true
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
        const registration2 = registrations.filter((entry) => entry.id === 'jev-highlight-chip').pop()
        const unsupported = {
          threw,
          styleInjected: document.querySelectorAll('style[data-jev-highlight]').length,
          chipRegistered: registration2 !== undefined,
        }
        check('unsupported browser: apply does not throw', threw === false, unsupported)
        check('unsupported browser: no highlight stylesheet injected', unsupported.styleInjected === 0, unsupported)
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose()
          } catch (error) {
            report.errors.push(`unsupported disposer threw: ${errorsText(error)}`)
          }
        }
        Object.defineProperty(window.CSS, 'highlights', descriptor)
        result.unsupported = unsupported
      } else {
        result.unsupported = { skipped: 'CSS.highlights is not configurable in this browser' }
        check('unsupported probe skipped (non-configurable CSS.highlights)', true, result.unsupported)
      }

      report.phases.phase2 = result
      report.ok = report.checks.every((entry) => entry.pass)
      window.__fixture.phase = 'done'
      setStatus(`fixture phase2: ${report.ok ? 'OK' : 'FAIL'} · ${report.checks.filter((entry) => entry.pass).length}/${report.checks.length} checks passed`)
      document.title = report.ok ? 'FIXTURE ALL OK' : 'FIXTURE FAIL'
      window.__fixtureReport = report
      return report
    } catch (error) {
      report.errors.push(errorsText(error))
      window.__fixture.phase = 'error'
      setStatus(`fixture phase2 error: ${errorsText(error)}`)
      document.title = 'FIXTURE PHASE2 ERROR'
      return report
    }
  }

  window.__bootFixture = boot
  window.__fixture.phase2 = phase2
})()
