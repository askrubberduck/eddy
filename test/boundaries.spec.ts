import { expect } from 'chai'
import { buildModeProbe } from './helpers'

// The disposal contract has two halves. No user callback starts once the scope is disposed, and a
// fold publishes only if the scope is still live at the commit point. Every callback on the path
// from dispatch to publication is a place `dispose()` can be called from, so each is one row here,
// run against the built artifact in both builds.
const BOUNDARIES = `
const results = []

const run = async () => {
  for (const boundary of ['logger-started', 'onAction', 'reducer', 'selector', 'transform']) {
    const events = []
    let scope
    let closed = false
    const close = () => {
      events.push('dispose')
      closed = true
      scope.dispose()
    }
    const d = eddy.defineDomain('boundary', [], {
      state: () => ({ n: 0 }),
      actions: {
        bump: eddy.reduce(s => {
          if (boundary === 'reducer') close()
          return { n: s.n + 1 }
        }),
      },
      views: {
        double: eddy.view(
          s => {
            if (scope && boundary === 'selector') close()
            return s.n
          },
          n => {
            if (scope) {
              events.push('transform-after-dispose=' + closed)
              if (boundary === 'transform') close()
            }
            return n * 2
          },
        ),
        triple: eddy.view(
          s => {
            if (scope) events.push('next-selector-after-dispose=' + closed)
            return s.n
          },
          n => n * 3,
        ),
      },
    })
    scope = eddy.createScope({
      domains: [d],
      onAction: () => {
        events.push('onAction-after-dispose=' + closed)
        if (boundary === 'onAction') close()
      },
      onUnhandledError: error => events.push('reported ' + String(error)),
      logLevel: boundary === 'logger-started' ? 'debug' : 'silent',
      logger: {
        debug: event => {
          if (event === 'eddy: started') close()
        },
        info() {},
        error() {},
      },
    })
    const before = scope.read('boundary')
    const outcome = await scope.emit('boundary.bump').then(() => 'resolved', e => e.name)
    await eddy.settled(scope, { timeout: 100 })
    results.push({ boundary, events, unchanged: scope.read('boundary') === before, outcome })
  }

  for (const equal of [false, true]) {
    let scope
    let armed = false
    const events = []
    const old = new Proxy(
      { n: 0 },
      {
        get(target, key, receiver) {
          if (armed && key === 'n') {
            armed = false
            events.push('equality-disposes')
            scope.dispose()
          }
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const d = eddy.defineDomain('equality', [], {
      state: () => ({ n: 0 }),
      actions: { bump: eddy.reduce(s => ({ n: s.n + 1 })) },
      watch: {
        first: eddy.watch(
          s => {
            if (s.n === 0) return old
            armed = true
            return { n: equal ? 0 : 1 }
          },
          () => {
            events.push('handler')
          },
        ),
        second: eddy.watch(
          s => s.n,
          () => {
            events.push('next-watcher')
          },
        ),
      },
      effects: {
        'equality.bump': eddy.effect(() => {
          events.push('effect')
        }),
      },
    })
    scope = eddy.createScope({ domains: [d], onUnhandledError: error => events.push('reported ' + String(error)) })
    await scope.emit('equality.bump')
    await eddy.settled(scope)
    results.push({ boundary: 'watcher-equality-' + equal, events })
  }

  for (const mode of ['normal', 'throw', 'dispose']) {
    let barrier
    const pending = []
    const d = eddy.defineDomain('queue', [], {
      state: () => ({ n: 0 }),
      actions: {
        kick: eddy.reduce(s => ({ n: s.n + 1 })),
        next: eddy.reduce(s => {
          if (mode === 'throw') throw Error('expected')
          return { n: s.n + 1 }
        }),
      },
    })
    const scope = eddy.createScope({ domains: [d] })
    let depth
    scope.on('queue.kick', () => {
      for (let i = 0; i < 100; i++) pending.push(scope.emit('queue.next').catch(() => undefined))
      depth = scope.inspect().queueDepth
      barrier = eddy.settled(scope, { timeout: 100 })
      if (mode === 'dispose') scope.dispose()
    })
    await scope.emit('queue.kick')
    await Promise.all(pending)
    await barrier
    results.push({ boundary: 'queue-' + mode, depth, after: scope.inspect().queueDepth })
    scope.dispose()
  }
  for (const kind of ['reduce', 'terminal']) {
    let scope
    const seen = []
    const d = eddy.defineDomain('commitprobe', [], {
      state: () => ({ n: 0 }),
      actions: {
        bump: eddy.reduce(() => ({ n: 1 })),
        go: eddy.cmd(() => 42, { done: () => ({ n: 1 }) }),
      },
    })
    scope = eddy.createScope({
      domains: [d],
      logLevel: 'debug',
      logger: {
        debug: event => {
          if (event === 'eddy: folded') {
            seen.push(scope.read('commitprobe').n)
            scope.dispose()
            seen.push(scope.read('commitprobe').n)
          }
        },
        info() {},
        error() {},
      },
    })
    const outcome = await scope
      .emit(kind === 'reduce' ? 'commitprobe.bump' : 'commitprobe.go')
      .then(value => ({ resolved: value === undefined ? null : value }), e => ({ rejected: e.name }))
    await eddy.settled(scope)
    seen.push(scope.read('commitprobe').n)
    results.push({ boundary: 'folded-logger-' + kind, seen, outcome })
  }

  for (const boundary of ['watcher', 'subscriber', 'teardown']) {
    for (const kind of ['reduce', 'terminal']) {
      let scope
      const reports = []
      const revoked = Proxy.revocable({}, {})
      revoked.revoke()
      const d = eddy.defineDomain('hostile', [], {
        state: () => ({ n: 0 }),
        actions: {
          bump: eddy.reduce(s => ({ n: s.n + 1 })),
          go: eddy.cmd(() => 42, { done: s => ({ n: s.n + 1 }) }),
        },
        watch: {
          value: eddy.watch(
            s => {
              if (boundary === 'watcher' && s.n) throw revoked.proxy
              return s.n
            },
            () => () => {
              if (boundary === 'teardown') {
                scope.dispose()
                throw revoked.proxy
              }
            },
          ),
        },
      })
      scope = eddy.createScope({ domains: [d], onUnhandledError: e => reports.push(e) })
      if (boundary === 'subscriber') {
        scope.subscribe(() => {
          scope.dispose()
          throw revoked.proxy
        })
      }
      if (boundary === 'teardown') await scope.emit('hostile.bump')
      const outcome = await scope
        .emit(kind === 'reduce' ? 'hostile.bump' : 'hostile.go')
        .then(v => ({ resolved: v === undefined ? null : v }), e => ({ rejected: String(e && e.name) }))
      await eddy.settled(scope)
      results.push({ boundary: 'hostile-' + boundary + '-' + kind, outcome, reports: reports.length })
      scope.dispose()
    }
  }
}

run().then(
  () => console.log('RESULTS:' + JSON.stringify(results)),
  error => console.log('RESULTS:' + JSON.stringify({ crashed: String(error) })),
)
`

for (const build of ['development', 'production'] as const) {
  describe(`disposal boundaries, ${build} build`, function () {
    this.timeout(60000)

    let results: Record<
      string,
      { events?: string[]; unchanged?: boolean; outcome?: string; depth?: number; after?: number }
    >

    before(() => {
      const lines = buildModeProbe(BOUNDARIES, {
        withTesting: true,
        env: build === 'production' ? { NODE_ENV: 'production' } : {},
      })
      const line = lines.find(l => l.startsWith('RESULTS:'))!
      const parsed = JSON.parse(line.slice('RESULTS:'.length)) as unknown
      expect(parsed, line).to.be.an('array')
      results = Object.fromEntries((parsed as { boundary: string }[]).map(result => [result.boundary, result as never]))
    })

    for (const boundary of ['logger-started', 'onAction', 'reducer', 'selector', 'transform']) {
      it(`a dispose() from the ${boundary} starts no further callback, publishes nothing and refuses the emit`, () => {
        const result = results[boundary]

        expect(result.events!.filter(event => event.endsWith('after-dispose=true'))).to.deep.equal([])
        expect(result.events!.filter(event => event.startsWith('reported'))).to.deep.equal([])
        expect(result.unchanged, 'the last committed state is what reads answer').to.equal(true)
        expect(result.outcome).to.equal('CommandAborted')
      })
    }

    for (const equal of [false, true]) {
      it(`a dispose() from a watcher's ${equal ? 'equal' : 'unequal'} equality read stops every later callback`, () => {
        expect(results[`watcher-equality-${equal}`].events).to.deep.equal(['equality-disposes'])
      })
    }

    for (const kind of ['reduce', 'terminal']) {
      it(`a ${kind} fold whose folded logger disposes the scope was published before the logger heard it`, () => {
        const { seen, outcome } = results[`folded-logger-${kind}`] as never as { seen: number[]; outcome: unknown }

        expect(seen, 'what the logger read, what it read after disposing, what reads answer now').to.deep.equal([
          1, 1, 1,
        ])
        expect(outcome).to.deep.equal({ resolved: kind === 'reduce' ? null : 42 })
      })
    }

    for (const boundary of ['watcher', 'subscriber', 'teardown']) {
      for (const kind of ['reduce', 'terminal']) {
        it(`a ${boundary} that throws a revoked Proxy after the ${kind} fold published cannot change its outcome`, () => {
          const { outcome, reports } = results[`hostile-${boundary}-${kind}`] as never as {
            outcome: unknown
            reports: number
          }

          expect(outcome).to.deep.equal({ resolved: kind === 'reduce' ? null : 42 })
          if (boundary === 'watcher') {
            expect(reports, "the failure is the host's, and is reported").to.equal(1)
          }
        })
      }
    }

    for (const hostile of [false, true]) {
      it(`dispose() finishes its cleanup when a teardown throws ${hostile ? 'a revoked Proxy' : 'an Error'}`, () => {
        const [line] = buildModeProbe(
          `
const revoked = Proxy.revocable({}, {})
revoked.revoke()
let watched
let reports = 0
const d = eddy.defineDomain('unwind', [], {
  state: () => ({ n: 0 }),
  actions: { bump: eddy.reduce(() => ({ n: 1 })) },
  watch: {
    large: eddy.watch(
      s => {
        if (!s.n) return null
        const value = new Array(1000).fill(7)
        watched = new WeakRef(value)
        return value
      },
      () => () => {
        throw ${hostile} ? revoked.proxy : new Error('teardown failed')
      },
    ),
  },
})
const scope = eddy.createScope({ domains: [d], onUnhandledError: () => { reports += 1 } })
scope.emit('unwind.bump').then(() => {
  let threw = 'none'
  try {
    scope.dispose()
  } catch (error) {
    threw = 'threw'
  }
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    for (let i = 0; i < 4; i += 1) global.gc()
    console.log('DISPOSE:' + threw + ' RETAINED:' + (watched.deref() !== undefined) + ' REPORTS:' + reports + ' N:' + scope.read('unwind').n)
  })
})
`,
          { execArgv: ['--expose-gc'], env: build === 'production' ? { NODE_ENV: 'production' } : {} },
        )

        expect(line).to.equal('DISPOSE:none RETAINED:false REPORTS:1 N:1')
      })
    }

    it('a handler returning a promise whose own then throws fails that call, and the scope keeps going', () => {
      const [line] = buildModeProbe(
        `
const marker = new Error('host then getter')
const poisoned = Promise.resolve(42)
Object.defineProperty(poisoned, 'then', {
  get() {
    throw marker
  },
})
const d = eddy.defineDomain('poison', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: eddy.cmd(() => poisoned, { called: s => ({ n: s.n + 1 }) }),
    bump: eddy.reduce(s => ({ n: s.n + 1 })),
  },
})
const scope = eddy.createScope({ domains: [d], onUnhandledError() {} })
let returned
let escaped = false
try {
  returned = scope.emit('poison.go')
} catch (error) {
  escaped = true
}
Promise.resolve(returned)
  .then(() => 'resolved', error => (error === marker ? 'rejected with its own failure' : 'rejected ' + String(error)))
  .then(outcome =>
    eddy.settled(scope).then(() => {
      const report = scope.inspect()
      console.log('ESCAPED:' + escaped + ' OUTCOME:' + outcome + ' LIVE:' + report.live + ' RUNNING:' + report.inFlight.length)
    }),
  )
`,
        { withTesting: true, env: build === 'production' ? { NODE_ENV: 'production' } : {} },
      )

      expect(line).to.equal('ESCAPED:false OUTCOME:rejected with its own failure LIVE:0 RUNNING:0')
    })

    it('dispose() finishes every obligation when a caller has poisoned the promise it was handed', () => {
      const [line] = buildModeProbe(
        `
let signal
let finish = () => undefined
let teardowns = 0
const d = eddy.defineDomain('disposepoison', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: eddy.cmd((_input, ctx) => new Promise(resolve => {
      signal = ctx.signal
      finish = resolve
    })),
    bump: eddy.reduce(s => ({ n: s.n + 1 })),
  },
  watch: {
    value: eddy.watch(
      s => s.n,
      () => () => {
        teardowns += 1
      },
    ),
  },
})
const scope = eddy.createScope({ domains: [d], onUnhandledError() {} })
scope.emit('disposepoison.bump').then(async () => {
  const invocation = scope.emit('disposepoison.go')
  let outcome = 'pending'
  Promise.prototype.then.call(invocation, () => { outcome = 'resolved' }, error => { outcome = error.name })
  const retained = (() => {
    const payload = new Array(1000).fill(7)
    scope.subscribe(() => payload.length)
    return new WeakRef(payload)
  })()
  Object.defineProperty(invocation, 'then', {
    get() {
      throw new Error('public promise then getter')
    },
  })
  Object.defineProperty(invocation, 'constructor', {
    get() {
      throw new Error('public promise constructor getter')
    },
  })
  let escaped = false
  try {
    scope.dispose()
  } catch (error) {
    escaped = true
  }
  finish(42)
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 4; i += 1) global.gc()
  console.log(
    'ESCAPED:' + escaped + ' ABORTED:' + signal.aborted + ' OUTCOME:' + outcome + ' TEARDOWNS:' + teardowns +
      ' RETAINED:' + (retained.deref() !== undefined),
  )
})
`,
        { execArgv: ['--expose-gc'], env: build === 'production' ? { NODE_ENV: 'production' } : {} },
      )

      expect(line).to.equal('ESCAPED:false ABORTED:true OUTCOME:CommandAborted TEARDOWNS:1 RETAINED:false')
    })

    it('a watcher source that disposes the scope leaves nothing of its value behind', () => {
      const [line] = buildModeProbe(
        `
let scope
let watched
let handlers = 0
const d = eddy.defineDomain('retention', [], {
  state: () => ({ n: 0 }),
  actions: { bump: eddy.reduce(() => ({ n: 1 })) },
  watch: {
    large: eddy.watch(
      s => {
        if (!s.n) return null
        const value = new Array(1000).fill(7)
        watched = new WeakRef(value)
        scope.dispose()
        return value
      },
      () => {
        handlers++
      },
    ),
  },
})
scope = eddy.createScope({ domains: [d] })
scope.emit('retention.bump').then(() => new Promise(resolve => setImmediate(resolve))).then(() => {
  for (let i = 0; i < 4; i += 1) global.gc()
  console.log('RETAINED:' + (watched.deref() !== undefined) + ' HANDLERS:' + handlers + ' N:' + scope.read('retention').n)
})
`,
        { execArgv: ['--expose-gc'], env: build === 'production' ? { NODE_ENV: 'production' } : {} },
      )

      expect(line).to.equal('RETAINED:false HANDLERS:0 N:1')
    })

    for (const mode of ['normal', 'throw', 'dispose']) {
      it(`a settled() begun with a full queue finishes with it empty (${mode})`, () => {
        expect(results[`queue-${mode}`]).to.deep.include({ depth: 100, after: 0 })
      })
    }
  })
}
