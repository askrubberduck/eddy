import { expect } from 'chai'
import { computed, effect, signal } from '@preact/signals-core'
import { createScope } from '../src/index'
import type { DomainName, Scope } from '../src/index'
import { session, upload } from './fixtures'

// The adapter wiki/Signals.md opens with. No equality check of its own: `read` answers the same
// reference for a domain no fold moved, and a signal ignores a write of the value it holds.
function domainSignal<TNames extends DomainName, D extends TNames>(scope: Scope<TNames>, domain: D) {
  const read = () => scope.read<D>(domain as never)
  const latest = signal(read())
  const stop = scope.subscribe(() => {
    latest.value = read()
  })
  return { state: computed(() => latest.value), stop }
}

describe('a signal over scope.read and scope.subscribe', () => {
  it('follows the domain it reads, and stays still when another domain moves', async () => {
    const scope = createScope({ name: 'signals', domains: [session, upload] })
    const files = domainSignal(scope, 'upload')
    const runs: number[] = []
    const dispose = effect(() => {
      runs.push(files.state.value.files)
    })

    await scope.emit('upload.pick', { count: 2 })
    expect(files.state.value.files).to.equal(2)
    expect(runs).to.deep.equal([0, 2])

    await scope.emit('session.signIn', { email: 'a@b.c' })
    expect(runs).to.deep.equal([0, 2])

    files.stop()
    await scope.emit('upload.pick', { count: 1 })
    expect(runs).to.deep.equal([0, 2])

    dispose()
    scope.dispose()
  })
})
