// Offline behavioral test for dsh-web-search-brave/index.js.
// Run: node --import ./.test/register.mjs ./.test/run.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, Config, name, inject, UsageTracker } from '../index.js'
import { WebError } from '@deepseek-ai/dsh-web'

// ---------------------------------------------------------------- mock server

const requests = []
let handler = null
const server = createServer((req, res) => {
  // Drain the request stream: a bodyless GET never enters flowing mode on its
  // own, so 'end' (and the handler) would never fire without resume().
  req.resume()
  req.on('end', () => {
    const record = { url: req.url, headers: req.headers }
    requests.push(record)
    handler?.(record, res)
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const BASE = `http://127.0.0.1:${port}`

const jsonResponse = (status, body) => (record, res) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const lastQuery = () => new URL(requests.at(-1).url, 'http://x').searchParams

// ------------------------------------------------------------------- helpers

/** Mock plugin context shaped like the Loader's: services resolve through
 *  get, apply-scoped effects are collected, and ctx.inject models the
 *  Cordis nested fiber — the callback starts once every dependency resolves,
 *  including when that happens only after apply has returned (the race the
 *  statistics wiring must survive). */
function makeCtx(services = {}) {
  const bag = { ...services }
  const registered = []
  const effects = []
  const started = []
  const waiting = []
  const LOGGER = { warn: () => {}, info: () => {} }
  const makeScope = () => ({
    get: service => bag[service],
    effect: (dispose, label) => { effects.push({ dispose, label }) },
    logger: LOGGER,
  })
  const ctx = {
    get: service => bag[service],
    web: { registerSearchProvider: provider => registered.push(provider) },
    effect: (dispose, label) => { effects.push({ dispose, label }) },
    inject: (deps, callback) => {
      const scope = makeScope()
      const tryStart = () => (deps.every(service => bag[service] !== undefined)
        ? (started.push(callback(scope)), true)
        : false)
      if (!tryStart()) waiting.push(tryStart)
    },
    logger: LOGGER,
  }
  return {
    ctx,
    registered,
    /** Deliver late services the way Cordis wakes a waiting inject fiber. */
    async provide(late) {
      Object.assign(bag, late)
      for (const tryStart of waiting.splice(0)) tryStart()
      await Promise.all(started)
    },
    /** Settle every started nested fiber (statistics wiring is detached). */
    async settle() {
      await Promise.all(started)
    },
  }
}

/** Apply the plugin with a plain config object against a mock ctx; the
 *  credentials service and the usage-statistics services are injectable per
 *  scenario. Statistics wiring runs in the inject fiber and settles before
 *  the provider is returned, so callers observe the wired state. */
async function build(config, services = {}) {
  const harness = makeCtx(services)
  await apply(harness.ctx, config)
  assert.equal(harness.registered.length, 1, 'apply must register exactly one provider')
  await harness.settle()
  return harness.registered[0]
}

/** Minimal storage-domain double: one table over a Map; `put` stores a deep
 *  copy so later in-memory mutations never leak into "persisted" state. */
function mockStorageDomain() {
  const rows = new Map()
  const table = {
    entries: () => [...rows.entries()],
    get: id => rows.get(id),
    put: async (id, value) => { rows.set(id, JSON.parse(JSON.stringify(value))) },
  }
  const domain = { table: () => table, close: async () => {} }
  return { rows, open: async () => domain, get: name => (name === 'web_search_brave' ? domain : undefined) }
}

/** Minimal connection double capturing registered Fetch routes. */
function mockConnection() {
  const routes = new Map()
  return {
    routes,
    fetch: { register: async route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
  }
}

/** The current local calendar day, mirroring the provider's dateIdOf. */
function todayId() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Read the usage snapshot through one captured route. */
async function readUsage(connection) {
  const route = connection.routes.get('/api/web-search-brave/usage')
  const response = await route.fetch()
  assert.equal(response.status, 200)
  return await response.json()
}

const validate = candidate => Config['~standard'].validate(candidate).value
const isWebError = code => error => {
  assert.ok(error instanceof WebError, `expected WebError, got ${error?.constructor?.name}: ${error}`)
  assert.equal(error.code, code)
  return true
}

// Every scenario starts from a clean credential environment.
const cleanEnv = () => {
  delete process.env.BRAVE_API_KEY
  delete process.env.BRAVE_SEARCH_BASE_URL
}
cleanEnv()

// ------------------------------------------------------------ module shape

{
  assert.equal(name, 'web-search-brave')
  assert.ok(inject.includes('web'), 'inject must declare the web seam')

  // Volatile fields come back from validate() as { get() } refs (cosmokit's
  // volatile wrapper), exactly like the Loader's live form — the same shape
  // field() in index.js unwraps.
  const read = ref => (typeof ref?.get === 'function' ? ref.get() : ref)
  const defaults = validate({})
  assert.equal(read(defaults.apiKey), '')
  assert.equal(read(defaults.baseURL), '')
  assert.equal(read(defaults.country), '')
  assert.equal(read(defaults.searchLang), '')
  assert.equal(read(defaults.resultFilter), 'web,news')
  console.log('OK: module shape and config defaults')
}

// ------------------------------------------------- registration & available

{
  const provider = await build(validate({ apiKey: 'k' }))
  assert.equal(provider.id, 'brave')
  assert.equal(typeof provider.available, 'function')
  assert.equal(typeof provider.ready, 'function')
  assert.equal(typeof provider.search, 'function')
  assert.equal(provider.available(), true)
  assert.equal(await provider.ready(undefined), true)
  console.log('OK: apply registers the brave provider; available/ready true with a literal key')
}

// ------------------------------------------------------------- happy path

{
  handler = jsonResponse(200, {
    web: { results: [
      { title: 'DeepSeek', url: 'https://deepseek.com', description: 'AI &amp; research lab &#x2014; models', page_age: '2026-01-02' },
      { title: 'Docs', url: 'https://docs.example.com/a', description: 'Guide with <b>markup</b> &nbsp; inside' },
      { url: 'https://bare.example.com' },
      { title: 'Bad age', url: 'https://age.example.com', description: 'not a date', page_age: '3 days ago' },
    ] },
    news: { results: [
      { title: 'News dup', url: 'https://deepseek.com', description: 'duplicate url' },
      { title: 'Real news', url: 'https://news.example.com/x', description: 'fresh &quot;item&quot;', page_age: '2026-11-11T08:00:00Z' },
    ] },
    videos: { results: [{ title: 'Video', url: 'https://video.example.com/v', description: 'a video hit' }] },
  })
  const provider = await build(validate({ apiKey: 'lit-key', baseURL: BASE }))
  const result = await provider.search({ query: 'deepseek ai 搜索', maxResults: 10 })

  assert.equal(result.truncated, false, 'the seam owns truncation; the provider never sets it')
  assert.equal(result.sources.length, 6, 'web+news+video hits, deduped by URL')

  const [first, second, bare, badAge, news, video] = result.sources
  assert.equal(first.url, 'https://deepseek.com')
  assert.equal(first.title, 'DeepSeek')
  assert.equal(first.snippet, 'AI & research lab — models')
  assert.equal(first.publishedAt, '2026-01-02')
  assert.equal(second.snippet, 'Guide with markup inside')
  assert.deepEqual(Object.keys(bare), ['url'], 'a bare hit carries only its URL — no invented fields')
  assert.equal('publishedAt' in badAge, false, 'a non-ISO page_age is omitted, not reinterpreted')
  assert.equal(news.publishedAt, '2026-11-11T08:00:00Z')
  assert.equal(video.url, 'https://video.example.com/v')

  assert.equal(requests.length, 1)
  const record = requests[0]
  assert.ok(record.url.startsWith('/web/search?'), `unexpected path ${record.url}`)
  const query = new URL(record.url, 'http://x').searchParams
  assert.equal(query.get('q'), 'deepseek ai 搜索')
  assert.equal(query.get('count'), '10')
  assert.equal(query.get('result_filter'), 'web,news')
  assert.equal(query.get('text_decorations'), 'false')
  assert.equal(query.get('country'), null)
  assert.equal(query.get('search_lang'), null)
  assert.equal(record.headers['x-subscription-token'], 'lit-key')
  assert.equal(record.headers.accept, 'application/json')
  assert.match(record.headers['user-agent'], /^dsh-web-search-brave\//)
  console.log('OK: happy path maps, cleans, and dedupes; request carries the documented parameters')
}

// --------------------------------------------------------- count clamping

{
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }))
  handler = jsonResponse(200, {})
  await provider.search({ query: 'x', maxResults: 50 })
  assert.equal(lastQuery().get('count'), '20', 'Brave caps count at 20')
  await provider.search({ query: 'x', maxResults: 5 })
  assert.equal(lastQuery().get('count'), '5')
  await provider.search({ query: 'x' })
  assert.equal(lastQuery().get('count'), null, 'no maxResults leaves Brave\'s default')
  console.log('OK: maxResults maps to count, clamped to 20')
}

// ---------------------------------------------------- localization params

{
  handler = jsonResponse(200, {})
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE, country: 'cn', searchLang: 'zh-hans' }))
  await provider.search({ query: 'x' })
  assert.equal(lastQuery().get('country'), 'cn')
  assert.equal(lastQuery().get('search_lang'), 'zh-hans')
  console.log('OK: country and searchLang pass through when set')
}

// ------------------------------------------------------ credential tiers

{
  // Missing everywhere: literal empty, no credentials service, no env.
  const provider = await build(validate({ baseURL: BASE }))
  assert.equal(await provider.ready(undefined), false)
  const before = requests.length
  await assert.rejects(provider.search({ query: 'x' }), isWebError('WEB_PROVIDER_CREDENTIAL_MISSING'))
  assert.equal(requests.length, before, 'a missing credential must not reach the network')
  console.log('OK: missing token -> WEB_PROVIDER_CREDENTIAL_MISSING, ready() false, no request')

  // Launch-environment fallback.
  process.env.BRAVE_API_KEY = 'env-key'
  assert.equal(await provider.ready(undefined), true)
  handler = jsonResponse(200, {})
  await provider.search({ query: 'x' })
  assert.equal(requests.at(-1).headers['x-subscription-token'], 'env-key')
  cleanEnv()
  console.log('OK: BRAVE_API_KEY launch-environment fallback authenticates')

  // Credentials service: stored value wins over ambient env.
  process.env.BRAVE_API_KEY = 'env-key'
  const stored = await build(validate({ baseURL: BASE }), {
    credentials: {
      describe: async () => ({ configured: true }),
      resolve: async () => ({ value: 'stored-key', source: 'store' }),
    },
  })
  await stored.search({ query: 'x' })
  assert.equal(requests.at(-1).headers['x-subscription-token'], 'stored-key')
  assert.equal(await stored.ready(undefined), true)

  // Credentials service configured but empty falls through to the env tier.
  const unconfigured = await build(validate({ baseURL: BASE }), {
    credentials: {
      describe: async () => ({ configured: false }),
      resolve: async () => undefined,
    },
  })
  await unconfigured.search({ query: 'x' })
  assert.equal(requests.at(-1).headers['x-subscription-token'], 'env-key')
  assert.equal(await unconfigured.ready(undefined), false)
  cleanEnv()

  // An unreadable credential store answers ready() false.
  const broken = await build(validate({ baseURL: BASE }), {
    credentials: {
      describe: async () => { throw new Error('store unreadable') },
      resolve: async () => { throw new Error('store unreadable') },
    },
  })
  assert.equal(await broken.ready(undefined), false)
  await assert.rejects(broken.search({ query: 'x' }), isWebError('WEB_PROVIDER_ERROR'))

  // The literal key still wins over everything.
  process.env.BRAVE_API_KEY = 'env-key'
  const literal = await build(validate({ apiKey: 'lit-key', baseURL: BASE }), {
    credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'stored-key', source: 'store' }) },
  })
  await literal.search({ query: 'x' })
  assert.equal(requests.at(-1).headers['x-subscription-token'], 'lit-key')
  cleanEnv()
  console.log('OK: literal key > credentials service > launch environment, in that order')
}

// ------------------------------------------------------------ HTTP errors

{
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }))
  handler = jsonResponse(401, { error: { code: 'AUTH', detail: 'invalid subscription token' } })
  await assert.rejects(provider.search({ query: 'x' }), error => {
    isWebError('WEB_PROVIDER_ERROR')(error)
    assert.match(error.message, /HTTP 401/)
    assert.match(error.message, /invalid subscription token/)
    return true
  })

  handler = (record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('not json')
  }
  await assert.rejects(provider.search({ query: 'x' }), error => {
    isWebError('WEB_PROVIDER_ERROR')(error)
    assert.match(error.message, /unprocessable/)
    return true
  })

  handler = jsonResponse(200, {})
  const empty = await provider.search({ query: 'x' })
  assert.deepEqual(empty, { sources: [], truncated: false }, 'no hits is an honest empty result, not an error')
  console.log('OK: 401 detail surfaces; bad body and empty results map to their contract outcomes')
}

// ----------------------------------------------------------- rate limiting

{
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }))
  let hits = 0
  handler = (record, res) => {
    hits += 1
    if (hits === 1) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { detail: 'Too Many Requests' } }))
      return
    }
    jsonResponse(200, { web: { results: [{ title: 'T', url: 'https://t.example.com', description: 'ok' }] } })(record, res)
  }
  const result = await provider.search({ query: 'x' })
  assert.equal(hits, 2, 'one bounded retry into the next second')
  assert.equal(result.sources.length, 1)
  console.log('OK: a single 429 retries once and succeeds')

  const beforePersistent = requests.length
  handler = jsonResponse(429, { error: { detail: 'Too Many Requests' } })
  await assert.rejects(provider.search({ query: 'x' }), error => {
    isWebError('WEB_PROVIDER_ERROR')(error)
    assert.match(error.message, /rate limit/)
    return true
  })
  assert.equal(requests.length - beforePersistent, 2, 'the retry is bounded to one')
  console.log('OK: persistent 429 fails with rate-limit guidance after exactly one retry')
}

// -------------------------------------------------------------- abortion

{
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }))
  handler = jsonResponse(200, {})

  const pre = new AbortController()
  pre.abort()
  const before = requests.length
  await assert.rejects(provider.search({ query: 'x' }, pre.signal), isWebError('WEB_ABORTED'))
  assert.equal(requests.length, before, 'an aborted search never dispatches')

  // Abort while waiting out the 429 backoff.
  handler = jsonResponse(429, { error: { detail: 'Too Many Requests' } })
  const during = new AbortController()
  setTimeout(() => during.abort(), 30)
  await assert.rejects(provider.search({ query: 'x' }, during.signal), isWebError('WEB_ABORTED'))
  console.log('OK: cancellation surfaces as WEB_ABORTED before dispatch and during backoff')
}

// -------------------------------------------------------------- redirects

{
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }))
  handler = (record, res) => {
    res.writeHead(302, { location: 'https://elsewhere.example.com/' })
    res.end()
  }
  await assert.rejects(provider.search({ query: 'x' }), isWebError('WEB_PROVIDER_ERROR'))
  console.log('OK: redirects are rejected, never followed')
}

// ------------------------------------------------------ baseURL resolution

{
  handler = jsonResponse(200, {})

  // Config wins over the environment override.
  process.env.BRAVE_SEARCH_BASE_URL = 'https://env-ignored.example.com/res/v1'
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }))
  await provider.search({ query: 'x' })
  assert.ok(requests.at(-1).url.startsWith('/web/search?'))
  assert.equal(requests.at(-1).headers.host, `127.0.0.1:${port}`)

  // Environment override applies when config is empty.
  process.env.BRAVE_SEARCH_BASE_URL = `${BASE}/res/v1`
  const envProvider = await build(validate({ apiKey: 'k' }))
  await envProvider.search({ query: 'x' })
  assert.equal(requests.at(-1).headers.host, `127.0.0.1:${port}`)
  cleanEnv()

  // Default target when neither config nor environment supplies one. This is
  // the suite's one deliberate online probe: it verifies the composed default
  // endpoint really is the documented Brave host (a 422 from Brave names it),
  // and tolerates an offline machine (fetch failure names it too).
  const defaultProvider = await build(validate({ apiKey: 'k' }))
  assert.equal(defaultProvider.available(), true)
  await assert.rejects(defaultProvider.search({ query: 'x' }), error => {
    assert.ok(!(error instanceof WebError) || error.code === 'WEB_PROVIDER_ERROR')
    assert.match(String(error.message), /api\.search\.brave\.com|fetch failed/)
    return true
  })

  // A structurally broken baseURL reads as unavailable.
  const broken = await build(validate({ apiKey: 'k', baseURL: 'not a url' }))
  assert.equal(broken.available(), false)
  console.log('OK: baseURL resolution order is config > $BRAVE_SEARCH_BASE_URL > default')
}

// ------------------------------------------------------ usage statistics

{
  const storage = mockStorageDomain()
  const connection = mockConnection()
  const provider = await build(validate({ apiKey: 'k', baseURL: BASE }), { storageDomain: storage, connection })
  assert.ok(connection.routes.has('/api/web-search-brave/usage'), 'the usage route must be registered')
  // Route contract: the bridge builds its Request from requestBody — an
  // undeclared mode makes a GET route throw before the handler runs
  // ("Request with GET/HEAD method cannot have body").
  const registeredRoute = connection.routes.get('/api/web-search-brave/usage')
  assert.ok(registeredRoute.methods.includes('GET'))
  assert.equal(registeredRoute.requestBody, 'buffered')

  // Initial snapshot: zeroed today, continuous zero-filled last 7 days.
  let usage = await readUsage(connection)
  assert.equal(usage.today.searches, 0)
  assert.equal(usage.last7.length, 7)
  assert.equal(usage.last7[6].date, todayId())
  assert.equal(usage.lastError, null)

  // A successful search counts entry, success, and returned sources.
  handler = jsonResponse(200, { web: { results: [
    { title: 'A', url: 'https://a.example.com', description: 'a' },
    { title: 'B', url: 'https://b.example.com' },
  ] } })
  await provider.search({ query: 'x' })
  usage = await readUsage(connection)
  assert.equal(usage.today.searches, 1)
  assert.equal(usage.today.successes, 1)
  assert.equal(usage.today.sources, 2)
  assert.equal(usage.total.searches, 1)
  assert.notEqual(usage.lastSearchAt, null)

  // A failure counts once and records the last error.
  handler = jsonResponse(401, { error: { detail: 'bad token' } })
  await assert.rejects(provider.search({ query: 'x' }), isWebError('WEB_PROVIDER_ERROR'))
  usage = await readUsage(connection)
  assert.equal(usage.today.failures, 1)
  assert.equal(usage.lastError.code, 'WEB_PROVIDER_ERROR')

  // Caller cancellation counts as its own outcome and never overwrites the
  // last error.
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.search({ query: 'x' }, controller.signal), isWebError('WEB_ABORTED'))
  usage = await readUsage(connection)
  assert.equal(usage.today.aborted, 1)
  assert.equal(usage.today.failures, 1, 'aborts are not failures')
  assert.equal(usage.lastError.code, 'WEB_PROVIDER_ERROR', 'an abort must not overwrite lastError')

  // A 429 bite is counted even when the single retry then succeeds.
  let hits = 0
  handler = (record, res) => {
    hits += 1
    if (hits === 1) return jsonResponse(429, { error: { detail: 'slow down' } })(record, res)
    return jsonResponse(200, { web: { results: [{ title: 'T', url: 'https://t.example.com' }] } })(record, res)
  }
  await provider.search({ query: 'x' })
  usage = await readUsage(connection)
  assert.equal(usage.today.rateLimited, 1)
  assert.equal(usage.today.successes, 2)
  assert.equal(usage.today.searches, 4, 'every dispatched search counts an entry')

  // The day row is persisted with the full counter set.
  const stored = storage.rows.get(todayId())
  assert.ok(stored !== undefined, 'today\'s row must be persisted')
  assert.equal(stored.searches, 4)
  assert.equal(stored.rateLimited, 1)
  assert.equal(stored.sources, 3)

  // Restart recovery: a fresh apply over the same storage keeps history.
  const connection2 = mockConnection()
  const provider2 = await build(validate({ apiKey: 'k', baseURL: BASE }), { storageDomain: storage, connection: connection2 })
  handler = jsonResponse(200, {})
  await provider2.search({ query: 'x' })
  usage = await readUsage(connection2)
  assert.equal(usage.total.searches, 5, 'restored counters continue from the persisted rows')
  assert.equal(usage.today.searches, 5)

  // Without the auxiliary services, search still works and nothing throws.
  const bare = await build(validate({ apiKey: 'k', baseURL: BASE }))
  handler = jsonResponse(200, {})
  const bareResult = await bare.search({ query: 'x' })
  assert.equal(bareResult.truncated, false)
  console.log('OK: usage statistics count, persist, restore, and degrade without auxiliary services')
}

// ------------------------------------------------ late auxiliary services

// Regression for the 0.2.2-rc.5 composition: the web seam releases this
// plugin before connection/storageDomain are provided. The old one-shot
// ctx.get in apply silently dropped statistics in that order; the nested
// inject fiber must wire them whenever they arrive.
{
  const harness = makeCtx()
  await apply(harness.ctx, validate({ apiKey: 'k', baseURL: BASE }))
  assert.equal(harness.registered.length, 1, 'apply registers the provider without waiting on statistics services')

  // Search serves before any auxiliary service exists.
  handler = jsonResponse(200, { web: { results: [{ title: 'T', url: 'https://t.example.com' }] } })
  const early = await harness.registered[0].search({ query: 'x' })
  assert.equal(early.sources.length, 1)

  // The services arrive only now; the wiring must catch up.
  const storage = mockStorageDomain()
  const connection = mockConnection()
  await harness.provide({ storageDomain: storage, connection })
  assert.ok(connection.routes.has('/api/web-search-brave/usage'), 'late services must still register the usage route')

  await harness.registered[0].search({ query: 'x' })
  const usage = await readUsage(connection)
  assert.equal(usage.today.searches, 1, 'searches after wiring count; the pre-wiring search does not')
  assert.equal(usage.total.sources, 1)
  console.log('OK: statistics wire up when auxiliary services arrive after apply')
}

// ------------------------------------------------- midnight day rollover

{
  // Injected clock, direct on UsageTracker: counters split at the local
  // midnight boundary and the 7-day window slides to the new today.
  const rows = new Map()
  const table = {
    entries: () => [...rows.entries()],
    get: id => rows.get(id),
    put: async (id, value) => { rows.set(id, JSON.parse(JSON.stringify(value))) },
  }
  let clock = new Date(2026, 10, 12, 23, 59, 30).getTime()   // 2026-11-12 23:59:30 local
  const tracker = new UsageTracker(table, () => clock)
  tracker.recordSearch()
  tracker.recordSuccess(5)
  clock = new Date(2026, 10, 13, 0, 0, 30).getTime()          // 2026-11-13 00:00:30 local
  tracker.recordSearch()
  tracker.recordFailure('WEB_PROVIDER_ERROR', 'x')

  const snap = tracker.snapshot()
  assert.equal(snap.today.date, '2026-11-13')
  assert.equal(snap.today.searches, 1)
  assert.equal(snap.today.failures, 1)
  assert.equal(snap.today.successes, 0, 'the previous day\'s success stays on its own row')
  assert.equal(snap.total.searches, 2)
  assert.equal(snap.total.sources, 5)
  assert.equal(rows.size, 2, 'one row per calendar day')
  assert.equal(snap.last7[6].date, '2026-11-13')
  assert.equal(snap.last7[6].searches, 1)
  assert.equal(snap.last7[5].date, '2026-11-12')
  assert.equal(snap.last7[5].searches, 1)
  assert.equal(snap.last7[0].date, '2026-11-07', 'the window slides with today')
  console.log('OK: counters split at local midnight; the 7-day window slides')
}

server.close()
console.log('OK: all host-side behavior tests passed')
