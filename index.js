/**
 * @local/dsh-web-search-brave — Brave Search provider for the DSH web
 * capability seam (`ctx.web`).
 *
 * Registers the `brave` search provider: a direct REST call to
 * `https://api.search.brave.com/res/v1/web/search` with an
 * `X-Subscription-Token`. Because it is a plain retrieval endpoint (no model
 * turn), one search is cheap and fast compared with the DeepSeek native
 * provider, and Brave's `count` parameter is applied at the request layer as
 * the seam's cost optimization (the seam still enforces `maxResults`).
 *
 * Seam contract obligations (see @deepseek-ai/dsh-web):
 * - `available()` is a cheap, synchronous, network-free usability check.
 * - `ready(llmProvider)` checks credential PRESENCE only and makes no network
 *   calls; `dsh-tool-web` withdraws the `web_search` tool from requests whose
 *   selected provider answers false. Brave credentials are route-independent,
 *   so the llmProvider argument is intentionally unused.
 * - `search()` honors the caller's AbortSignal; cancellation surfaces as
 *   `WEB_ABORTED`.
 * - `truncated` is always false here: the seam owns `maxResults` truncation.
 *
 * Credential resolution follows the harness-wide order (no new key storage):
 * literal `apiKey` config (the Plugins page form writes the profile patch) →
 * the credentials service under the fixed `BRAVE_API_KEY` reference → the
 * launch-environment snapshot (`BRAVE_API_KEY` in the process env or the
 * Harness home `.env`). Every search re-resolves, so a key pasted into the
 * form or exported later reaches the next search without a plugin restart.
 *
 * All config fields are `.volatile()`: the Plugins page configuration form
 * (and profile patch edits) apply live, and every read happens at use time.
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { WebError } from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under (pin via `searchProvider: brave`). */
const BRAVE_PROVIDER_ID = 'brave'

/**
 * Default API root without the operation path; `/web/search` is appended.
 * `$BRAVE_SEARCH_BASE_URL` overrides it independently of the conversation
 * adapter, mirroring the DeepSeek provider's search endpoint override.
 */
const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1'
const BRAVE_BASE_URL_ENV = 'BRAVE_SEARCH_BASE_URL'
/** Default credential reference: an env-var name resolved per search. */
const BRAVE_DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Brave's `count` hard ceiling; larger `maxResults` fall back to one page. */
const BRAVE_MAX_COUNT = 20

/** Attribution header sent on every request; bump with the package version. */
const USER_AGENT = 'dsh-web-search-brave/1.0.0'

/**
 * Backoff before the single 429 retry. The free tier allows 1 query/second,
 * so crossing into the next second's quota is the documented recovery; the
 * retry is bounded to one and abort-aware.
 */
const RATE_LIMIT_RETRY_DELAY_MS = 1_100

/**
 * Cordis plugin name used by loader diagnostics and patch entries.
 */
export const name = 'web-search-brave'

/** The web seam this provider registers into. */
export const inject = ['web']

export const Config = z.object({
  /** Brave subscription token (`X-Subscription-Token`). Fill it in on the
   *  Plugins page form or the profile user patch — the bark-notify pattern;
   *  empty falls back to `BRAVE_API_KEY` in the launch environment. */
  apiKey: z.string().role('secret').default('').volatile(),
  /** API root (…/res/v1). Empty = `$BRAVE_SEARCH_BASE_URL` → built-in default.
   *  Point at a trusted proxy by setting the same path structure. */
  baseURL: z.string().default('').volatile(),
  /** ISO 3166 country code for result localization (`cn`, `us`, …); empty omits. */
  country: z.string().default('').volatile(),
  /** Search language (`zh-hans`, `en`, …); empty omits. */
  searchLang: z.string().default('').volatile(),
  /** Brave `result_filter`: which result groups to request. The mapper walks
   *  every known group, so adding `videos`/`discussions` here surfaces them. */
  resultFilter: z.string().default('web,news').volatile(),
})

/**
 * Read one config field whether the runtime wrapped it as a volatile
 * reference (`{ get() }`, the Loader's form for `.volatile()` fields) or left
 * a plain value (schema-validated in tests). Falls back when absent.
 */
function field(ref, fallback) {
  const value = typeof ref?.get === 'function' ? ref.get() : ref
  return value === undefined || value === null ? fallback : value
}

/** True when the string is a non-empty string. */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0
}

/** True when a numeric code point can become a character (excludes the
 *  surrogate halves, where fromCodePoint throws). */
function isCharacterCodePoint(parsed) {
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 0x10ffff
    && !(parsed >= 0xd800 && parsed <= 0xdfff)
}

/**
 * Turn a Brave `description` into a clean snippet. Brave HTML-escapes the
 * text, and emphasis markup can appear when text decorations are enabled —
 * the request always disables them, but the strip stays as cheap insurance.
 * Numeric and the common named entities are unescaped; unknown ones are left
 * as-is rather than guessed.
 */
function cleanDescription(description) {
  return description
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo);/gu, match => {
      switch (match) {
        case '&amp;': return '&'
        case '&lt;': return '<'
        case '&gt;': return '>'
        case '&quot;': return '"'
        case '&apos;': return "'"
        case '&nbsp;': return ' '
        case '&hellip;': return '…'
        case '&mdash;': return '—'
        case '&ndash;': return '–'
        case '&rsquo;': return '’'
        case '&lsquo;': return '‘'
        case '&rdquo;': return '”'
        case '&ldquo;': return '“'
        default: return match
      }
    })
    .replace(/&#(?<code>\d+);/gu, (_, code) => {
      const parsed = Number.parseInt(code, 10)
      // Non-entities stay literal instead of becoming replacement characters.
      return isCharacterCodePoint(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/&#x(?<code>[0-9a-f]+);/giu, (_, code) => {
      const parsed = Number.parseInt(code, 16)
      return isCharacterCodePoint(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Brave's `page_age` is an ISO-8601 date when present. Pass it through only
 * when it looks like one (date or full timestamp); anything else is omitted
 * rather than reinterpreted — the seam promises a provider-supplied ISO-8601
 * string, and inventing a value would make it lie.
 */
function isoDateOrUndefined(pageAge) {
  if (typeof pageAge !== 'string') return undefined
  const trimmed = pageAge.trim()
  return /^\d{4}-\d{2}-\d{2}([T ].*)?$/u.test(trimmed) && !Number.isNaN(Date.parse(trimmed))
    ? trimmed
    : undefined
}

/** Response groups the mapper walks. Brave returns only the requested
 *  groups; entries without a URL (e.g. a malformed group) are skipped. */
const RESULT_GROUPS = ['web', 'news', 'videos', 'discussions']

/**
 * Map a Brave Web Search response body to the seam's normalized result.
 * Walks the known result groups uniformly, dedupes by URL (the same URL can
 * appear as both a web and a news hit), and returns `truncated: false`
 * because the seam owns the `maxResults` bound.
 */
function mapBraveResponse(body) {
  const seen = new Set()
  const sources = []
  for (const group of RESULT_GROUPS) {
    const results = body?.[group]?.results
    if (!Array.isArray(results)) continue
    for (const entry of results) {
      if (entry === null || typeof entry !== 'object' || !nonEmpty(entry.url) || seen.has(entry.url)) continue
      seen.add(entry.url)
      const snippet = cleanDescription(typeof entry.description === 'string' ? entry.description : '')
      const publishedAt = isoDateOrUndefined(entry.page_age)
      sources.push({
        url: entry.url,
        ...(nonEmpty(entry.title) ? { title: entry.title } : {}),
        ...(snippet.length > 0 ? { snippet } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      })
    }
  }
  return { sources, truncated: false }
}

/** Build the provider's stable cancellation error, retaining the reason. */
function aborted(signal, fallback) {
  return new WebError('Brave search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Throw the cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw aborted(signal)
}

/** True for a fetch/`AbortSignal` abort. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Abort-aware sleep used by the single 429 retry. */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(aborted(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Add endpoint recovery context to failures after request dispatch. */
function endpointError(endpoint, message, cause) {
  return new WebError(
    `${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. If that endpoint is not intended, guide the user to change baseURL (or $BRAVE_SEARCH_BASE_URL) in the web-search-brave plugin config. Only the user should choose or change the endpoint.`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * The Brave-backed search provider. Options arrive as a thunk snapshotted at
 * each operation's entry, so a settings-section change between searches never
 * mixes two sections and never re-registers the provider (re-registering
 * would make seam selection observable as a flicker).
 */
class BraveSearchProvider {
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions
    this.id = BRAVE_PROVIDER_ID
  }

  /**
   * Structural usability only: the endpoint parses. Credential presence is
   * deliberately NOT checked here — it is asynchronous for the credentials
   * service, while this contract is synchronous; `ready()` owns that
   * question, and a missing key must not make a pinned provider read as
   * misconfigured (that would report CONFIGURED_UNAVAILABLE instead of the
   * honest credential guidance).
   */
  available() {
    return URL.canParse(this.resolveOptions().baseURL)
  }

  /**
   * Whether the next search has a credential, in the order `search()`
   * resolves them. Checks presence only — a wrong key still counts as
   * configured and fails at call time with Brave's own message. Brave keys
   * work on every model route, so `llmProvider` is unused.
   */
  async ready(_llmProvider) {
    const options = this.resolveOptions()
    if (nonEmpty(options.apiKey)) return true
    const credentials = options.getCredentials?.()
    if (credentials !== undefined) {
      try {
        return (await credentials.describe(options.apiKeyRef)).configured
      } catch {
        // An unreadable store answers false: the search would fail on that
        // read instead of trying the next credential.
        return false
      }
    }
    const ambient = options.getAmbientKey?.()
    return nonEmpty(ambient)
  }

  /** Run one search against the Brave Web Search API. */
  async search(request, signal) {
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL}/web/search`
    const token = await this.resolveToken(options, signal)
    throwIfAborted(signal)

    const params = new URLSearchParams({ q: request.query })
    // The seam docs recommend applying a result-count control at the request
    // layer as a cost optimization; the seam still truncates to maxResults.
    if (Number.isInteger(request.maxResults) && request.maxResults > 0) {
      params.set('count', String(Math.min(request.maxResults, BRAVE_MAX_COUNT)))
    }
    if (nonEmpty(options.country)) params.set('country', options.country)
    if (nonEmpty(options.searchLang)) params.set('search_lang', options.searchLang)
    if (nonEmpty(options.resultFilter)) params.set('result_filter', options.resultFilter)
    // Plain text for an LLM-facing snippet: no decoration markup.
    params.set('text_decorations', 'false')

    const headers = {
      'x-subscription-token': token,
      'accept': 'application/json',
      'user-agent': USER_AGENT,
    }

    let response
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${endpoint}?${params}`, {
          method: 'GET',
          redirect: 'error',
          headers,
          ...(signal !== undefined ? { signal } : {}),
        })
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
        // redirect: 'error' rejects redirects here before following them.
        throw endpointError(endpoint, `Brave search request failed: ${String(error)}`, error)
      }
      // The free tier allows one query per second: a single bounded, 
      // abort-aware retry into the next second's quota is the documented
      // recovery for 429; anything beyond one is a real limit, not jitter.
      if (response.status !== 429 || attempt > 0) break
      await sleepAbortable(RATE_LIMIT_RETRY_DELAY_MS, signal)
    }

    if (!response.ok) {
      const status = response.status
      let message = `Brave API error (HTTP ${status})`
      try {
        const parsed = await response.json()
        const detail = parsed?.error?.detail ?? parsed?.error?.message ?? parsed?.message
        if (nonEmpty(String(detail ?? ''))) message += `: ${detail}`
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      }
      if (status === 429) {
        message += '\n\nBrave rate limit reached. The free plan allows 1 query/second; if searches fire faster, a paid plan or slower pacing is needed.'
      }
      throw endpointError(endpoint, message)
    }

    try {
      return mapBraveResponse(await response.json())
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw endpointError(
        endpoint,
        error instanceof WebError ? error.message : `Brave returned an unprocessable response body: ${String(error)}`,
        error,
      )
    }
  }

  /**
   * Resolve one operation's subscription token without retaining it on the
   * provider: literal config key, then the credentials service by reference,
   * then the launch environment.
   */
  async resolveToken(options, signal) {
    throwIfAborted(signal)
    if (nonEmpty(options.apiKey)) return options.apiKey
    const credentials = options.getCredentials?.()
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(options.apiKeyRef)
        if (resolved !== undefined && nonEmpty(resolved.value)) return resolved.value
      } catch (error) {
        throw new WebError(`Brave search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
    }
    const ambient = options.getAmbientKey?.()
    if (nonEmpty(ambient)) return ambient
    throw new WebError(
      `Brave search has no subscription token; fill "apiKey" in the web-search-brave plugin config (Plugins page form or the profile user patch), or export ${options.apiKeyEnvName} in the launching environment / ~/.dsh/.env`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully resolved.
 */
function resolveOptions(ctx, config) {
  return {
    apiKey: field(config.apiKey, ''),
    apiKeyEnvName: BRAVE_DEFAULT_API_KEY_ENV,
    apiKeyRef: credentialRef(BRAVE_DEFAULT_API_KEY_ENV),
    baseURL:
      field(config.baseURL, '') ||
      launchEnvironmentOf(ctx).get(BRAVE_BASE_URL_ENV)?.value ||
      BRAVE_DEFAULT_BASE_URL,
    country: field(config.country, '').trim(),
    searchLang: field(config.searchLang, '').trim(),
    resultFilter: field(config.resultFilter, 'web,news').trim(),
    getCredentials: () => ctx.get('credentials'),
    getAmbientKey: () => launchEnvironmentOf(ctx).get(BRAVE_DEFAULT_API_KEY_ENV)?.value,
  }
}

/**
 * Register the Brave search provider with `ctx.web`.
 */
export function apply(ctx, config) {
  const options = () =>
    resolveOptions(ctx, {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      country: config.country,
      searchLang: config.searchLang,
      resultFilter: config.resultFilter,
    })
  const provider = new BraveSearchProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: () => provider.available(),
    ready: llmProvider => provider.ready(llmProvider),
    search: (request, signal) => provider.search(request, signal),
  })
}
