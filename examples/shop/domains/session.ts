import { cmd, defineDomain, reduce } from '../../../src/index'
import type { Cmd, DomainType, Reduce } from '../../../src/index'
import { api } from '../api'

export type SessionState = {
  userId: string | null
  email: string | null
  signingIn: boolean
}

export type SessionActions = {
  signIn: Cmd<{ email: string }, { id: string }>
  signOut: Reduce
}

declare module '../../../src/types' {
  interface Domains {
    session: DomainType<SessionState, SessionActions>
  }
}

export const session = defineDomain('session', [], {
  state: () => ({ userId: null, email: null, signingIn: false }),

  actions: {
    signIn: cmd(async input => api.authenticate(input.email), {
      called: { signingIn: true },

      done: (_state, action) => ({ userId: action.result.id, email: action.input.email }),
      finally: { signingIn: false },
    }),

    signOut: reduce({ userId: null, email: null }),
  },
})
