import { expect } from 'chai'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export async function rejects(promise: Promise<unknown>, matching: RegExp): Promise<Error> {
  const sentinel = Symbol('resolved')

  const outcome = await promise.then(
    () => sentinel,
    (error: unknown) => error,
  )

  if (outcome === sentinel) {
    expect.fail(`expected the promise to reject with ${matching}, but it resolved`)
  }

  const error = outcome as Error
  expect(String(error?.message ?? error)).to.match(matching)
  return error
}

export const PENDING = 'pending' as const

export async function settlement(
  promise: Promise<unknown>,
  ms = 60,
): Promise<typeof PENDING | { ok: unknown } | { error: unknown }> {
  let timer: ReturnType<typeof setTimeout>
  const idle = new Promise<typeof PENDING>(resolve => {
    timer = setTimeout(() => resolve(PENDING), ms)
  })

  try {
    return await Promise.race([
      promise.then(
        ok => ({ ok }),
        (error: unknown) => ({ error }),
      ),
      idle,
    ])
  } finally {
    clearTimeout(timer!)
  }
}

export function platformRejections(snippet: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'eddy-platform-'))

  const src = resolve('src/index.ts')

  const file = join(dir, 'probe.ts')
  writeFileSync(
    file,
    `const seen: string[] = []
process.on('unhandledRejection', reason => {
  const error = reason as Error
  seen.push(\`\${error?.name ?? 'unknown'}: \${error?.message ?? String(reason)}\`)
})
${snippet.replace(/'SRC'/g, JSON.stringify(src))}
setTimeout(() => console.log('PLATFORM:' + JSON.stringify(seen)), 250)
`,
  )

  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const line = out.split('\n').find(l => l.startsWith('PLATFORM:'))
    if (!line) {
      expect.fail(`the probe never reported; it printed:\n${out}`)
    }
    return JSON.parse(line.slice('PLATFORM:'.length)) as string[]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let builtEntry: string | undefined
function buildOnce(): string {
  if (!builtEntry) {
    const dir = mkdtempSync(join(tmpdir(), 'eddy-build-'))
    execFileSync(
      process.execPath,
      [resolve('node_modules/typescript/bin/tsc'), '--outDir', dir, '--declaration', 'false'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    builtEntry = join(dir, 'index.js')
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  }
  return builtEntry
}

export function buildModeProbe(
  snippet: string,
  options: {
    env?: Record<string, string>
    withoutProcess?: boolean
    withPartialProcess?: boolean
    withReact?: boolean
    withTesting?: boolean
    withoutErrorIsError?: boolean
    execArgv?: string[]
  } = {},
): string[] {
  const entry = buildOnce()
  const dir = mkdtempSync(join(tmpdir(), 'eddy-mode-'))
  const file = join(dir, 'probe.cjs')

  writeFileSync(
    file,
    `'use strict'
// Removed before the library loads, because the brand test is captured at module initialisation.
if (${options.withoutErrorIsError === true}) delete Error.isError
const hide = ${options.withoutProcess === true}
const partial = ${options.withPartialProcess === true}
const savedProcess = globalThis.process
if (hide) delete globalThis.process
// A browser or test shim that defines \`process\` without \`env\`. Reading through it threw on import.
if (partial) globalThis.process = {}
let eddy
try {
  eddy = require(${JSON.stringify(entry)})
  ${options.withReact ? `Object.assign(eddy, require(${JSON.stringify(join(dirname(entry), 'react.js'))}))` : ''}
  ${options.withTesting ? `Object.assign(eddy, require(${JSON.stringify(join(dirname(entry), 'testing.js'))}))` : ''}
} finally {
  if (hide || partial) globalThis.process = savedProcess
}
${snippet}
`,
  )

  try {
    const out = execFileSync(process.execPath, [...(options.execArgv ?? []), file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.withReact ? { NODE_PATH: resolve('node_modules') } : {}), ...options.env },
    })
    return out.split('\n').filter(line => line.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
