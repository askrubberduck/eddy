import { expect } from 'chai'
import { inspect } from 'node:util'
import { cmd, createScope, defineDomain, reduce, view } from '../src/index'
import type { Cmd, DomainType, Reduce } from '../src/index'
import type { Settings } from '../src/types'
import { api, audit, cart, observed, session } from './fixtures'
import { flush } from '../src/testing'
import { platformRejections, rejects } from './helpers'

type LateViewState = { n: number }
type LateViewActions = { bump: Reduce }

type RoundTripState = { items: number[]; note?: string }
type RoundTripActions = { go: Cmd<void, number>; addNote: Reduce }

declare module '../src/types' {
  interface Domains {
    lateView: DomainType<LateViewState, LateViewActions>
    roundTrip: DomainType<RoundTripState, RoundTripActions>
  }
}

// Two stages that each move the field and together move it nowhere. The single-stage no-op below is
// caught by `applyStage`; this one reaches the commit decision.
const roundTrip = defineDomain('roundTrip', [], {
  state: () => ({ items: [] }) as RoundTripState,
  actions: {
    go: cmd(async () => 1, {
      done: () => ({ items: [1] }),
      finally: () => ({ items: [] }),
    }),
    addNote: reduce(() => ({ note: undefined })),
  },
})

type Line = { level: 'debug' | 'info' | 'error'; args: unknown[] }

const recorder = () => {
  const lines: Line[] = []
  return {
    lines,
    logger: {
      debug: (...args: unknown[]) => lines.push({ level: 'debug', args }),
      info: (...args: unknown[]) => lines.push({ level: 'info', args }),
      error: (...args: unknown[]) => lines.push({ level: 'error', args }),
    },
  }
}

const events = (lines: Line[]) =>
  lines.filter(line => line.level !== 'error').map(line => String(line.args[0]).replace('eddy: ', ''))

const records = (lines: Line[]) => lines.filter(line => line.level !== 'error').map(line => line.args[1] as never)

const SENTINEL = 'SENTINEL-b3f2'

const render = (args: unknown[]) => inspect(args, { depth: null })

const scopeOf = (settings: Partial<Settings> = {}, name = 'log-test') =>
  createScope({ name, domains: [cart, session, audit], ...settings })

describe('logging', () => {
  beforeEach(() => {
    api.reset()
    observed.reset()
  })

  afterEach(() => {})

  describe('the level, now that each scope owns one', () => {
    it('defaults to silent, so a scope given no settings traces nothing', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger })

      await scope.emit('audit.note', { what: 'x' })

      expect(events(lines)).to.deep.equal([])
      scope.dispose()
    })

    it('does not leak between scopes: one at debug leaves the other silent', async () => {
      const loud = recorder()
      const quiet = recorder()
      const talking = scopeOf({ logger: loud.logger, logLevel: 'debug' }, 'loud')
      const silent = scopeOf({ logger: quiet.logger }, 'quiet')

      await talking.emit('audit.note', { what: 'x' })
      await silent.emit('audit.note', { what: 'x' })

      expect(events(loud.lines)).to.not.have.length(0)
      expect(events(quiet.lines), "the silent scope's sink saw nothing").to.deep.equal([])
      expect(loud.lines.every(line => (line.args[1] as { scope?: string })?.scope === 'loud')).to.equal(true)

      talking.dispose()
      silent.dispose()
    })
  })

  describe('the stream', () => {
    it('emits started, folded and effects for a pure reduction that moves state, and never settled', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'debug' })

      await scope.emit('audit.note', { what: 'x' })

      expect(events(lines)).to.deep.equal(['started', 'folded', 'effects'])
      scope.dispose()
    })

    it('drops the folded when two stages move a field and put it back, which is also nothing committed', async () => {
      const { lines, logger } = recorder()
      const scope = createScope({ domains: [roundTrip], logger, logLevel: 'debug' })

      await scope.emit('roundTrip.go')

      expect(events(lines).filter(event => event === 'folded')).to.deep.equal([])
      scope.dispose()
    })

    it('drops the folded from both counts when nothing commits, because folded means committed', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'debug' })

      await scope.emit('cart.clear')
      expect(events(lines)).to.deep.equal(['started', 'effects'])

      lines.length = 0

      await scope.emit('cart.countAfterAwait')
      expect(events(lines)).to.deep.equal(['started', 'effects', 'started', 'effects', 'settled'])

      scope.dispose()
    })

    it('emits seven events for a successful command that moves state, four of them for its outcome', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'debug' })

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })

      expect(events(lines)).to.deep.equal(['started', 'folded', 'effects', 'started', 'folded', 'effects', 'settled'])

      const [first] = records(lines) as { type: string; cause: string; __seq: number }[]
      expect(first.type).to.equal('cart.add')
      expect(first.cause).to.equal('emit')
      expect(first.__seq).to.be.a('number').and.greaterThan(0)

      const done = records(lines)[6] as { type: string; __originSeq: number }
      expect(done.type).to.equal('cart.add.done')
      expect(done.__originSeq).to.equal(first.__seq)

      scope.dispose()
    })

    it('reports which fields moved, by name and per domain', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'debug' })

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })

      const folded = records(lines).filter((_record, index) => events(lines)[index] === 'folded') as unknown as {
        fields: Record<string, string[]>
      }[]

      expect(folded[0].fields).to.deep.equal({ cart: ['pending'] })

      expect(Object.keys(folded[1].fields)).to.deep.equal(['cart'])
      expect(folded[1].fields.cart).to.include.members(['items', 'skus', 'subtotal', 'itemCount'])
    })

    it('names a key that arrived holding undefined, which was published but went unreported', async () => {
      const { lines, logger } = recorder()
      const scope = createScope({ domains: [roundTrip], logger, logLevel: 'debug' })

      await scope.emit('roundTrip.addNote')

      const folded = records(lines).filter((_record, index) => events(lines)[index] === 'folded') as unknown as {
        fields: Record<string, string[]>
      }[]

      expect(Object.hasOwn(scope.read('roundTrip'), 'note'), 'the key was published').to.equal(true)
      expect(folded[0].fields).to.deep.equal({ roundTrip: ['note'] })
      scope.dispose()
    })

    it('reports a view added after defineDomain, because the key list is read fresh each fold rather than snapshotted once', async () => {
      const { lines, logger } = recorder()

      const lateView = defineDomain('lateView', [], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      })

      ;(lateView as { views: Record<string, unknown> }).views = {
        doubled: view<'lateView', number, number>(
          s => s.n,
          n => n * 2,
        ),
      }

      const scope = createScope({ domains: [lateView], logger, logLevel: 'debug' })
      await scope.emit('lateView.bump')

      const folded = records(lines).filter((_record, index) => events(lines)[index] === 'folded') as unknown as {
        fields: Record<string, string[]>
      }[]

      expect(folded[0].fields.lateView).to.include.members(['n', 'doubled'])

      scope.dispose()
    })

    it('emits folded before the first subscriber runs, so a reaction cannot erase the commit', async () => {
      const trace: string[] = []
      const scope = scopeOf({
        logLevel: 'debug',
        logger: {
          debug: (...args: unknown[]) => trace.push(String(args[0]).replace('eddy: ', '')),
          info: () => undefined,
          error: () => undefined,
        },
      })
      scope.subscribe(() => trace.push('subscriber'))

      await scope.emit('audit.note', { what: 'x' })

      expect(trace).to.include('folded')
      expect(trace).to.include('subscriber')
      expect(trace.indexOf('folded')).to.be.lessThan(trace.indexOf('subscriber'))
      scope.dispose()
    })

    it('logs a rejecting command as rejected, at info, with the trace off', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'info' })

      await rejects(scope.emit('cart.fail'), /always fails/)

      expect(events(lines)).to.deep.equal(['rejected'])

      // Settings are construction-time state, so raising the level means a second scope.
      const loud = recorder()
      const louder = scopeOf({ logger: loud.logger, logLevel: 'debug' }, 'log-test-loud')
      await rejects(louder.emit('cart.fail'), /always fails/)
      expect(events(loud.lines)).to.deep.equal(['started', 'effects', 'started', 'effects', 'rejected'])

      louder.dispose()
      scope.dispose()
    })

    it('logs a fold failure as rejected too', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'info' })

      await rejects(scope.emit('audit.note', { what: (() => undefined) as never }), /not a supported state value/)

      expect(events(lines)).to.deep.equal(['rejected'])
      scope.dispose()
    })

    it('logs supersession once, by address, with no version', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'info' })

      const first = scope.emit('cart.slow', { tag: 'a' })
      const second = scope.emit('cart.slow', { tag: 'b' })

      await rejects(first, /superseded/)
      await second

      const superseded = records(lines).filter((_record, index) => events(lines)[index] === 'superseded')
      expect(superseded).to.have.length(1)

      expect(superseded[0]).to.deep.equal({ scope: 'log-test', address: 'cart.slow' })

      scope.dispose()
    })

    it('logs disposal bare', () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'info' })

      scope.dispose()

      expect(events(lines)).to.deep.equal(['disposed'])
      expect(records(lines)[0]).to.deep.equal({ scope: 'log-test' })
    })

    it('says nothing at the default level except a handler that failed after its cancellation', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger })

      await scope.emit('audit.note', { what: 'x' })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      const first = scope.emit('cart.slow', { tag: 'a' })
      const second = scope.emit('cart.slow', { tag: 'b' })
      await rejects(first, /superseded/)
      await second
      await rejects(scope.emit('cart.fail'), /always fails/)
      scope.dispose()

      // The superseded 'a' handler throws once it sees its own abort. That failure reaches nobody
      // else — the caller already has its CommandAborted — so the reporter is the only place left
      // for it, and the reporter's default writes an error line.
      expect(lines.map(line => line.level)).to.deep.equal(['error'])
      expect(lines[0]?.args?.[0]).to.equal('eddy: unhandled error')
    })
  })

  describe('the sink', () => {
    it('drops the diagnostics a logger causes, rather than recursing into them', async () => {
      let entered = 0
      let emitted = 0
      const scope: ReturnType<typeof scopeOf> = scopeOf({
        logLevel: 'info',
        logger: {
          debug: () => undefined,
          info: () => {
            entered += 1
            emitted += 1
            void scope.emit('cart.slow', { tag: 'from-the-logger' })
          },
          error: () => undefined,
        },
      })

      const first = scope.emit('cart.slow', { tag: 'a' })
      const second = scope.emit('cart.slow', { tag: 'b' })
      await rejects(first, /superseded/)
      await rejects(second, /superseded/)
      await flush()

      expect(entered).to.equal(1)
      expect(emitted).to.equal(1)

      scope.dispose()
      await flush()
    })

    it('contains a throwing sink, and does not report it through the sink', async () => {
      const errors: unknown[] = []
      const scope = scopeOf({
        logLevel: 'debug',
        onUnhandledError: error => errors.push(error),
        logger: {
          debug: () => {
            throw new Error('the logger is broken')
          },
          info: () => undefined,
          error: () => undefined,
        },
      })
      await scope.emit('audit.note', { what: 'x' })

      expect(scope.read('audit').seen).to.deep.equal(['x'])

      expect(errors).to.deep.equal([])
      scope.dispose()
    })

    it('does not let an async sink rejection reach the platform', () => {
      const seen = platformRejections(`
import { createScope, defineDomain, reduce } from 'SRC'
const probe = (defineDomain as any)('probe', [], {
  state: { n: 0 },
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },
})
void (createScope as any)({
  name: 'probe',
  domains: [probe],
  logLevel: 'debug',
  logger: {
    debug: async () => { throw new Error('the sink is unreachable') },
    info: async () => { throw new Error('the sink is unreachable') },
    error: () => undefined,
  },
}).emit('probe.bump')
`)

      expect(seen).to.deep.equal([])
    })

    it('observes a genuine rejecting promise from the sink rather than dropping it unobserved', async () => {
      let rejected = false
      const scope = scopeOf({
        logLevel: 'debug',
        logger: {
          debug: () =>
            Promise.reject(new Error('the sink is unreachable')).catch(error => {
              rejected = true
              throw error
            }),
          info: () => undefined,
          error: () => undefined,
        },
      })

      await scope.emit('audit.note', { what: 'x' })
      await flush()

      expect(rejected).to.equal(true)
      scope.dispose()
    })

    it('leaves a sink return that merely looks thenable alone, because it is application data', async () => {
      let invoked = false
      const scope = scopeOf({
        logLevel: 'debug',
        logger: {
          debug: () => ({
            then: () => {
              invoked = true
            },
          }),
          info: () => undefined,
          error: () => undefined,
        },
      })

      await scope.emit('audit.note', { what: 'x' })
      await flush()

      expect(invoked, 'a `then` field on ordinary data is not a promise').to.equal(false)
      scope.dispose()
    })
  })

  describe('the payload rule, and its ceiling', () => {
    it('renders an Error, so a leaked one cannot hide from the sentinel search', () => {
      expect(JSON.stringify([new Error(SENTINEL)])).to.not.contain(SENTINEL)
      expect(render([new Error(SENTINEL)])).to.contain(SENTINEL)
    })

    it('keeps inputs, results and errors out of the diagnostic stream', async () => {
      const { lines, logger } = recorder()
      const scope = scopeOf({ logger, logLevel: 'debug' })

      await scope.emit('cart.add', { sku: SENTINEL, qty: 1 })

      await rejects(scope.emit('cart.add', { sku: SENTINEL, qty: 0 }), /qty must be at least 1/)
      await scope.emit('session.signIn', { email: SENTINEL })
      scope.dispose()

      const diagnostics = lines.filter(line => line.level !== 'error')

      expect(diagnostics.length).to.be.greaterThan(0)
      for (const line of diagnostics) {
        expect(render(line.args)).to.not.contain(SENTINEL)
      }
    })

    it('really does throw the sentinel, which is the premise the rule above is tested against', async () => {
      const scope = scopeOf()

      await rejects(scope.emit('cart.add', { sku: SENTINEL, qty: 0 }), /qty must be at least 1/)
      scope.dispose()

      expect(observed.failures[0]).to.contain(SENTINEL)
    })

    it('cannot keep a host string out of it, which is the ceiling', async () => {
      const { lines, logger } = recorder()
      const scope = createScope({
        logger,
        logLevel: 'debug',
        name: SENTINEL,
        domains: [cart, session, audit],
      })

      await scope.emit('audit.note', { what: 'x' })

      const diagnostics = lines.filter(line => line.level !== 'error')
      expect(diagnostics.length).to.be.greaterThan(0)
      for (const line of diagnostics) {
        expect(render(line.args)).to.contain(SENTINEL)
      }
      scope.dispose()
    })
  })
})
