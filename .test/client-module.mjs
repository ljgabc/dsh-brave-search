// Simulate the browser module loader for dsh-web-search-brave/client.js.
import { readFileSync } from 'node:fs'

let registered = null
const reactShim = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  memo: component => component,
}
const globalWindow = {
  __ModuleLoader__: {
    load: module => { registered = module },
  },
}
globalThis.window = globalWindow
const requireShim = name => {
  if (name === 'react') return reactShim
  throw new Error(`unexpected require: ${name}`)
}

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// Evaluate the module body with the shims; the loader captures the module.
new Function('require', 'window', source)(requireShim, globalWindow)

if (registered === null || registered.id !== '@local/dsh-web-search-brave') {
  console.error('FAIL: module did not register', registered)
  process.exit(1)
}
if (typeof registered.factory !== 'function') {
  console.error('FAIL: factory missing')
  process.exit(1)
}

const plugin = registered.factory(requireShim)
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots') || typeof plugin.apply !== 'function') {
  console.error('FAIL: plugin shape', plugin)
  process.exit(1)
}

// apply against a fake slots/locale ctx.
const injections = []
const registrations = []
const fakeCtx = {
  get: service => {
    if (service === 'locale') return { register: () => () => {}, bind: ns => key => key }
    if (service === 'slots') {
      return {
        inject: (slot, register) => { injections.push(slot); register(); return () => {} },
        register: options => { registrations.push(options); return () => {} },
      }
    }
    return undefined
  },
  effect: dispose => { dispose(); return () => {} },
}
plugin.apply(fakeCtx)

const rowConfig = registrations.find(options => options.name === 'plugins.row.config')
const bundleConfig = registrations.find(options => options.name === 'plugins.bundle.config')
const keysOk = rowConfig?.key === '@local/dsh-web-search-brave#web-search-brave' && bundleConfig?.key === '@local/dsh-web-search-brave'
if (injections.includes('plugins.row.config') && injections.includes('plugins.bundle.config') && keysOk) {
  console.log('OK: module registers; row key =', rowConfig.key, '; bundle key =', bundleConfig.key)
  process.exit(0)
}
console.error('FAIL: unexpected registrations', registrations)
process.exit(1)
