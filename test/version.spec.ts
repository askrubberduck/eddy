import { expect } from 'chai'
import { cmd, createScope, defineDomain } from '../src/index'
import { settled } from '../src/testing'
import { buildModeProbe } from './helpers'

type VersionModule = typeof import('../src/internal/version')

function freshInstance(): VersionModule {
  const modulePath = require.resolve('../src/internal/version')
  delete require.cache[modulePath]
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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
      expect(message, 'and names the address, which needed the inFlight fix').to.contain('stuck.wait')
      scope.dispose()
    })
  })
})
