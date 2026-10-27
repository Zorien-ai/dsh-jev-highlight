/**
 * Settings → 插件 → Jev 高亮 tab.
 *
 * Lets the user type the StartLux / Bamboo API key in the DSH Settings UI
 * (write-only: only status metadata travels back), test the endpoint, and see
 * which provider/model is active. The component is registered by
 * controller.ts under the `settings.plugins.tab` slot; it keeps no host state
 * and re-reads /jev-highlight/provider on mount and after every action.
 */
import type { HostApi } from './http.js'
import type { ReactLike } from './types.js'

/** Provider/key status returned by GET /jev-highlight/provider. */
export interface ProviderView {
  provider: string
  model: string
  baseUrl: string
  endpointPath: string
  thinkMode: string
  keyConfigured: boolean
  keySource: string | null
  keyFile: string
  keyRequired: boolean
  thresholds: { critical: number; medium: number; low: number }
  thresholdsSource: 'settings' | 'config'
}

interface CheckView {
  ok: boolean
  provider?: string
  model?: string
  latencyMs?: number
  modelReturned?: string
  answer?: number
  error?: string
}

export type Translate = (key: string, params?: Record<string, string | number>) => string

const CSS = `
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
`

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readProvider(value: unknown): ProviderView | null {
  const record = asRecord(value)
  if (record === null) return null
  const provider = typeof record.provider === 'string' ? record.provider : ''
  if (provider === '') return null
  return {
    provider,
    model: typeof record.model === 'string' ? record.model : '',
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    endpointPath: typeof record.endpointPath === 'string' ? record.endpointPath : '',
    thinkMode: typeof record.thinkMode === 'string' ? record.thinkMode : '',
    keyConfigured: record.keyConfigured === true,
    keySource: typeof record.keySource === 'string' ? record.keySource : null,
    keyFile: typeof record.keyFile === 'string' ? record.keyFile : '',
    keyRequired: record.keyRequired === true,
    thresholds: readThresholds(record.thresholds),
    thresholdsSource: record.thresholdsSource === 'settings' ? 'settings' : 'config',
  }
}

const DEFAULT_THRESHOLD_VIEW = { critical: 0.52, medium: 0.37, low: 0.24 }

function readThresholds(value: unknown): { critical: number; medium: number; low: number } {
  const record = asRecord(value)
  if (record === null) return { ...DEFAULT_THRESHOLD_VIEW }
  const read = (key: 'critical' | 'medium' | 'low'): number => {
    const candidate = record[key]
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : DEFAULT_THRESHOLD_VIEW[key]
  }
  return { critical: read('critical'), medium: read('medium'), low: read('low') }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Build the settings tab component closed over its transport and translator. */
export function createSettingsComponent(
  React: ReactLike,
  api: HostApi,
  t: Translate,
): (props?: Record<string, unknown>) => unknown {
  return function JevHighlightSettings(): unknown {
    const [provider, setProvider] = React.useState<ProviderView | null>(null)
    const [draft, setDraft] = React.useState('')
    const [reveal, setReveal] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [message, setMessage] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
    const [check, setCheck] = React.useState<CheckView | null>(null)
    const [thresholds, setThresholds] = React.useState<{ critical: string; medium: string; low: string; dirty: boolean }>({
      critical: '',
      medium: '',
      low: '',
      dirty: false,
    })

    const refresh = async (): Promise<void> => {
      try {
        const body = await api.get('provider')
        const next = readProvider(body.provider)
        if (next !== null) setProvider(next)
        if (next !== null) {
          setThresholds((previous) =>
            previous.dirty
              ? previous
              : {
                  critical: String(next.thresholds.critical),
                  medium: String(next.thresholds.medium),
                  low: String(next.thresholds.low),
                  dirty: false,
                },
          )
        }
      } catch {
        // The host half may not be mounted yet; the next poll retries.
      }
    }

    React.useEffect(() => {
      void refresh()
      const timer = setInterval(() => {
        void refresh()
      }, 5000)
      return () => {
        clearInterval(timer)
      }
    }, [api])

    const run = async (operation: () => Promise<void>): Promise<void> => {
      if (busy) return
      setBusy(true)
      try {
        await operation()
      } catch (error) {
        setMessage({ kind: 'error', text: t('settings.requestFailed', { error: errorText(error) }) })
      } finally {
        setBusy(false)
      }
    }

    const saveDraft = async (): Promise<boolean> => {
      const body = await api.post('key', { action: 'save', key: draft })
      const status = readProvider(body.provider)
      if (status !== null) setProvider(status)
      if (body.ok === true) {
        setDraft('')
        setCheck(null)
        setMessage({ kind: 'ok', text: t('settings.saved') })
        await refresh()
        return true
      }
      setMessage({
        kind: 'error',
        text: t('settings.saveFailed', { error: typeof body.error === 'string' ? body.error : t('settings.unknownError') }),
      })
      return false
    }

    const save = (): void => {
      if (draft.trim() === '') return
      void run(async () => {
        await saveDraft()
      })
    }

    const clear = (): void => {
      void run(async () => {
        const body = await api.post('key', { action: 'clear' })
        const status = readProvider(body.provider)
        if (status !== null) setProvider(status)
        setDraft('')
        setCheck(null)
        setMessage(
          body.ok === true
            ? { kind: 'ok', text: t('settings.cleared') }
            : { kind: 'error', text: t('settings.saveFailed', { error: typeof body.error === 'string' ? body.error : t('settings.unknownError') }) },
        )
      })
    }

    const applyThresholdStatus = (body: Record<string, unknown>): void => {
      const status = readProvider(body.provider)
      if (status !== null) setProvider(status)
      const values = readThresholds(body.thresholds)
      setThresholds({ critical: String(values.critical), medium: String(values.medium), low: String(values.low), dirty: false })
    }

    const presetThresholds = (critical: number, medium: number, low: number): void => {
      setThresholds({ critical: String(critical), medium: String(medium), low: String(low), dirty: true })
    }

    const saveThresholds = (): void => {
      const numbers = {
        critical: Number(thresholds.critical),
        medium: Number(thresholds.medium),
        low: Number(thresholds.low),
      }
      if (!Number.isFinite(numbers.critical) || !Number.isFinite(numbers.medium) || !Number.isFinite(numbers.low)) {
        setMessage({ kind: 'error', text: t('settings.thresholdsInvalid') })
        return
      }
      void run(async () => {
        const body = await api.post('thresholds', numbers)
        if (body.ok === true) {
          applyThresholdStatus(body)
          setMessage({ kind: 'ok', text: t('settings.thresholdsSaved') })
        } else {
          setMessage({
            kind: 'error',
            text: t('settings.thresholdsFailed', { error: typeof body.error === 'string' ? body.error : t('settings.unknownError') }),
          })
        }
      })
    }

    const resetThresholds = (): void => {
      void run(async () => {
        const body = await api.post('thresholds', { action: 'reset' })
        if (body.ok === true) {
          applyThresholdStatus(body)
          setMessage({ kind: 'ok', text: t('settings.thresholdsReset') })
        } else {
          setMessage({
            kind: 'error',
            text: t('settings.thresholdsFailed', { error: typeof body.error === 'string' ? body.error : t('settings.unknownError') }),
          })
        }
      })
    }

    const test = (): void => {
      void run(async () => {
        // Convenience: a typed-but-unsaved key is saved first, so "测试连接"
        // never reports the confusing "no key" error for a key already visible
        // in the input box.
        if (provider !== null && !provider.keyConfigured) {
          if (draft.trim() === '') {
            setMessage({ kind: 'error', text: t('settings.needSaveFirst') })
            return
          }
          const saved = await saveDraft()
          if (!saved) return
        }
        const body = await api.post('check', {})
        const result: CheckView = {
          ok: body.ok === true,
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : undefined,
          modelReturned: typeof body.modelReturned === 'string' ? body.modelReturned : undefined,
          answer: typeof body.answer === 'number' ? body.answer : undefined,
          error: typeof body.error === 'string' ? body.error : undefined,
        }
        setCheck(result)
      })
    }

    const selectThinkMode = (mode: string): void => {
      void run(async () => {
        const body = await api.post('think', { mode })
        const status = readProvider(body.provider)
        if (status !== null) setProvider(status)
        if (body.ok === true) {
          setMessage({
            kind: 'ok',
            text: t('settings.thinkSaved', { mode: mode === 'default' ? t('settings.thinkDefaultLabel') : t(`settings.think.${mode}`) }),
          })
        } else {
          setMessage({
            kind: 'error',
            text: t('settings.thinkFailed', {
              error: typeof body.error === 'string' ? body.error : t('settings.unknownError'),
            }),
          })
        }
      })
    }

    const providerLabel = provider === null ? t('settings.loading') : provider.provider === 'startlux' ? t('settings.startlux') : t('settings.jev')
    const statusOk = provider !== null && provider.keyConfigured
    const isStartLux = provider !== null && provider.provider === 'startlux'

    const rows: unknown[] = []
    const row = (key: string, value: unknown): void => {
      rows.push(
        React.createElement(
          'div',
          { className: 'jev-settings-row', key },
          React.createElement('span', { className: 'jev-settings-key' }, t(key)),
          React.createElement('span', { className: 'jev-settings-value' }, value),
        ),
      )
    }
    row('settings.provider', providerLabel)
    if (provider !== null) {
      row('settings.model', provider.model)
      row('settings.endpoint', `${provider.baseUrl}${provider.endpointPath}`)
      if (provider.provider === 'startlux') row('settings.thinkMode', t(`settings.think.${provider.thinkMode}`))
      row(
        'settings.keyStatus',
        React.createElement(
          'span',
          { className: 'jev-settings-status', 'data-ok': statusOk ? 'true' : 'false' },
          statusOk ? t('settings.keyConfigured') : t('settings.keyMissing'),
          provider.keySource !== null ? React.createElement('span', { className: 'jev-settings-hint' }, ` · ${provider.keySource}`) : null,
        ),
      )
      if (provider.provider === 'startlux') row('settings.keyFile', provider.keyFile)
    }

    const checkNode =
      check === null
        ? null
        : React.createElement(
            'div',
            { className: 'jev-settings-message', 'data-kind': check.ok ? 'ok' : 'error', key: 'check' },
            check.ok
              ? t('settings.checkOk', {
                  latency: check.latencyMs !== undefined ? String(check.latencyMs) : '?',
                  model: check.modelReturned !== undefined ? check.modelReturned : check.model !== undefined ? check.model : '',
                  answer: check.answer !== undefined ? check.answer.toFixed(3) : 'n/a',
                })
              : t('settings.checkFailed', {
                  error:
                    check.error !== undefined && /No StartLux API key|not configured/iu.test(check.error)
                      ? t('settings.needSaveFirst')
                      : check.error !== undefined
                        ? check.error
                        : t('settings.unknownError'),
                }),
          )

    return React.createElement(
      'div',
      { className: 'jev-settings' },
      React.createElement('style', { key: 'style' }, CSS),
      React.createElement('h2', null, t('settings.title')),
      React.createElement('p', null, t('settings.intro')),
      React.createElement('div', { className: 'jev-settings-card' }, ...rows),
      React.createElement(
        'div',
        { className: 'jev-settings-card' },
        React.createElement('p', null, isStartLux ? t('settings.keyHelp') : t('settings.jevKeyHelp')),
        React.createElement(
          'div',
          { className: 'jev-settings-inputRow' },
          React.createElement('input', {
            type: reveal ? 'text' : 'password',
            value: draft,
            placeholder: t('settings.keyPlaceholder'),
            autoComplete: 'new-password',
            spellCheck: false,
            disabled: busy || !isStartLux,
            onChange: (event: { target?: { value?: unknown } }) => {
              setDraft(typeof event?.target?.value === 'string' ? event.target.value : '')
            },
            onKeyDown: (event: { key?: string; preventDefault?: () => void }) => {
              if (event?.key !== 'Enter' || busy || !isStartLux || draft.trim() === '') return
              if (typeof event.preventDefault === 'function') event.preventDefault()
              save()
            },
          }),
          React.createElement(
            'button',
            { type: 'button', disabled: busy || !isStartLux, onClick: () => setReveal(!reveal) },
            reveal ? t('settings.hide') : t('settings.show'),
          ),
          React.createElement(
            'button',
            { type: 'button', 'data-primary': 'true', disabled: busy || !isStartLux || draft.trim() === '', onClick: save },
            t('settings.save'),
          ),
          React.createElement('button', { type: 'button', disabled: busy || !isStartLux, onClick: clear }, t('settings.clear')),
          React.createElement('button', { type: 'button', disabled: busy || provider === null, onClick: test }, t('settings.check')),
        ),
        React.createElement('div', { className: 'jev-settings-hint' }, t('settings.securityHint')),
        isStartLux
          ? React.createElement(
              'div',
              { className: 'jev-settings-modeRow', key: 'think-mode' },
              React.createElement('span', { className: 'jev-settings-key' }, t('settings.thinkLabel')),
              ...['never', 'auto', 'always'].map((mode) =>
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'jev-settings-modeBtn',
                    key: mode,
                    'data-active': provider?.thinkMode === mode ? 'true' : 'false',
                    disabled: busy,
                    onClick: () => selectThinkMode(mode),
                  },
                  t(`settings.think.${mode}`),
                ),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'jev-settings-modeBtn',
                  key: 'default',
                  disabled: busy,
                  onClick: () => selectThinkMode('default'),
                },
                t('settings.thinkDefaultLabel'),
              ),
            )
          : null,
        isStartLux ? React.createElement('div', { className: 'jev-settings-hint' }, t('settings.thinkHint')) : null,
        React.createElement(
          'div',
          { className: 'jev-settings-card', key: 'thresholds' },
          React.createElement('p', null, t('settings.thresholds')),
          React.createElement(
            'div',
            { className: 'jev-settings-thresholdRow' },
            ...[
              ['critical', t('settings.thresholdCritical')],
              ['medium', t('settings.thresholdMedium')],
              ['low', t('settings.thresholdLow')],
            ].map(([key, label]) =>
              React.createElement(
                'label',
                { key },
                label,
                React.createElement('input', {
                  type: 'number',
                  min: '0',
                  max: '1',
                  step: '0.01',
                  value: thresholds[key as 'critical' | 'medium' | 'low'],
                  disabled: busy,
                  onChange: (event: { target?: { value?: unknown } }) => {
                    const value = typeof event?.target?.value === 'string' ? event.target.value : ''
                    setThresholds((previous) => ({ ...previous, [key as 'critical' | 'medium' | 'low']: value, dirty: true }))
                  },
                }),
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'jev-settings-inputRow' },
            React.createElement(
              'button',
              { type: 'button', disabled: busy, onClick: () => presetThresholds(0.52, 0.37, 0.24) },
              t('settings.presetSensitive'),
            ),
            React.createElement(
              'button',
              { type: 'button', disabled: busy, onClick: () => presetThresholds(0.63, 0.4, 0.25) },
              t('settings.presetConservative'),
            ),
            React.createElement('button', { type: 'button', disabled: busy, onClick: resetThresholds }, t('settings.presetDefault')),
            React.createElement(
              'button',
              { type: 'button', 'data-primary': 'true', disabled: busy, onClick: saveThresholds },
              t('settings.thresholdsSave'),
            ),
          ),
          React.createElement(
            'div',
            { className: 'jev-settings-thresholdSource' },
            `${t('settings.thresholdsSource')}: ${
              provider?.thresholdsSource === 'settings'
                ? t('settings.thresholdsSourceSettings')
                : t('settings.thresholdsSourceConfig')
            }${thresholds.dirty ? ` · ${t('settings.thresholdsDirty')}` : ''}`,
          ),
          React.createElement('div', { className: 'jev-settings-hint' }, t('settings.thresholdsHint')),
        ),
        checkNode,
        message !== null
          ? React.createElement('div', { className: 'jev-settings-message', 'data-kind': message.kind }, message.text)
          : null,
      ),
    )
  }
}
