// Preact users take `@askrubberduck/eddy/react` as it ships, with `react` aliased to `preact/compat` in
// their bundler; there is no Preact entry point. This check is that alias, applied to the emitted
// output: a component reads a domain, emits, and has to render the folded state.
//
// A separate process because mocha has already loaded the real React, and a resolver patch cannot
// unload it.

import Module, { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(root, 'output'))) {
  console.error('preact check: no output/ — run `npm run build` first')
  process.exit(2)
}

const ALIAS = {
  react: 'preact/compat',
  'react-dom': 'preact/compat',
  'react/jsx-runtime': 'preact/jsx-runtime',
}
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, ALIAS[request] ?? request, ...rest)
}

const { window } = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = window
globalThis.document = window.document

const require = createRequire(import.meta.url)
const { createElement, render } = require('preact')
const { act } = require('preact/test-utils')
const { createScope, defineDomain, reduce } = require('../output/index.js')
const { createScopeHooks } = require('../output/react.js')

const counter = defineDomain('counter', [], {
  state: { count: 0 },
  actions: { bump: reduce(state => ({ count: state.count + 1 })) },
})
const scope = createScope({ name: 'preact', domains: [counter] })
const { useDomain, useEmit } = createScopeHooks(scope)

let emit
function Count() {
  emit = useEmit()
  return createElement('span', null, String(useDomain('counter').count))
}

const container = window.document.getElementById('root')
const text = () => container.textContent

await act(() => render(createElement(Count), container))
const before = text()
await act(() => emit('counter.bump'))
const after = text()

render(null, container)
scope.dispose()

// React is installed beside Preact for the mocha suite, so a missed alias would load it silently.
if (Object.keys(require.cache).some(path => path.includes('/node_modules/react/'))) {
  console.error('preact check failed: the binding loaded react itself, so the alias did not apply')
  process.exit(1)
}
if (before !== '0' || after !== '1') {
  console.error(`preact check failed: rendered '${before}' then '${after}', expected '0' then '1'`)
  process.exit(1)
}
console.log('preact check passed: the React binding renders and re-renders under preact/compat')
