/**
 * Browser half of the @local/dsh-web-search-brave bundle.
 *
 * Registers the plugin's configuration form on the Plugins page: the
 * web-search-brave row (bundle page) gains a configure control whose page
 * renders this schema-backed form. The token field is where the user pastes
 * their Brave subscription key — the bark-notify pattern. Values and writes
 * are Host-owned — the props.form face from the plugin manager page (state +
 * mutate over the settings namespace `web-search-brave`) — so saving writes
 * the profile patch through the standard configuration editor and the Host
 * half picks the volatile values up live, without a restart.
 *
 * Styling follows the host: only `--dsw-*` theme tokens and class names under
 * the `dswsb-` prefix.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-web-search-brave',
  factory (require) {
    const React = require('react')
    const { createElement: h, useState, useEffect } = React

    const NS = 'web-search-brave'
    const SETTINGS_NAMESPACE = 'web-search-brave'
    const ROW_CONFIG_KEY = '@local/dsh-web-search-brave#web-search-brave'
    const BUNDLE_CONFIG_KEY = '@local/dsh-web-search-brave'

    const zh = {
      'summary.off': '未配置密钥（回退环境变量 BRAVE_API_KEY）',
      'summary.on': '已配置密钥，web_search 可用',
      'form.apiKey': 'Brave API 密钥',
      'form.apiKeyHint': '在 api-dashboard.search.brave.com 的 API Keys 页获取；留空则回退启动环境里的 BRAVE_API_KEY',
      'form.baseURL': 'API 根地址',
      'form.baseURLHint': '默认 https://api.search.brave.com/res/v1，留空自动；走代理时填同路径结构的地址',
      'form.country': '国家/地区代码',
      'form.countryHint': 'ISO 3166 两位代码，如 cn、us；留空由 Brave 自动判定',
      'form.searchLang': '搜索语言',
      'form.searchLangHint': '如 zh-hans、en；留空由 Brave 自动判定',
      'form.resultFilter': '结果类型',
      'form.resultFilterHint': '逗号分隔的结果分组；默认 web,news，可加 videos、discussions',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.saved': '已保存，立即生效',
      'form.saveFailed': '保存失败，请重试',
      'form.unavailable': '配置暂不可用',
      'form.loading': '加载中…',
    }
    const en = {
      'summary.off': 'No key configured (falls back to BRAVE_API_KEY)',
      'summary.on': 'Key configured — web_search available',
      'form.apiKey': 'Brave API key',
      'form.apiKeyHint': 'From the API Keys page at api-dashboard.search.brave.com; empty falls back to BRAVE_API_KEY in the launch environment',
      'form.baseURL': 'API base URL',
      'form.baseURLHint': 'Default https://api.search.brave.com/res/v1; empty = automatic. Point a proxy at the same path structure',
      'form.country': 'Country code',
      'form.countryHint': 'ISO 3166 two-letter code such as cn, us; empty lets Brave decide',
      'form.searchLang': 'Search language',
      'form.searchLangHint': 'Such as zh-hans, en; empty lets Brave decide',
      'form.resultFilter': 'Result types',
      'form.resultFilterHint': 'Comma-separated result groups; default web,news, add videos, discussions',
      'form.save': 'Save',
      'form.saving': 'Saving…',
      'form.saved': 'Saved — effective immediately',
      'form.saveFailed': 'Save failed, please retry',
      'form.unavailable': 'Configuration unavailable',
      'form.loading': 'Loading…',
    }

    let translate = key => (zh[key] ?? key)
    const t = key => translate(key)

    const css = `
.dswsb-form{max-width:560px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dswsb-field{display:flex;flex-direction:column;gap:6px}
.dswsb-label{color:var(--dsw-alias-label-primary);font-weight:600}
.dswsb-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.dswsb-input{height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);font:inherit}
.dswsb-input:focus{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dswsb-input:disabled{opacity:.5}
.dswsb-actions{display:flex;align-items:center;gap:12px}
.dswsb-save{height:30px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:999px;background:var(--dsw-alias-button-info);color:var(--dsw-alias-button-info-text);font-size:13px;cursor:pointer}
@media (hover:hover){.dswsb-save:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}}
.dswsb-save:disabled{opacity:.5;cursor:default}
.dswsb-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dswsb-error{color:var(--dsw-alias-state-danger-default);font-size:12px;margin:0}
.dswsb-summary{color:var(--dsw-alias-label-tertiary)}
`

    /** Every field is a plain string; the token renders as a password box. */
    const TEXT_FIELDS = [
      ['apiKey', 'form.apiKey', 'form.apiKeyHint'],
      ['baseURL', 'form.baseURL', 'form.baseURLHint'],
      ['country', 'form.country', 'form.countryHint'],
      ['searchLang', 'form.searchLang', 'form.searchLangHint'],
      ['resultFilter', 'form.resultFilter', 'form.resultFilterHint'],
    ]

    function BraveSearchConfigForm ({ view, form }) {
      // Every hook runs before any conditional return, so the summary and
      // page views never change this instance's hook order.
      useEffect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', JSON.stringify(NS))
        style.textContent = css
        document.head.append(style)
        return () => style.remove()
      }, [])
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [note, setNote] = useState(null)

      if (view === 'summary') {
        const value = form?.state?.value
        const enabled = typeof value?.apiKey === 'string' && value.apiKey.trim() !== ''
        return h('span', { className: 'dswsb-summary' }, t(enabled ? 'summary.on' : 'summary.off'))
      }
      if (form === undefined) return h('p', { className: 'dswsb-note' }, t('form.unavailable'))
      const state = form.state
      const ready = state?.status === 'ready' && state.value !== undefined
      const value = ready ? state.value : {}
      const current = draft ?? {}
      const read = (key, fallback) => (key in current ? current[key] : value[key] ?? fallback)
      const dirty = draft !== null

      const save = async () => {
        if (!ready || saving) return
        setSaving(true)
        setNote(null)
        const ops = []
        for (const [key] of TEXT_FIELDS) {
          if (!(key in current)) continue
          const next = current[key]
          if (next === value[key]) continue
          ops.push({ op: 'set', path: [key], value: next })
        }
        if (ops.length === 0) {
          setDraft(null)
          setNote('form.saved')
          setSaving(false)
          return
        }
        const ok = await form.mutate(ops, state.revision)
        setSaving(false)
        if (ok) {
          setDraft(null)
          setNote('form.saved')
        } else setNote('form.saveFailed')
      }

      if (!ready) {
        return h('div', { className: 'dswsb-form' }, h('p', { className: 'dswsb-note' },
          state?.status === 'loading' ? t('form.loading') : t('form.unavailable')))
      }

      const disabled = saving || state.writable === false
      return h('div', { className: 'dswsb-form' },
        ...TEXT_FIELDS.map(([key, labelKey, hintKey]) => h('label', { className: 'dswsb-field', key },
          h('span', { className: 'dswsb-label' }, t(labelKey)),
          h('input', {
            className: 'dswsb-input',
            type: key === 'apiKey' ? 'password' : 'text',
            value: read(key, ''),
            disabled,
            autoComplete: 'off',
            spellCheck: false,
            onChange: event => setDraft({ ...current, [key]: event.target.value }),
          }),
          h('p', { className: 'dswsb-hint' }, t(hintKey)),
        )),
        h('div', { className: 'dswsb-actions', key: 'actions' },
          h('button', {
            type: 'button',
            className: 'dswsb-save',
            disabled: disabled || !dirty,
            onClick: save,
          }, t(saving ? 'form.saving' : 'form.save')),
          note === null ? null : h('p', {
            className: note === 'form.saveFailed' ? 'dswsb-error' : 'dswsb-note',
          }, t(note)),
        ),
      )
    }

    /** Re-render on every snapshot change of one host-owned config form. */
    function useFormController (controller) {
      const [snapshot, setSnapshot] = useState(() => controller?.getSnapshot())
      useEffect(() => {
        if (controller === undefined) return
        setSnapshot(controller.getSnapshot())
        return controller.subscribe(() => setSnapshot(controller.getSnapshot()))
      }, [controller])
      return snapshot
    }

    /** Bundle-page face: pulls the settings form itself via the configForms service. */
    function BraveSearchBundleConfig ({ view, configForms }) {
      useEffect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', JSON.stringify(NS))
        style.textContent = css
        return () => style.remove()
      }, [])
      const controller = configForms?.get(SETTINGS_NAMESPACE)
      const state = useFormController(controller)
      if (view === 'summary') return null
      if (controller === undefined || state === undefined) {
        return h('div', { className: 'dswsb-form' }, h('p', { className: 'dswsb-note' }, t('form.unavailable')))
      }
      return h(BraveSearchConfigForm, { view: 'page', form: { state, mutate: (ops, revision) => controller.mutate(ops, revision) } })
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply (ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          ctx.effect(() => locale.register(NS, { zh, en }), 'web-search-brave: dictionaries')
          translate = locale.bind(NS)
        }
        const slots = ctx.get('slots')
        if (slots === undefined) throw new Error('web-search-brave requires the slots service')
        ctx.effect(() => slots.inject('plugins.row.config', () => slots.register(
          {
            name: 'plugins.row.config',
            key: ROW_CONFIG_KEY,
            locale: NS,
          },
          BraveSearchConfigForm,
        )), 'web-search-brave: plugins row config')
        ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register(
          {
            name: 'plugins.bundle.config',
            key: BUNDLE_CONFIG_KEY,
            locale: NS,
            inject: () => ({ configForms: ctx.get('configForms') }),
          },
          BraveSearchBundleConfig,
        )), 'web-search-brave: plugins bundle config')
      },
    }
  },
})
