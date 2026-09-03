import { expect } from 'chai'
import { runInNewContext } from 'node:vm'
import { createScope, defineDomain, reduce } from '../src/index'
import type { DomainType, Reduce } from '../src/index'
import { contain } from '../src/config'
import { flush } from '../src/testing'
import { platformRejections } from './helpers'

type FailState = { n: number }
type FailActions = { boom: Reduce }

declare module '../src/types' {
  interface Domains {
    cfg: DomainType<FailState, FailActions>
  }
}

// A watcher is the shortest path to a contained failure: its source throws inside the dispatch and
// the scope reports rather than rethrows.
const cfg = defineDomain('cfg', [], {
  state: () => ({ n: 0 }),
  actions: { boom: reduce(state => ({ n: state.n + 1 })) },
  watch: {
    seen: {
      $: 'watch',
      source: (state: FailState) => state.n,
      handler: () => {
        throw new Error('watcher exploded')
      },
    } as never,
  },
})

const recorder = () => {
  const lines: { level: string; args: unknown[] }[] = []
  return {
    lines,
    logger: {
      debug: (...args: unknown[]) => lines.push({ level: 'debug', args }),
      info: (...args: unknown[]) => lines.push({ level: 'info', args }),
      error: (...args: unknown[]) => lines.push({ level: 'error', args }),
    },
  }
}

describe('diagnostics settings', () => {
  describe('where they live', () => {
    it('reports to the scope that owns the reporter, not to another scope', async () => {
      const mine: unknown[] = []
      const theirs: unknown[] = []

      const a = createScope({ name: 'a', domains: [cfg], onUnhandledError: error => mine.push(error) })
      const b = createScope({ name: 'b', domains: [cfg], onUnhandledError: error => theirs.push(error) })

      await a.emit('cfg.boom')
      await flush()

      expect(mine).to.have.length(1)
      expect(theirs, "the other scope's reporter never ran").to.have.length(0)

      a.dispose()
      b.dispose()
    })

    it("falls back to the scope's own logger when no reporter is supplied", async () => {
      const { lines, logger } = recorder()
      const scope = createScope({ name: 'default-reporter', domains: [cfg], logger })

      await scope.emit('cfg.boom')
      await flush()

      const errors = lines.filter(line => line.level === 'error')
      expect(errors, 'the supplied logger received it').to.have.length(1)
      expect(String(errors[0].args[0])).to.contain('unhandled error')

      scope.dispose()
    })

    it('reports at silent, because the trace level never gated the error channel', async () => {
      const seen: unknown[] = []
      const scope = createScope({
        name: 'silent',
        domains: [cfg],
        logLevel: 'silent',
        onUnhandledError: error => seen.push(error),
      })

      await scope.emit('cfg.boom')
      await flush()

      expect(seen).to.have.length(1)
      scope.dispose()
    })
  })

  describe('the settings shape', () => {
    const build = (settings: object) => () => createScope({ name: 'bad', domains: [cfg], ...settings })

    it('refuses a logger missing any of its three methods, before the scope exists', () => {
      expect(build({ logger: { debug: () => undefined, info: () => undefined } })).to.throw(TypeError, /error/)
      expect(build({ logger: null })).to.throw(TypeError, /all of them/)
    })

    it('refuses an unknown level and a non-function reporter', () => {
      expect(build({ logLevel: 'loud' })).to.throw(TypeError, /silent, info, debug/)
      expect(build({ onUnhandledError: 'nope' })).to.throw(TypeError, /must be a function/)
    })

    it('treats an explicitly undefined field as unset, for every field', () => {
      // Validation runs on what will be used, not on what was written: an absence a caller spelled
      // out is not a value.
      for (const settings of [{ logger: undefined }, { logLevel: undefined }, { onUnhandledError: undefined }]) {
        expect(build(settings), JSON.stringify(Object.keys(settings))).to.not.throw()
      }
    })

    it('still resolves an unset field to its default rather than to nothing', async () => {
      const { lines, logger } = recorder()
      const scope = createScope({ name: 'undef', domains: [cfg], logger, logLevel: undefined })

      await scope.emit('cfg.boom')
      await flush()

      // `undefined` means "use the default", which is silent — not "no level at all".
      expect(lines.filter(line => line.level !== 'error')).to.have.length(0)
      expect(
        lines.filter(line => line.level === 'error'),
        'and the default reporter still works',
      ).to.have.length(1)
      scope.dispose()
    })
  })

  describe('a reporter that fails', () => {
    it('surfaces the original error through the console rather than swallowing it', async () => {
      const backstopped: string[] = []
      const realError = console.error
      console.error = (...args: unknown[]) => backstopped.push(args.map(String).join(' '))

      try {
        const scope = createScope({
          name: 'broken-reporter',
          domains: [cfg],
          onUnhandledError: () => {
            throw new Error('reporter exploded')
          },
        })

        await scope.emit('cfg.boom')
        await flush()
        scope.dispose()
      } finally {
        console.error = realError
      }

      // The reporter's own failure must not take down the error it was reporting.
      expect(backstopped, 'the console backstop ran').to.have.length(1)
      expect(backstopped[0]).to.contain('onUnhandledError threw')
      expect(backstopped[0]).to.contain('reporter exploded')
      expect(backstopped[0], 'and the original error is still in the line').to.contain('watcher exploded')
    })

    it("does not route the reporter's own failure through the supplied logger", async () => {
      const { lines, logger } = recorder()
      const realError = console.error
      console.error = () => undefined

      try {
        const scope = createScope({
          name: 'broken-reporter-with-logger',
          domains: [cfg],
          logger,
          onUnhandledError: () => {
            throw new Error('reporter exploded')
          },
        })

        await scope.emit('cfg.boom')
        await flush()
        scope.dispose()
      } finally {
        console.error = realError
      }

      // A caller who supplied a broken reporter often supplied the logger beside it.
      expect(lines, 'the backstop is the console, not the caller-supplied sink').to.have.length(0)
    })

    it('does not let an async reporter rejection reach the platform', () => {
      expect(
        platformRejections(`
import { createScope, defineDomain, reduce } from 'SRC'
const domain = (defineDomain as any)('cfg', [], {
  state: () => ({ n: 0 }),
  actions: { boom: reduce(s => ({ n: s.n + 1 })) },
  watch: { seen: { $: 'watch', source: s => s.n, handler: () => { throw new Error('watcher exploded') } } },
})
const scope = (createScope as any)({
  domains: [domain],
  onUnhandledError: () => Promise.reject(new Error('reporter rejected')),
})
void scope.emit('cfg.boom').catch(() => {})
`),
      ).to.deep.equal([])
    })
  })

  describe('what contain observes', () => {
    it('observes a genuine rejected promise', async () => {
      const seen: unknown[] = []
      contain(
        () => Promise.reject(new Error('rejected')),
        error => seen.push(error),
      )
      await flush()

      expect(seen).to.have.length(1)
    })

    // `instanceof Promise` is realm-bound: a promise from an iframe or a `vm` context fails it and
    // its rejection reaches nothing at all.
    it('observes a rejected promise from another realm', async () => {
      const foreign = runInNewContext('Promise.reject(new Error("foreign"))') as Promise<never>
      foreign.catch(() => undefined)
      expect(foreign instanceof Promise, 'the identity test this replaced').to.equal(false)

      const seen: unknown[] = []
      contain(
        () => foreign,
        error => seen.push(error),
      )
      await flush()

      expect(seen, 'the rejection reached the error channel').to.have.length(1)
    })

    // The brand that makes the cross-realm case work is forgeable, so the adoption goes through
    // `Promise.prototype.then` rather than the object's own — which is what keeps the rule above
    // true for something wearing the tag.
    it('never reads `then` off data that forges the promise brand', async () => {
      let read = 0
      const forged = {
        [Symbol.toStringTag]: 'Promise',
        get then() {
          read += 1
          return () => undefined
        },
      }
      expect(Object.prototype.toString.call(forged), 'it passes the brand check').to.equal('[object Promise]')

      const seen: unknown[] = []
      expect(
        contain(
          () => forged,
          error => seen.push(error),
        ),
      ).to.equal(forged)
      await flush()

      expect(read, 'the getter was never touched').to.equal(0)
      expect(seen).to.have.length(0)
    })

    it('never reads `then` off ordinary data, so an accessor cannot run', () => {
      let read = 0
      const data = {
        get then() {
          read += 1
          return () => undefined
        },
      }

      const seen: unknown[] = []
      expect(
        contain(
          () => data,
          error => seen.push(error),
        ),
      ).to.equal(data)

      expect(read, 'the getter was never touched').to.equal(0)
      expect(seen).to.have.length(0)
    })

    it('leaves a callable `then` on returned state alone', async () => {
      let invoked = false
      const seen: unknown[] = []
      contain(
        () => ({
          then: () => {
            invoked = true
          },
        }),
        error => seen.push(error),
      )
      await flush()

      expect(invoked, 'application data is not a promise').to.equal(false)
      expect(seen).to.have.length(0)
    })

    it('reads nothing off a value that cannot carry a failure', () => {
      const seen: unknown[] = []
      for (const value of [undefined, null, 0, '', false, Symbol('s')]) {
        expect(() =>
          contain(
            () => value,
            error => seen.push(error),
          ),
        ).to.not.throw()
      }

      expect(seen).to.have.length(0)
    })

    it('routes a synchronous throw', () => {
      const seen: unknown[] = []
      expect(
        contain(
          () => {
            throw new Error('sync')
          },
          error => seen.push(error),
        ),
      ).to.equal(undefined)

      expect(seen).to.have.length(1)
    })
  })
})
