import { expect } from 'chai'
import { CommandAborted, cmd, createScope, defineDomain, effect, reduce, view, watch } from '../src/index'
import type { Cmd, DomainType, Reduce, Scope } from '../src/index'
import { flush } from '../src/testing'
import { PENDING, buildModeProbe, rejects, settlement } from './helpers'

type LiveState = { n: number }
type LiveActions = { go: Reduce; other: Reduce }

type TearState = { n: number }
type TearActions = { bump: Reduce }

type CacheState = { n: number }
type CacheViews = { doubled: number }
type CacheActions = { bump: Reduce }

type SettleState = { n: number }
type SettleActions = { go: Cmd<void, string>; explode: Cmd<void, string> }

type LateFailureState = { n: number }
type LateFailureActions = { work: Cmd<void, string> }

type FirstState = { n: number }
type FirstActions = { go: Cmd<void, string> }
type SecondState = { marker: string }
type SecondActions = { noop: Reduce }

declare module '../src/types' {
  interface Domains {
    live: DomainType<LiveState, LiveActions>
    logout: DomainType<{ n: number }, { go: Reduce }>
    tear: DomainType<TearState, TearActions>
    cached: DomainType<CacheState, CacheActions, CacheViews>
    settle: DomainType<SettleState, SettleActions>
    lateFailure: DomainType<LateFailureState, LateFailureActions>
    first: DomainType<FirstState, FirstActions>
    second: DomainType<SecondState, SecondActions>
  }
}

const lateFailure = defineDomain('lateFailure', [], {
  state: () => ({ n: 0 }),
  actions: {
    // Fails on its own account after the scope cancelled it: not the cancellation, a bug.
    work: cmd(async (): Promise<string> => {
      await new Promise(resolve => setTimeout(resolve, 5))
      throw new Error('the handler broke after it was cancelled')
    }),
  },
})

let disposeFromEffect = false
let current: { dispose: () => void } | undefined
let log: string[] = []

const live = defineDomain('live', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: reduce(state => ({ n: state.n + 1 })),
    other: reduce(state => ({ n: state.n + 100 })),
  },
  effects: {
    'live.go': effect(() => {
      log.push('domain-effect')
      if (disposeFromEffect) {
        current!.dispose()
      }
    }),
  },
})

const settle = defineDomain('settle', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: cmd(async () => 'ok', { done: (_state, action) => ({ n: 1 }) }),

    explode: cmd(async () => 'handler-success', {
      done: () => {
        current!.dispose()
        throw new Error('terminal fold failed')
      },
    }),
  },
})

describe('disposal — delivery', () => {
  beforeEach(() => {
    log = []
    disposeFromEffect = false
  })

  it('a dispose() from a domain effect stops the listeners after it', async () => {
    disposeFromEffect = true
    const scope = createScope({ domains: [live] })
    current = scope
    scope.on('live.go', () => log.push('listener-1'))
    scope.on('*', () => log.push('wildcard'))

    await scope.emit('live.go').catch(() => undefined)

    expect(log).to.deep.equal(['domain-effect'])
  })

  it('a dispose() from a listener stops the listeners after it', async () => {
    const scope = createScope({ domains: [live] })
    current = scope
    scope.on('live.go', () => {
      log.push('listener-1')
      scope.dispose()
    })
    scope.on('live.go', () => log.push('listener-2'))
    scope.on('*', () => log.push('wildcard'))

    await scope.emit('live.go').catch(() => undefined)

    expect(log).to.deep.equal(['domain-effect', 'listener-1'])
  })

  it('a dispose() from a subscriber stops the subscribers after it', async () => {
    const scope = createScope({ domains: [live] })
    current = scope
    scope.subscribe(() => {
      log.push('subscriber-1')
      scope.dispose()
    })
    scope.subscribe(() => log.push('subscriber-2'))
    scope.on('live.go', () => log.push('listener'))

    const outcome = await scope.emit('live.go').then(
      () => 'resolved',
      () => 'rejected',
    )

    expect(log).to.deep.equal(['subscriber-1'])
    expect(outcome, 'the fold committed before disposal, so its caller hears that').to.equal('resolved')
    expect(scope.read('live')).to.deep.equal({ n: 1 })
  })

  // The hazard this pins: the effect that POSTs with the credential the logout invalidated.
  it("runs neither a fold's watcher nor its effect once a subscriber disposed the scope", async () => {
    const ran: string[] = []

    const logout = defineDomain('logout', [], {
      state: () => ({ n: 0 }),
      actions: { go: reduce(state => ({ n: state.n + 1 })) },
      watch: {
        seen: watch(
          state => state.n,
          () => {
            ran.push('watcher')
          },
        ),
      },
      effects: {
        'logout.go': effect(() => {
          ran.push('effect')
        }),
      },
    })

    const scope = createScope({ name: 'logout-disposes', domains: [logout] })
    scope.subscribe(() => scope.dispose())

    await scope.emit('logout.go').catch(() => undefined)
    await flush()

    expect(ran).to.deep.equal([])
  })

  for (const disposer of ['source', 'teardown'] as const) {
    it(`a dispose() from a watcher's ${disposer} stops that watcher's handler`, async () => {
      const heard: string[] = []
      let scope: { dispose: () => void } | undefined

      const tear = defineDomain('tear', [], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          n: watch(
            state => {
              if (disposer === 'source' && state.n === 2) {
                scope!.dispose()
              }
              return state.n
            },
            next => {
              heard.push(`handler-${next}`)
              return () => {
                heard.push(`teardown-${next}`)
                if (disposer === 'teardown') {
                  scope!.dispose()
                }
              }
            },
          ),
        },
      })

      const created = createScope({ domains: [tear] })
      scope = created
      await created.emit('tear.bump')
      await created.emit('tear.bump').catch(() => undefined)
      await flush()

      expect(heard).to.deep.equal(['handler-1', 'teardown-1'])
    })
  }

  it('a dispose() from a watcher stops the watchers after it', async () => {
    const ran: string[] = []
    let scope: { dispose: () => void } | undefined

    const pair = defineDomain('tear', [], {
      state: () => ({ n: 0 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      watch: {
        first: watch(
          state => state.n,
          () => {
            ran.push('first')
            scope!.dispose()
          },
        ),
        second: watch(
          state => state.n,
          () => {
            ran.push('second')
          },
        ),
      },
    })

    const created = createScope({ domains: [pair] })
    scope = created
    await created.emit('tear.bump').catch(() => undefined)
    await flush()

    expect(ran).to.deep.equal(['first'])
  })

  it('a dispose() from the terminal reaction still resolves the already-decided outcome', async () => {
    const scope = createScope({ domains: [settle] })
    scope.on('settle.go.done', () => scope.dispose())

    const result = await scope.emit('settle.go')

    expect(result).to.equal('ok')
  })

  it("a terminal fold that disposes and then fails does not let its own handler's success win", async () => {
    const scope = createScope({ domains: [settle] })
    current = scope

    const outcome = await scope.emit('settle.explode').then(
      (result: unknown) => ({ ok: true, result }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    )

    expect(outcome.ok, 'a handler success must not survive a terminal fold that rolled it back').to.equal(false)
    expect(scope.read('settle')).to.deep.equal({ n: 0 })
  })

  it('a state subscriber that disposes after the terminal fold commits still resolves the decided outcome', async () => {
    const scope = createScope({ domains: [settle] })
    scope.subscribe(() => scope.dispose())

    const result = await scope.emit('settle.go')

    expect(result).to.equal('ok')
    expect(scope.read('settle')).to.deep.equal({ n: 1 })
  })

  it('a logger that disposes on the terminal folded event still resolves the decided outcome', async () => {
    // The logger disposes the scope it belongs to, so its reference is necessarily forward.
    let scope: ReturnType<typeof createScope<[typeof settle]>>
    scope = createScope({
      domains: [settle],
      logLevel: 'debug',
      logger: {
        debug: (event: unknown, record: unknown) => {
          const { type } = (record ?? {}) as { type?: string }
          if (String(event).endsWith('folded') && type === 'settle.go.done') {
            scope.dispose()
          }
        },
        info: () => undefined,
        error: () => undefined,
      },
    })

    const result = await scope.emit('settle.go')

    expect(result).to.equal('ok')
    expect(scope.read('settle')).to.deep.equal({ n: 1 })
  })

  it('an equality getter that disposes after an earlier domain already committed still resolves the decided outcome', function () {
    this.timeout(60000)
    const lines = buildModeProbe(
      `
const a = eddy.defineDomain('a', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: eddy.cmd(async () => 'ok', { done: (_state, action) => ({ n: 1 }) }),
  },
})

const b = eddy.defineDomain('b', ['a'], {
  state: () => ({ marker: { tag: 'seed' } }),
  actions: { noop: eddy.reduce({}) },
  on: {
    'a.go.done': eddy.reduce(() => ({
      marker: {
        get tag() {
          // Dispose only during the post-draft equality read.
          if (scope.read('a').n === 1) {
            scope.dispose()
          }
          return 'new'
        },
      },
    })),
  },
})

const scope = eddy.createScope({ domains: [a, b] })

scope.emit('a.go').then(
  result => console.log('OUTCOME:' + JSON.stringify({ ok: true, result })),
  error => console.log('OUTCOME:' + JSON.stringify({ ok: false, error: String(error) })),
)

setTimeout(() => console.log('STATE_A:' + JSON.stringify(scope.read('a'))), 50)
`,
      { env: { NODE_ENV: 'production' } },
    )

    expect(lines).to.deep.equal(['OUTCOME:{"ok":true,"result":"ok"}', 'STATE_A:{"n":1}'])
  })

  it('a hostile views Proxy on a second domain, disposing once the first is committed, does not corrupt the commit', async () => {
    let scopeRef: { read: (domain: 'first') => FirstState; dispose: () => void } | undefined

    const realViews = {}
    const hostileViews = new Proxy(realViews, {
      ownKeys(target) {
        if (scopeRef && scopeRef.read('first').n === 1) {
          scopeRef.dispose()
          throw new Error('ownKeys trap threw')
        }
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop)
      },
    })

    const first = defineDomain('first', [], {
      state: () => ({ n: 0 }),
      actions: {
        go: cmd(async () => 'handler-success', { done: (_state, action) => ({ n: 1 }) }),
      },
    })

    const second = defineDomain('second', ['first'], {
      state: () => ({ marker: 'seed' }),
      actions: { noop: reduce({}) },
      views: hostileViews as never,
      on: {
        'first.go.done': reduce(() => ({ marker: 'new' })),
      },
    })

    const scope = createScope({ domains: [first, second] })
    scopeRef = scope

    const result = await scope.emit('first.go')

    expect(result).to.equal('handler-success')
    expect(scope.read('first')).to.deep.equal({ n: 1 })
    expect(scope.read('second')).to.deep.equal({ marker: 'new' })
    expect(scope.getState()).to.deep.equal({ first: { n: 1 }, second: { marker: 'new' } })
  })

  it("mutating a domain definition's own key list during drafting cannot corrupt a later commit", async () => {
    let scopeRef: { dispose: () => void } | undefined

    const first = defineDomain('first', [], {
      state: () => ({ n: 0 }),
      actions: {
        go: cmd(async () => 'handler-success', { done: (_state, action) => ({ n: 1 }) }),
      },
    })

    const second = defineDomain('second', ['first'], {
      state: () => ({ marker: 'seed' }),
      actions: { noop: reduce({}) },
      on: {
        'first.go.done': reduce(() => {
          ;(second as { viewKeys?: unknown }).viewKeys = {
            [Symbol.iterator]() {
              scopeRef!.dispose()
              throw new Error('hostile iterable')
            },
          }
          return { marker: 'new' }
        }),
      },
    })

    const scope = createScope({ domains: [first, second] })
    scopeRef = scope

    const result = await scope.emit('first.go')

    expect(result).to.equal('handler-success')
    expect(scope.read('first')).to.deep.equal({ n: 1 })
    expect(scope.read('second')).to.deep.equal({ marker: 'new' })
    expect(scope.getState()).to.deep.equal({ first: { n: 1 }, second: { marker: 'new' } })
  })

  it("a hostile accessor on a domain definition's own name does not corrupt a later commit", async () => {
    let scopeRef: { read: (domain: 'first') => FirstState; dispose: () => void } | undefined

    const first = defineDomain('first', [], {
      state: () => ({ n: 0 }),
      actions: {
        go: cmd(async () => 'handler-success', { done: (_state, action) => ({ n: 1 }) }),
      },
    })

    const second = defineDomain('second', ['first'], {
      state: () => ({ marker: 'seed' }),
      actions: { noop: reduce({}) },
      on: {
        'first.go.done': reduce(() => ({ marker: 'new' })),
      },
    })

    Object.defineProperty(second, 'name', {
      configurable: true,
      get() {
        if (scopeRef && scopeRef.read('first').n === 1) {
          scopeRef.dispose()
          throw new Error('hostile name accessor')
        }
        return 'second'
      },
    })

    const scope = createScope({ domains: [first, second] })
    scopeRef = scope

    const result = await scope.emit('first.go')

    expect(result).to.equal('handler-success')
    expect(scope.read('first')).to.deep.equal({ n: 1 })
    expect(scope.read('second')).to.deep.equal({ marker: 'new' })
    expect(scope.getState()).to.deep.equal({ first: { n: 1 }, second: { marker: 'new' } })
  })

  it('refuses the next emit after a reaction disposed the scope', async () => {
    disposeFromEffect = true
    const scope = createScope({ domains: [live] })
    current = scope

    await scope.emit('live.go').catch(() => undefined)
    expect(log).to.deep.equal(['domain-effect'])

    let refused: unknown
    await scope.emit('live.other').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).to.match(/disposed/)
  })
})

describe('disposal — watcher teardowns', () => {
  it('runs the previous teardown before the next fire, and again on dispose', async () => {
    const events: string[] = []
    let fires = 0

    const tear = defineDomain('tear', [], {
      state: () => ({ n: 0 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      watch: {
        n: watch(
          state => state.n,
          next => {
            const id = ++fires
            events.push(`open-${id}(n=${next})`)
            return () => events.push(`close-${id}`)
          },
        ),
      },
    })

    const scope = createScope({ domains: [tear] })

    await scope.emit('tear.bump')
    await flush()
    expect(events).to.deep.equal(['open-1(n=1)'])

    await scope.emit('tear.bump')
    await flush()
    expect(events).to.deep.equal(['open-1(n=1)', 'close-1', 'open-2(n=2)'])

    scope.dispose()
    expect(events).to.deep.equal(['open-1(n=1)', 'close-1', 'open-2(n=2)', 'close-2'])
  })

  it('runs a teardown exactly once when the handler that returned it disposed the scope', async () => {
    const events: string[] = []
    let scope: { dispose: () => void } | undefined

    const tear = defineDomain('tear', [], {
      state: () => ({ n: 0 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      watch: {
        n: watch(
          state => state.n,
          () => {
            events.push('open')

            scope!.dispose()
            return () => events.push('close')
          },
        ),
      },
    })

    scope = createScope({ domains: [tear] })
    await (scope as never as { emit: (a: string) => Promise<unknown> }).emit('tear.bump').catch(() => undefined)
    await flush()

    expect(events).to.deep.equal(['open', 'close'])

    scope.dispose()
    expect(events).to.deep.equal(['open', 'close'])
  })

  it('reports a throwing teardown and still runs the ones behind it', async () => {
    const errors: unknown[] = []
    const events: string[] = []

    const tear = defineDomain('tear', [], {
      state: () => ({ n: 0 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      watch: {
        first: watch(
          state => state.n,
          () => () => {
            throw new Error('teardown exploded')
          },
        ),
        second: watch(
          state => state.n,
          () => () => events.push('second closed'),
        ),
      },
    })

    const scope = createScope({ domains: [tear], onUnhandledError: error => errors.push(error) })

    await scope.emit('tear.bump')
    await flush()

    scope.dispose()

    expect(events).to.deep.equal(['second closed'])
    expect(errors.map(String)).to.deep.equal(['Error: teardown exploded'])
  })

  it('leaves a handler that returns nothing exactly as it was', async () => {
    const seen: number[] = []

    const tear = defineDomain('tear', [], {
      state: () => ({ n: 0 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      watch: {
        n: watch(
          state => state.n,
          next => {
            seen.push(next)
          },
        ),
      },
    })

    const scope = createScope({ domains: [tear] })
    await scope.emit('tear.bump')
    await flush()
    expect(seen).to.deep.equal([1])

    expect(() => scope.dispose()).to.not.throw()
  })
})

describe('disposal — release', () => {
  it('still answers reads, with the same values, after releasing its caches', async () => {
    let transforms = 0

    const cached = defineDomain('cached', [], {
      state: () => ({ n: 1 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      views: {
        doubled: view(
          state => state.n,
          n => {
            transforms += 1
            return n * 2
          },
        ),
      },
    })

    const scope = createScope({ domains: [cached] })

    await scope.emit('cached.bump')
    await flush()
    expect(scope.read('cached')).to.deep.equal({ n: 2, doubled: 4 })
    const before = transforms

    scope.dispose()

    expect(scope.read('cached')).to.deep.equal({ n: 2, doubled: 4 })
    expect(transforms).to.equal(before)
  })

  it('disposes a scope with warm caches and live watchers without throwing', async () => {
    const cached = defineDomain('cached', [], {
      state: () => ({ n: 1 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      views: {
        doubled: view(
          state => state.n,
          n => n * 2,
        ),
      },
    })

    const scope = createScope({ domains: [cached] })
    await scope.emit('cached.bump')
    await flush()

    expect(() => scope.dispose()).to.not.throw()

    expect(() => scope.dispose()).to.not.throw()
  })
})

describe('disposal — what a disposed scope answers', () => {
  it('still validates an address on `on`, so disposal cannot hide a typo', () => {
    const scope = createScope({ domains: [live] })
    scope.dispose()

    expect(() => scope.on('live.nosuch' as never, () => undefined)).to.throw(/declares no such action/)
    expect(() => scope.on('nothing.at.all.here' as never, () => undefined)).to.throw(/not a valid address/)
  })

  it('accepts a valid `on` after disposal and returns an unsubscribe that does nothing', () => {
    const scope = createScope({ domains: [live] })
    scope.dispose()

    let fired = 0
    const off = scope.on('live.go', () => (fired += 1))

    expect(off).to.be.a('function')
    expect(() => off()).to.not.throw()
    expect(fired).to.equal(0)
  })

  it('accepts `subscribe` after disposal the same way', () => {
    const scope = createScope({ domains: [live] })
    scope.dispose()

    let notified = 0
    const off = scope.subscribe(() => (notified += 1))

    expect(() => off()).to.not.throw()
    expect(notified).to.equal(0)
  })
})

describe('disposal — the one boundary', () => {
  it('answers `read` with the last committed state and refuses every other read', async () => {
    const scope = createScope({ domains: [live] })
    await scope.emit('live.go')
    const before = scope.read('live')

    scope.dispose()

    expect(scope.read('live')).to.equal(before)
    expect(() => scope.getState()).to.throw(CommandAborted, /cannot read every domain/)
  })

  it('refuses a registration without throwing, because a React remount subscribes after disposal', () => {
    const scope = createScope({ domains: [live] })
    scope.dispose()

    let notified = 0
    const off = scope.subscribe(() => (notified += 1))

    expect(off).to.be.a('function')
    expect(() => off()).to.not.throw()
    expect(notified).to.equal(0)
  })

  it('refuses an emit as CommandAborted, which is the class the documentation names', async () => {
    const scope = createScope({ domains: [live] })
    scope.dispose()

    const error = await scope.emit('live.go').then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).to.be.instanceOf(CommandAborted)
    expect((error as Error).message).to.match(/has been disposed/)
  })

  it('stops a reduce that its own onAction hook disposed, instead of folding and resolving', async () => {
    let scopeRef: Scope<'live'> | undefined
    const scope = createScope({
      domains: [live],
      onAction: () => scopeRef?.dispose(),
    })
    scopeRef = scope as unknown as Scope<'live'>

    await rejects(scope.emit('live.go'), /disposed/)
    expect(scope.read('live').n).to.equal(0)
  })

  it('reports a handler that fails after its cancellation, which nobody else would hear', async () => {
    const seen: unknown[] = []
    const scope = createScope({ domains: [lateFailure], onUnhandledError: error => seen.push(error) })
    const running = scope.emit('lateFailure.work')
    scope.dispose()

    await rejects(running, /disposed/)
    // The handler's own timer is still pending; the report happens when it finally rejects.
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(seen).to.have.length(1)
    expect((seen[0] as Error).message).to.equal('the handler broke after it was cancelled')
  })
})

describe('disposal — a handler that never settles', () => {
  it('aborts and settles every superseded invocation, however many there were', async () => {
    const signals: AbortSignal[] = []
    const hang = defineDomain('hangProbe' as never, [], {
      state: () => ({ n: 0 }),
      actions: {
        wait: cmd(
          (_input: unknown, ctx: { signal: AbortSignal }) => {
            signals.push(ctx.signal)
            return new Promise<void>(() => undefined)
          },
          { latest: true },
        ),
      },
    } as never)

    const scope = createScope({ name: 'hang-probe', domains: [hang] as never })
    const settled: Promise<unknown>[] = []
    for (let call = 0; call < 5; call += 1) {
      settled.push(
        (scope.emit as (a: string) => Promise<unknown>)('hangProbe.wait').then(
          () => 'resolved',
          () => 'rejected',
        ),
      )
    }
    await flush()

    scope.dispose()

    expect(await Promise.all(settled), 'every invocation settles').to.deep.equal([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ])
    expect(signals.length, 'every call started its handler').to.equal(5)
    expect(
      signals.filter(signal => !signal.aborted),
      'every handler signal is aborted',
    ).to.deep.equal([])
  })
})
