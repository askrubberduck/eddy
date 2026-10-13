import { expect } from 'chai'
import { cmd, createScope, defineDomain, reduce } from '../src/index'
import { settled } from '../src/testing'
import { buildModeProbe } from './helpers'

type VersionModule = typeof import('../src/internal/version')

function freshInstance(): VersionModule {
  const modulePath = require.resolve('../src/internal/version')
  delete require.cache[modulePath]
  return require(modulePath) as VersionModule
}

describe('internal/version', () => {
  it('shares one monotonic counter across two distinct instances of the module', () => {
    const first = freshInstance()
    first.resetVersion()

    expect(first.nextVersion()).to.equal(1)
    expect(first.nextVersion()).to.equal(2)

    const second = freshInstance()

    expect(second).to.not.equal(first)
    expect(second.nextVersion).to.not.equal(first.nextVersion)

    expect(second.nextVersion()).to.equal(3)
    expect(first.nextVersion()).to.equal(4)

    first.resetVersion()
  })

  it('starts at 1 and is never 0, even from a freshly reset counter', () => {
    const version = freshInstance()
    version.resetVersion()

    const seen = [version.nextVersion(), version.nextVersion(), version.nextVersion()]

    expect(seen).to.deep.equal([1, 2, 3])
    expect(seen.every(n => n > 0)).to.equal(true)

    version.resetVersion()
  })

  it('writes through the documented key, and the counter under it obeys the documented contract', () => {
    const KEY = '@askrubberduck/eddy/sequence-counter@1'
    const registry = globalThis as unknown as Record<symbol, { counter: number } | undefined>
    const symbol = Symbol.for(KEY)

    const version = freshInstance()
    version.resetVersion()

    const seen = [version.nextVersion(), version.nextVersion(), version.nextVersion()]
    expect(seen).to.deep.equal([1, 2, 3])
    expect(seen.every(n => Number.isInteger(n))).to.equal(true)
    expect(registry[symbol]?.counter).to.equal(3)

    version.resetVersion()
    expect(version.nextVersion()).to.equal(1)
    expect(registry[symbol]?.counter).to.equal(1)

    version.resetVersion()
  })

  it('does not rewind in a production build, where a reissued version makes isStale lie', function () {
    this.timeout(60000)

    // A rewind reissues a version already carried by an in-flight request, and `isStale` compares
    // by equality — so a genuinely new response reads as not stale against an old marker.
    const PROBE = `
const domain = eddy.defineDomain('probe', [], {
  state: () => ({ n: 0 }),
  actions: { go: eddy.cmd(async i => i, { done: s => ({ n: s.n + 1 }) }) },
})
const scope = eddy.createScope({ domains: [domain], onUnhandledError: () => {} })
const stamps = []
scope.on('probe.go.done', a => stamps.push(a))
scope.emit('probe.go', 1).then(() => {
  eddy.resetVersion()
  return scope.emit('probe.go', 2)
}).then(() => {
  console.log('REISSUED:' + (stamps[1].__originSeq === stamps[0].__originSeq))
  console.log('STALE_LIES:' + (eddy.isStale(stamps[1], stamps[0].__originSeq) === false))
})
`
    expect(buildModeProbe(PROBE, { env: { NODE_ENV: 'production' }, withTesting: true })).to.deep.equal([
      'REISSUED:false',
      'STALE_LIES:false',
    ])
  })

  describe('settled', () => {
    it('waits exactly as long as the scope needs, rather than a tuned number of turns', async () => {
      const slow = defineDomain('slowly' as never, [], {
        state: () => ({ done: false }),
        actions: {
          go: cmd(
            (async () => {
              await new Promise(resolve => setTimeout(resolve, 120))
              return true
            }) as never,
            { done: () => ({ done: true }) } as never,
          ),
        },
      })

      const scope = createScope({ name: 'slowly', domains: [slow] as never })
      void (scope.emit as (a: string) => Promise<unknown>)('slowly.go')

      await settled(scope)

      // A 120ms handler needs a hundred-odd macrotask turns; `flush(3)` would not have got here.
      expect((scope.read('slowly' as never) as { done: boolean }).done).to.equal(true)
      expect(scope.inspect().live).to.equal(0)
      scope.dispose()
    })

    it('throws naming the scope and what was outstanding, rather than hanging', async () => {
      const stuck = defineDomain('stuck' as never, [], {
        state: () => ({ n: 0 }),
        actions: { wait: cmd((() => new Promise(() => undefined)) as never) },
      })

      const scope = createScope({ name: 'never-quiet', domains: [stuck] as never })
      void (scope.emit as (a: string) => Promise<unknown>)('stuck.wait').catch(() => undefined)

      let message = ''
      try {
        await settled(scope, { timeout: 60 })
      } catch (error) {
        message = String((error as Error).message)
      }

      expect(message).to.contain("Scope 'never-quiet' did not settle")
      expect(message, 'and names the address').to.contain('stuck.wait')
      scope.dispose()
    })

    it('waits for work a queued action has yet to start, when called from inside a dispatch', async () => {
      let release!: () => void
      const relay = defineDomain('relay' as never, [], {
        state: () => ({ n: 0 }),
        actions: {
          kick: reduce(((state: { n: number }) => ({ n: state.n + 1 })) as never),
          spawn: reduce(((state: { n: number }) => ({ n: state.n + 1 })) as never),
          wait: cmd((() => new Promise<void>(resolve => (release = resolve))) as never),
        },
      })
      const scope = createScope({ name: 'relay', domains: [relay] as never }) as never as {
        emit: (a: string) => Promise<unknown>
        on: (a: string, h: () => void) => () => void
        inspect: () => { queueDepth: number; inFlight: string[]; live: number }
        name: string
      }

      let waiter!: Promise<void>
      let command!: Promise<unknown>
      scope.on('relay.kick', () => {
        void scope.emit('relay.spawn')
        waiter = settled(scope, { timeout: 500 })
      })
      scope.on('relay.spawn', () => {
        command = scope.emit('relay.wait')
      })

      await scope.emit('relay.kick')
      let resolved = false
      void waiter.then(() => {
        resolved = true
      })
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(resolved, 'the command the queued spawn started is still running').to.equal(false)
      release()
      await command
      await waiter
    })

    describe('a cancelled handler that is still running', () => {
      let finished: string[]
      const gates: Record<string, () => void> = {}

      // Ignores its signal, as a handler may: cancelling it settles the caller, not the handler.
      const deaf = defineDomain('deaf' as never, [], {
        state: () => ({ n: 0 }),
        actions: {
          run: cmd(
            (async (input: { tag: string; fail?: boolean }) => {
              await new Promise<void>(resolve => {
                gates[input.tag] = resolve
              })
              finished.push(input.tag)
              if (input.fail) {
                throw new Error(`${input.tag} failed on its own account`)
              }
              return input.tag
            }) as never,
            { latest: true } as never,
          ),
        },
      })

      beforeEach(() => {
        finished = []
      })

      type DeafScope = {
        emit: (a: string, i: unknown) => Promise<unknown>
        inspect: () => { queueDepth: number; inFlight: string[]; live: number }
        name: string
        dispose: () => void
      }

      it('is in flight until it returns, though the scope no longer owns its invocation', async () => {
        const scope = createScope({ name: 'deaf', domains: [deaf] as never }) as never as DeafScope
        const first = scope.emit('deaf.run', { tag: 'first' }).catch(() => undefined)
        const second = scope.emit('deaf.run', { tag: 'second' })

        expect(scope.inspect().inFlight, 'both handlers are running').to.deep.equal(['deaf.run', 'deaf.run'])
        expect(scope.inspect().live, 'only the newer call is owed an outcome').to.equal(1)

        gates.second()
        await second
        await first
        expect(scope.inspect().inFlight, 'the superseded one still runs').to.deep.equal(['deaf.run'])

        gates.first()
        await settled(scope)
        expect(scope.inspect().inFlight).to.deep.equal([])
        scope.dispose()
      })

      it('holds settled until it returns, so its late failure is reported inside the test', async () => {
        const reports: string[] = []
        const scope = createScope({
          name: 'deaf-late',
          domains: [deaf] as never,
          onUnhandledError: error => reports.push(String(error)),
        }) as never as DeafScope

        void scope.emit('deaf.run', { tag: 'first', fail: true }).catch(() => undefined)
        const second = scope.emit('deaf.run', { tag: 'second' })
        gates.second()
        await second
        setTimeout(() => gates.first(), 20)

        await settled(scope)

        expect(finished).to.deep.equal(['second', 'first'])
        expect(reports).to.deep.equal(['Error: first failed on its own account'])
        scope.dispose()
      })

      it('is still in flight after disposal cancelled it, and settled waits for it', async () => {
        const scope = createScope({ name: 'deaf-disposed', domains: [deaf] as never }) as never as DeafScope
        const running = scope.emit('deaf.run', { tag: 'only' }).catch(() => undefined)
        scope.dispose()
        await running

        expect(scope.inspect()).to.deep.include({ queueDepth: 0, inFlight: ['deaf.run'], live: 0 })

        setTimeout(() => gates.only(), 20)
        await settled(scope)
        expect(finished).to.deep.equal(['only'])
      })
    })
  })
})
