/**
 * dsh-brave-search — Brave Search provider for the DSH web
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
 *
 * Usage statistics are auxiliary: one storage-domain row per local day
 * (searches / successes / failures / aborts / rate-limit bites / sources),
 * persisted fire-and-forget so accounting can never delay or fail a search,
 * and served to the Plugins page through a read-only authenticated Fetch
 * route. They wire up in a nested inject fiber that waits for the
 * storageDomain and connection services, because the composition may
 * provide them only after the web seam releases this plugin (a one-shot
 * service read in apply silently lost them on 0.2.2-rc.5). When either
 * service never arrives — or opening fails — statistics silently disable
 * and search keeps working.
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
const USER_AGENT = 'dsh-brave-search/1.0.0'

/** Storage domain holding one row per calendar day of usage counters. */
const USAGE_DOMAIN_NAME = 'web_search_brave'
/** Read-only authenticated Fetch route serving the aggregated usage snapshot. */
const USAGE_ROUTE_PATH = '/api/brave-search/usage'
/** Cap on the persisted last-error message so one huge error cannot bloat storage. */
const USAGE_MESSAGE_MAX = 300

/**
 * Backoff before the single 429 retry. The free tier allows 1 query/second,
 * so crossing into the next second's quota is the documented recovery; the
 * retry is bounded to one and abort-aware.
 */
const RATE_LIMIT_RETRY_DELAY_MS = 1_100

/**
 * Cordis plugin name used by loader diagnostics and patch entries.
 */
export const name = 'brave-search'

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
    `${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. If that endpoint is not intended, guide the user to change baseURL (or $BRAVE_SEARCH_BASE_URL) in the brave-search plugin config. Only the user should choose or change the endpoint.`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * The Brave-backed search provider. Options arrive as a thunk snapshotted at
 * each operation's entry, so a settings-section change between searches never
 * mixes two sections and never re-registers the provider (re-registering
 * would make seam selection observable as a flicker).
 *
 * `resolveTracker` is a thunk so the provider can register (and serve
 * searches) before the usage tracker finishes opening its storage domain;
 * the only instrumentation inside the provider is the 429 hit — the single
 * fact only this layer can observe. Entry/success/failure/abort accounting
 * lives in the apply-level wrapper.
 */
class BraveSearchProvider {
  constructor(resolveOptions, resolveTracker = () => null) {
    this.resolveOptions = resolveOptions
    this.resolveTracker = resolveTracker
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
      // Every 429 response counts one rate-limit bite, retried or not.
      if (response.status === 429) this.resolveTracker()?.recordRateLimit()
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
      `Brave search has no subscription token; fill "apiKey" in the brave-search plugin config (Plugins page form or the profile user patch), or export ${options.apiKeyEnvName} in the launching environment / ~/.dsh/.env`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Local-timezone calendar day of a timestamp, as `YYYY-MM-DD`. */
function dateIdOf(now) {
  const date = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Boundary validation for one stored usage day; doubles as the table's
 * `valueSchema.parse`. Throws on any deviation so damaged storage fails loud
 * at open instead of serving silently wrong counters.
 */
function parseUsageDayRecord(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('usage day must be an object')
  }
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.date)) {
    throw new Error('usage day date must be YYYY-MM-DD')
  }
  for (const key of ['searches', 'successes', 'failures', 'aborted', 'rateLimited', 'sources']) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`usage day ${key} must be a non-negative integer`)
    }
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) {
    throw new Error('usage day updatedAt must be a non-negative finite number')
  }
  return raw
}

const usageDomainSpec = {
  name: USAGE_DOMAIN_NAME,
  version: 1,
  tables: { days: { valueSchema: { parse: parseUsageDayRecord } } },
}

/**
 * In-memory-first usage accounting with best-effort persistence. Counters
 * update synchronously on the search path; the day row is persisted
 * fire-and-forget so a slow or failing disk never delays or fails a search.
 * A null `table` means in-memory only (storage service absent or failed to
 * open) — counting continues, history just does not survive restarts.
 *
 * Exported for direct testing: the injectable `now` clock is the seam the
 * midnight-rollover and DST-boundary tests use; production callers pass
 * nothing and get `Date.now`.
 */
export class UsageTracker {
  constructor(table, now = Date.now, logger = undefined) {
    this.table = table ?? null
    this.now = now
    this.logger = logger
    /** dateId → day record; rebuilt from storage on restore. */
    this.days = new Map()
    this.lastSearchAt = null
    this.lastError = null
  }

  /** Load every stored day into a fresh tracker (restart recovery). */
  static restore(table, now, logger) {
    const tracker = new UsageTracker(table, now, logger)
    if (table !== undefined && table !== null) {
      for (const [id, record] of table.entries()) tracker.days.set(id, record)
    }
    return tracker
  }

  /** The current local day's record, created on first touch. */
  day() {
    const date = dateIdOf(this.now())
    let record = this.days.get(date)
    if (record === undefined) {
      record = { date, searches: 0, successes: 0, failures: 0, aborted: 0, rateLimited: 0, sources: 0, updatedAt: this.now() }
      this.days.set(date, record)
    }
    return record
  }

  /** Persist one day row without ever disturbing the caller. */
  flush(record) {
    record.updatedAt = this.now()
    if (this.table === null) return
    this.table.put(record.date, { ...record }).catch(error => {
      this.logger?.warn?.(`brave-search: usage persist failed: ${String(error)}`)
    })
  }

  recordSearch() {
    const record = this.day()
    record.searches += 1
    this.lastSearchAt = this.now()
    this.flush(record)
  }

  recordSuccess(sourceCount) {
    const record = this.day()
    record.successes += 1
    record.sources += sourceCount
    this.flush(record)
  }

  recordAborted() {
    const record = this.day()
    record.aborted += 1
    this.flush(record)
  }

  recordRateLimit() {
    const record = this.day()
    record.rateLimited += 1
    this.flush(record)
  }

  recordFailure(code, message) {
    const record = this.day()
    record.failures += 1
    const text = String(message ?? '')
    this.lastError = { code: String(code ?? 'UNKNOWN'), message: text.length > USAGE_MESSAGE_MAX ? `${text.slice(0, USAGE_MESSAGE_MAX - 1)}…` : text, at: this.now() }
    this.flush(record)
  }

  /**
   * Aggregated read for the usage route: today, all-time totals, the last
   * seven local days (zero-filled so the chart stays continuous), and the
   * most recent search/error facts.
   */
  snapshot() {
    // One clock read for the whole snapshot: two reads could straddle
    // midnight and disagree about which day "today" is.
    const now = this.now()
    const empty = { searches: 0, successes: 0, failures: 0, aborted: 0, rateLimited: 0, sources: 0 }
    const total = { ...empty }
    for (const record of this.days.values()) {
      for (const key of Object.keys(empty)) total[key] += record[key] ?? 0
    }
    const today = dateIdOf(now)
    const last7 = []
    for (let offset = 6; offset >= 0; offset -= 1) {
      // Calendar-day subtraction: setDate crosses month and year boundaries
      // and stays correct across DST transitions, where a fixed 24h step in
      // milliseconds can land on the wrong calendar date near midnight.
      const day = new Date(now)
      day.setDate(day.getDate() - offset)
      const date = dateIdOf(day.getTime())
      const record = this.days.get(date)
      last7.push({ date, searches: record?.searches ?? 0, successes: record?.successes ?? 0, failures: record?.failures ?? 0 })
    }
    const todayRecord = this.days.get(today)
    const todayCounters = todayRecord === undefined ? empty : {
      searches: todayRecord.searches,
      successes: todayRecord.successes,
      failures: todayRecord.failures,
      aborted: todayRecord.aborted,
      rateLimited: todayRecord.rateLimited,
      sources: todayRecord.sources,
    }
    return {
      today: { date: today, ...todayCounters },
      total,
      last7,
      lastSearchAt: this.lastSearchAt,
      lastError: this.lastError,
    }
  }
}

/**
 * Open the usage domain, adopting an orphaned activation the same way
 * prompt-library does: a reload that failed between open and its cleanup
 * effect leaves the domain open with no owner; the facility lookup repairs
 * that leak. In every other state this simply opens a fresh domain.
 */
async function openUsageDomain(storageDomain) {
  try {
    return await storageDomain.open(usageDomainSpec)
  } catch (error) {
    if (error instanceof Error && error.code === 'already-open') {
      const existing = storageDomain.get(USAGE_DOMAIN_NAME)
      if (existing !== undefined) return existing
    }
    throw error
  }
}

/**
 * Wire usage statistics over the two auxiliary services the caller's scope
 * already holds: a storage domain for durable day rows and an authenticated
 * Fetch route for the client's read. Any failure here disables only the
 * statistics — the search provider registered by apply keeps working — so
 * the caller gets null, never a throw.
 */
async function createUsageTracker(ctx) {
  const storageDomain = ctx.get('storageDomain')
  const connection = ctx.get('connection')
  try {
    const domain = await openUsageDomain(storageDomain)
    // Own each resource from the moment it is acquired, so a later failure
    // in this apply can never leak it.
    ctx.effect(() => async () => { await domain.close() }, 'brave-search: usage storage domain')
    const tracker = UsageTracker.restore(domain.table('days'), undefined, ctx.logger)
    const disposeRoute = await connection.fetch.register({
      path: USAGE_ROUTE_PATH,
      methods: ['GET'],
      // The bridge derives its Request construction from this declaration:
      // an undeclared mode builds a streaming-body Request, which throws
      // "Request with GET/HEAD method cannot have body" for a GET before the
      // handler ever runs. 'buffered' builds a bodyless Request for GET.
      requestBody: 'buffered',
      fetch: async () => new Response(JSON.stringify(tracker.snapshot()), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    })
    ctx.effect(() => async () => { await disposeRoute() }, 'brave-search: usage route')
    return tracker
  } catch (error) {
    ctx.logger?.warn?.(`brave-search: usage statistics disabled (${String(error)})`)
    return null
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
 * Register the Brave search provider with `ctx.web`, then attach usage
 * statistics in a nested inject fiber. Registration comes first and never
 * waits on statistics: the auxiliary services may be provided after the web
 * seam releases this plugin (connection activates later in the composition),
 * so a one-shot service read here silently dropped statistics on
 * 0.2.2-rc.5 — the fiber waits for both services whenever they arrive, or
 * never runs in a composition without them. The tracker reaches both the
 * provider (429 bites) and the registered search wrapper (entry, success,
 * failure, abort) through the `tracker` cell — searches that run before it
 * settles are simply not counted.
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
  let tracker = null
  const provider = new BraveSearchProvider(options, () => tracker)
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: () => provider.available(),
    ready: llmProvider => provider.ready(llmProvider),
    search: async (request, signal) => {
      if (tracker !== null) tracker.recordSearch()
      try {
        const result = await provider.search(request, signal)
        if (tracker !== null) tracker.recordSuccess(result.sources.length)
        return result
      } catch (error) {
        if (tracker !== null) {
          // Caller cancellation is not the backend's failure: it gets its own
          // counter and never overwrites lastError.
          if (error instanceof WebError && error.code === 'WEB_ABORTED') tracker.recordAborted()
          else tracker.recordFailure(error?.code, error?.message)
        }
        throw error
      }
    },
  })
  ctx.inject(['storageDomain', 'connection'], async scope => {
    tracker = await createUsageTracker(scope)
    // Release the tracker with this fiber: once the services go away (or the
    // plugin unloads), counting degrades to memory-only instead of writing
    // to a closing domain. Effect disposal is LIFO, so this runs before
    // createUsageTracker's domain close.
    scope.effect(() => () => { tracker = null }, 'brave-search: usage tracker release')
  })
}
