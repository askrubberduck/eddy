import { expect } from 'chai'
import { defineDomain } from '../../src/index'
import type { DomainName } from '../../src/index'

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Assert<T extends true> = T

const emptyRegistryMessage =
  "ERROR: no domain is registered. Augment the registry: declare module '@askrubberduck/eddy' { interface Domains { cart: DomainType<CartState, CartActions, CartViews> } }" as const

type MessageIsWhatTheCompilerPrints = Assert<Equal<DomainName, typeof emptyRegistryMessage>>

// @ts-expect-error an unaugmented `DomainName` is the diagnostic message, no longer `never`
type NoLongerNever = Assert<Equal<DomainName, never>>

// @ts-expect-error the fallback is one literal, not the whole of `string`
type NotWidened = Assert<Equal<DomainName, string>>

// @ts-expect-error 'cart' is not assignable to the empty-registry message
defineDomain('cart', [], { state: {}, actions: {} })

export type Checked = [MessageIsWhatTheCompilerPrints, NoLongerNever, NotWidened]

describe('the empty registry', () => {
  it('says what to do about itself', () => {
    expect(emptyRegistryMessage).to.match(/^ERROR: no domain is registered\. Augment the registry:/)
  })
})
