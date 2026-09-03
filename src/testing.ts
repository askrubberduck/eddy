import { resetVersion } from './internal/version'
import type { DomainDef } from './domain'
import { createScope, type Scope } from './scope'
import type { DispatchedAction, DomainName, Settings } from './types'

export { resetVersion }

export type TestScope<TNames extends DomainName> = Scope<TNames> & {
  actions: () => DispatchedAction[]
  actionTypes: () => string[]
  clearActions: () => void
}

let counter = 0

export function createTestScope<const TDefs extends readonly DomainDef[]>(
  options: {
    name?: string
    domains: TDefs

    onAction?: (action: DispatchedAction) => void
  } & Partial<Settings>,
): TestScope<TDefs[number]['name'] & DomainName> {
  const recorded: DispatchedAction[] = []
  const observer = options.onAction

  const scope = createScope({
    ...options,
    name: options.name ?? `test-${++counter}`,
    domains: options.domains,
    onAction: action => {
      recorded.push(action)

      return observer?.(action)
    },
  })

  return Object.assign(scope, {
    actions: () => [...recorded],
    actionTypes: () => recorded.map(action => action.type),
    clearActions: () => {
      recorded.length = 0
    },
  })
}

/**
 * Waits until the scope has nothing queued and no command handler outstanding, by asking the scope
 * rather than guessing host turns. Async effects are detached and untracked — use `flush` for those.
 * Throws rather than hanging, naming what was outstanding.
 */
export async function settled(
  scope: { name: string; inspect: () => { queueDepth: number; inFlight: string[]; live: number } },
  options: { timeout?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 1000)

  for (;;) {
    const report = scope.inspect()
    if (report.queueDepth === 0 && report.live === 0) {
      return
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Scope '${scope.name}' did not settle: ${report.queueDepth} queued, ` +
          `${report.live} in flight${report.inFlight.length > 0 ? ` (${report.inFlight.join(', ')})` : ''}`,
      )
    }

    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/**
 * Yields to the host a few times. Use it for work the scope does not track — an async effect, a
 * handler's own timer — and `settled` for the scope's own queue and commands.
 */
export const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
