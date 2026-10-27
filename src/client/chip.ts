/**
 * The `conversation.composer.dock` chip.
 *
 * Shows the host's per-level counts plus the master switch. All copy goes
 * through the Client locale service when it exists (dictionaries registered
 * below), with a defensive built-in translator as fallback.
 */

import type { ChipController, ChipProps, LocaleService, ReactLike, ViewState } from './types.js'
import { NS } from './types.js'
import { CHIP_CLASS } from './styles.js'

/** ZH dictionary (CJK). */
const ZH: Record<string, string> = {
  'chip.label': 'Jev',
  'chip.title': 'Jev 重点高亮',
  'chip.toggleAria': '开启或关闭 Jev 重点高亮',
  'chip.on': '开',
  'chip.off': '关',
  'chip.enabled': '高亮已开启',
  'chip.disabled': '高亮已关闭',
  'chip.critical': '重点',
  'chip.medium': '中等',
  'chip.low': '弱',
  'chip.counts': '重点 {critical} · 中等 {medium} · 弱 {low}',
  'chip.unsupported': '浏览器不支持高亮',
  'chip.waiting': '等待 Host…',
  'chip.noKey': '缺 API key',
  'chip.error': '路由错误：{error}',
  'chip.model': '模型：{model}',
  'settings.tab': 'Jev 高亮',
  'settings.title': 'Jev 重点高亮',
  'settings.intro': '用 StartLux（国产决策模型，Bamboo Relay）或 TypeSafe Jev 判断 agent 流式输出中的重点内容，并按置信度强度高亮。API Key 只写入宿主，不会返回浏览器。',
  'settings.loading': '读取中…',
  'settings.provider': '提供方',
  'settings.startlux': 'StartLux-Decision（Bamboo Relay）',
  'settings.jev': 'TypeSafe Jev',
  'settings.model': '模型',
  'settings.endpoint': '接口',
  'settings.thinkMode': '思考模式',
  'settings.thinkLabel': '思考模式',
  'settings.think.never': 'never（最快）',
  'settings.think.auto': 'auto（不确定才思考）',
  'settings.think.always': 'always（每题都思考）',
  'settings.thinkDefaultLabel': '默认',
  'settings.thinkHint': 'never 最快（约 1s/请求）；auto 只在 top<0.6 时思考（约 3–4s）；always 每题都思考（约 5–6s）。修改立即生效，无需重启。',
  'settings.thinkSaved': '思考模式已切换为 {mode}，立即生效。',
  'settings.thinkFailed': '切换思考模式失败：{error}',
  'settings.thresholds': '高亮阈值',
  'settings.thresholdCritical': '重点 critical ≥',
  'settings.thresholdMedium': '中等 medium ≥',
  'settings.thresholdLow': '弱 low ≥',
  'settings.presetSensitive': '敏感 preset',
  'settings.presetConservative': '保守 preset',
  'settings.presetDefault': '恢复默认',
  'settings.thresholdsSave': '保存阈值',
  'settings.thresholdsSource': '当前来源',
  'settings.thresholdsSourceSettings': '设置页覆盖',
  'settings.thresholdsSourceConfig': '配置默认（敏感 preset）',
  'settings.thresholdsDirty': '有未保存修改',
  'settings.thresholdsHint': '取值 0–1，需满足 critical ≥ medium ≥ low。保存后会重算已判定内容的档位并立即刷新高亮；恢复默认会删除设置页覆盖，回到配置默认。StartLux 默认 .52/.37/.24，Jev 默认 .85/.65/.45。',
  'settings.thresholdsSaved': '阈值已保存，已有高亮已按新阈值重算。',
  'settings.thresholdsReset': '已恢复默认阈值。',
  'settings.thresholdsInvalid': '阈值必须是 0–1 的数字，且 critical ≥ medium ≥ low。',
  'settings.thresholdsFailed': '阈值保存失败：{error}',
  'settings.keyStatus': 'API Key',
  'settings.keyConfigured': '已配置',
  'settings.keyMissing': '未配置',
  'settings.keyFile': 'Key 文件',
  'settings.keyHelp': '在这里粘贴 Bamboo / StartLux API Key（通常以 bk- 开头），保存后立即生效，无需重启。',
  'settings.jevKeyHelp': '当前使用 TypeSafe Jev：请在启动环境里设置 JEV_API_KEY，或写入 $DSH_HOME/.credentials.yaml 的 jevApiKey（本页的 Key 输入只用于 StartLux）。',
  'settings.keyPlaceholder': '粘贴 StartLux / Bamboo API Key',
  'settings.show': '显示',
  'settings.hide': '隐藏',
  'settings.save': '保存',
  'settings.clear': '清除',
  'settings.check': '测试连接',
  'settings.saved': 'API Key 已保存，判断已启用。',
  'settings.cleared': 'API Key 已清除，判断已暂停。',
  'settings.saveFailed': '保存失败：{error}',
  'settings.requestFailed': '请求失败：{error}',
  'settings.checkOk': '连接正常：{latency}ms，模型 {model}，健康问题 P(yes)={answer}',
  'settings.checkFailed': '连接失败：{error}',
  'settings.needSaveFirst': '请先在上方粘贴 API Key 并点击“保存”（或直接点“测试连接”，会自动先保存）。',
  'settings.unknownError': '未知错误',
  'settings.securityHint': 'Key 以 0600（尽力）写入本机 key 文件；界面与日志都不会回显。',
}

/** EN dictionary (CJK-free). */
const EN: Record<string, string> = {
  'chip.label': 'Jev',
  'chip.title': 'Jev importance highlight',
  'chip.toggleAria': 'Toggle Jev importance highlight',
  'chip.on': 'On',
  'chip.off': 'Off',
  'chip.enabled': 'Highlight enabled',
  'chip.disabled': 'Highlight disabled',
  'chip.critical': 'critical',
  'chip.medium': 'medium',
  'chip.low': 'low',
  'chip.counts': 'critical {critical} · medium {medium} · low {low}',
  'chip.unsupported': 'Highlight API unsupported',
  'chip.waiting': 'Waiting for host…',
  'chip.noKey': 'API key missing',
  'chip.error': 'route error: {error}',
  'chip.model': 'model: {model}',
  'settings.tab': 'Jev Highlight',
  'settings.title': 'Jev importance highlight',
  'settings.intro': 'Judge important streamed agent content with StartLux (domestic decision model via Bamboo Relay) or TypeSafe Jev, then highlight it by confidence. The API key is written host-side only and never returned to the browser.',
  'settings.loading': 'Loading…',
  'settings.provider': 'Provider',
  'settings.startlux': 'StartLux-Decision (Bamboo Relay)',
  'settings.jev': 'TypeSafe Jev',
  'settings.model': 'Model',
  'settings.endpoint': 'Endpoint',
  'settings.thinkMode': 'Think mode',
  'settings.thinkLabel': 'Think mode',
  'settings.think.never': 'never (fastest)',
  'settings.think.auto': 'auto (only when unsure)',
  'settings.think.always': 'always (every question)',
  'settings.thinkDefaultLabel': 'Default',
  'settings.thinkHint': 'never ≈1s/request; auto thinks only when top<0.6 (≈3–4s); always thinks on every question (≈5–6s). Changes apply immediately, no restart.',
  'settings.thinkSaved': 'Think mode switched to {mode}; applied immediately.',
  'settings.thinkFailed': 'Failed to switch think mode: {error}',
  'settings.thresholds': 'Highlight thresholds',
  'settings.thresholdCritical': 'critical ≥',
  'settings.thresholdMedium': 'medium ≥',
  'settings.thresholdLow': 'low ≥',
  'settings.presetSensitive': 'Sensitive preset',
  'settings.presetConservative': 'Conservative preset',
  'settings.presetDefault': 'Restore default',
  'settings.thresholdsSave': 'Save thresholds',
  'settings.thresholdsSource': 'Source',
  'settings.thresholdsSourceSettings': 'Settings override',
  'settings.thresholdsSourceConfig': 'Config default (sensitive preset)',
  'settings.thresholdsDirty': 'unsaved changes',
  'settings.thresholdsHint': 'Values 0–1 with critical ≥ medium ≥ low. Saving re-levels existing verdicts and refreshes highlights immediately; Restore default removes the Settings override. StartLux default .52/.37/.24, Jev default .85/.65/.45.',
  'settings.thresholdsSaved': 'Thresholds saved; existing highlights re-levelled.',
  'settings.thresholdsReset': 'Restored the default thresholds.',
  'settings.thresholdsInvalid': 'Thresholds must be numbers in 0–1 with critical ≥ medium ≥ low.',
  'settings.thresholdsFailed': 'Failed to save thresholds: {error}',
  'settings.keyStatus': 'API key',
  'settings.keyConfigured': 'Configured',
  'settings.keyMissing': 'Missing',
  'settings.keyFile': 'Key file',
  'settings.keyHelp': 'Paste the Bamboo / StartLux API key here (usually starts with bk-). Saving takes effect immediately, no restart.',
  'settings.jevKeyHelp': 'TypeSafe Jev is active: set JEV_API_KEY in the launching environment or write jevApiKey into $DSH_HOME/.credentials.yaml (this input only stores StartLux keys).',
  'settings.keyPlaceholder': 'Paste StartLux / Bamboo API key',
  'settings.show': 'Show',
  'settings.hide': 'Hide',
  'settings.save': 'Save',
  'settings.clear': 'Clear',
  'settings.check': 'Test connection',
  'settings.saved': 'API key saved; judging is enabled.',
  'settings.cleared': 'API key cleared; judging is paused.',
  'settings.saveFailed': 'Save failed: {error}',
  'settings.requestFailed': 'Request failed: {error}',
  'settings.checkOk': 'Endpoint OK: {latency}ms, model {model}, health P(yes)={answer}',
  'settings.checkFailed': 'Connection failed: {error}',
  'settings.needSaveFirst': 'Paste the API key above and click Save first (or click Test connection, which saves it automatically).',
  'settings.unknownError': 'unknown error',
  'settings.securityHint': 'The key is written to a local key file (mode 0600, best effort); the UI and logs never echo it.',
}

/** Dictionaries registered with the host locale service, one entry per language. */
export const DICTS: Record<string, Record<string, string>> = { zh: ZH, 'zh-CN': ZH, en: EN }

/** Format `{placeholder}` tokens like the host locale service does. */
function format(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, token: string) => {
    const value = params[token]
    return value === undefined ? match : String(value)
  })
}

/** Page-language guess used only when the host locale service is absent. */
function guessLanguage(): 'zh' | 'en' {
  const language = typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string' ? navigator.language : 'en'
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Resolve the translator for the plugin application.
 *
 * Prefers `ctx.locale.bind(NS)`; falls back to the built-in dictionaries so a
 * browser without the locale service still renders readable copy.
 */
export function createTranslator(locale: LocaleService | undefined): (key: string, params?: Record<string, string | number>) => string {
  const fallbackDictionary = guessLanguage() === 'zh' ? ZH : EN
  if (locale !== undefined && typeof locale.bind === 'function') {
    try {
      const bound = locale.bind(NS)
      if (typeof bound === 'function') {
        return (key, params) => {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== key) return format(value, params)
          } catch {
            /* fall through to built-in dictionary */
          }
          const fallback = fallbackDictionary[key] ?? EN[key] ?? key
          return format(fallback, params)
        }
      }
    } catch {
      /* fall through to built-in dictionary */
    }
  }
  return (key, params) => format(fallbackDictionary[key] ?? EN[key] ?? key, params)
}

function renderCount(React: ReactLike, key: string, level: string, label: string, count: number, title: string): unknown {
  return React.createElement(
    'span',
    { key, className: 'jev-chip-count', title, 'aria-label': `${title} ${String(count)}` },
    React.createElement('span', { className: 'jev-chip-dot', 'data-level': level, 'aria-hidden': 'true' }),
    React.createElement('span', null, String(count)),
  )
}

/**
 * Build the React component bound to one controller/translator pair.
 *
 * Kept as a factory so the module can be bundled without a live React import
 * (React arrives through the module loader's `require('react')`). The real
 * `conversation.composer.dock` registration only accepts `id`/`order`/`label`
 * — there is no `inject` prop channel — so the controller and translator are
 * captured in this closure instead of being read from slot props.
 */
export function createChipComponent(
  React: ReactLike,
  initialTranslator: (key: string, params?: Record<string, string | number>) => string,
  controllerArg?: ChipController,
): (props?: Partial<ChipProps>) => unknown {
  return function JevHighlightChip(slotProps?: Partial<ChipProps>): unknown {
    const controller: ChipController | undefined = controllerArg ?? slotProps?.controller
    const t = slotProps !== undefined && typeof slotProps.t === 'function' ? slotProps.t : initialTranslator
    const [view, setView] = React.useState<ViewState | null>(() => (controller === undefined ? null : controller.getState()))

    React.useEffect(() => {
      if (controller === undefined) return undefined
      return controller.subscribe(() => {
        setView(controller.getState())
      })
    }, [controller])

    if (controller === undefined || view === null) return null
    const on = view.enabled
    const status = !view.supported
      ? t('chip.unsupported')
      : !view.keyConfigured
        ? t('chip.noKey')
        : !view.ready
          ? t('chip.waiting')
          : null
    const titleParts = [t('chip.title'), on ? t('chip.enabled') : t('chip.disabled')]
    if (!view.keyConfigured) titleParts.push(t('chip.noKey'))
    if (view.model !== '') titleParts.push(t('chip.model', { model: view.model }))
    if (view.error !== null) titleParts.push(t('chip.error', { error: view.error }))
    const title = titleParts.join(' · ')

    const children: unknown[] = [
      React.createElement('span', { key: 'label', className: 'jev-chip-label' }, t('chip.label')),
    ]
    if (status !== null) {
      children.push(React.createElement('span', { key: 'status', className: 'jev-chip-status' }, status))
    } else {
      children.push(renderCount(React, 'count-critical', 'critical', t('chip.critical'), view.counts.critical, t('chip.critical')))
      children.push(renderCount(React, 'count-medium', 'medium', t('chip.medium'), view.counts.medium, t('chip.medium')))
      children.push(renderCount(React, 'count-low', 'low', t('chip.low'), view.counts.low, t('chip.low')))
    }
    children.push(
      React.createElement(
        'button',
        {
          key: 'toggle',
          type: 'button',
          className: 'jev-chip-toggle',
          'data-on': on ? 'true' : 'false',
          disabled: view.busy || !view.keyConfigured,
          'aria-label': t('chip.toggleAria'),
          'aria-pressed': on ? 'true' : 'false',
          onClick: (event: unknown) => {
            if (typeof event === 'object' && event !== null && 'stopPropagation' in event && typeof (event as { stopPropagation: unknown }).stopPropagation === 'function') {
              ;(event as { stopPropagation: () => void }).stopPropagation()
            }
            if (!view.busy && view.keyConfigured) controller.toggle()
          },
        },
        view.busy ? '…' : !view.keyConfigured ? t('chip.noKey') : on ? t('chip.on') : t('chip.off'),
      ),
    )

    return React.createElement(
      'div',
      {
        className: CHIP_CLASS,
        'data-jev-highlight-ui': '',
        'data-enabled': on ? 'true' : 'false',
        'data-supported': view.supported ? 'true' : 'false',
        'data-key-configured': view.keyConfigured ? 'true' : 'false',
        'data-ready': view.ready ? 'true' : 'false',
        title,
        role: 'group',
        'aria-label': title,
      },
      ...children,
    )
  }
}
