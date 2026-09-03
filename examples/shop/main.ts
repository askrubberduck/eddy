import assert from 'node:assert/strict'
import { CommandAborted, createScope } from '../../src/index'
import type { DispatchedAction, Scope } from '../../src/index'
import { createTestScope } from '../../src/testing'
import { api, apiCalls, OutOfStock } from './api'
import { analytics, events } from './domains/analytics'
import { cart, watchLog } from './domains/cart'
import { catalog } from './domains/catalog'
import { session } from './domains/session'

type ShopScope = Scope<'catalog' | 'session' | 'cart' | 'analytics'>

const pass = (contract: string): void => console.log(`✓ ${contract}`)

async function main(): Promise<void> {
  api.reset()
  events.length = 0
  watchLog.length = 0

  const actions: string[] = []
  const scope: ShopScope = createScope({
    name: 'shop',
    domains: [catalog, session, cart, analytics],
    onAction: (action: DispatchedAction) => actions.push(action.type),
  })

  let notifications = 0
  const unsubscribe = scope.subscribe(() => {
    notifications += 1
  })

  const orders: string[] = []
  const stopOrders = scope.on('cart.checkout.done', action => {
    orders.push(action.result)
  })

  assert.equal(scope.read('catalog').products.length, 4)
  assert.equal(scope.read('catalog').cheapestVisible?.sku, 'mug-white')
  assert.equal(scope.read('cart').total, 0)
  pass('views exist at scope construction')

  await scope.emit('catalog.setQuery', { text: 'mug' })
  await scope.emit('catalog.select', { sku: 'mug-black' })

  assert.deepEqual(
    scope.read('catalog').visible.map(product => product.sku),
    ['mug-white', 'mug-black'],
  )
  assert.equal(scope.read('catalog').selected?.sku, 'mug-black')
  assert(events.includes('selected mug-black'))
  pass('pure actions fold and dependent views resolve')

  const signingIn = scope.emit('session.signIn', { email: 'ada@example.com' })
  assert.equal(scope.read('session').signingIn, true)
  assert.deepEqual(await signingIn, { id: 'usr-ada' })
  assert.equal(scope.read('session').signingIn, false)
  pass('called, done, and finally stages compose')

  const adding = scope.emit('cart.add', { sku: 'mug-white', qty: 2 })
  assert.equal(scope.read('cart').pending, true)
  assert.equal((await adding).sku, 'mug-white')

  const added = scope.read('cart')
  assert.equal(added.itemCount, 2)
  assert.equal(added.subtotal, 1800)
  assert.equal(added.shipping, 495)
  assert.equal(added.total, 2295)
  assert(watchLog.includes('cart empty: true -> false'))
  assert.deepEqual(actions.slice(-2), ['cart.add', 'cart.add.done'])
  pass('commands publish outcomes, views, effects, and watchers')

  const beforeNoOp = scope.read('cart')
  const beforeNoOpNotifications = notifications
  await scope.emit('cart.remove', { sku: 'not-in-cart' })
  assert.equal(scope.read('cart'), beforeNoOp)
  assert.equal(notifications, beforeNoOpNotifications)
  assert.equal(actions.at(-1), 'cart.remove')
  pass('deep-equal reducer output is a recorded no-op')

  await assert.rejects(scope.emit('cart.add', { sku: 'lamp-noir', qty: 1 }), OutOfStock)
  assert.match(scope.read('cart').lastError ?? '', /out of stock/)
  assert.deepEqual(actions.slice(-2), ['cart.add', 'cart.add.failed'])
  assert(events.some(event => event.includes("add 'lamp-noir' failed")))
  pass('failed commands fold failure state and reject the caller')

  await scope.emit('catalog.reprice', { sku: 'mug-white', price: 1500 })
  assert.equal(scope.read('cart').subtotal, 3000)
  assert.equal(scope.read('cart').total, 3495)
  pass('one action folds transactionally across domains')

  const slow = scope.emit('cart.applyCoupon', { code: 'SLOW10' })
  const fast = scope.emit('cart.applyCoupon', { code: 'FAST20' })
  const [firstCoupon, secondCoupon] = await Promise.allSettled([slow, fast])

  assert(firstCoupon.status === 'rejected' && firstCoupon.reason instanceof CommandAborted)
  assert(secondCoupon.status === 'fulfilled' && secondCoupon.value.percent === 20)
  assert.equal(scope.read('cart').coupon?.code, 'FAST20')
  assert(apiCalls.includes('validateCoupon SLOW10'))
  assert(apiCalls.includes('validateCoupon FAST20'))
  pass('latest cancels the old promise and suppresses its outcome')

  const orderId = await scope.emit('cart.checkout')
  assert.equal(orderId, 'ord-001')
  assert.deepEqual(orders, ['ord-001'])
  assert.equal(scope.read('cart').itemCount, 0)
  assert.equal(scope.read('cart').orderId, 'ord-001')
  assert(watchLog.includes('cart empty: false -> true'))
  pass('post-fold listeners observe committed command outcomes')

  await scope.emit('cart.add', { sku: 'rug-jute', qty: 1 })
  await scope.emit('session.signOut')
  assert.equal(scope.read('session').userId, null)
  assert.equal(scope.read('cart').itemCount, 0)
  assert.equal(scope.read('cart').orderId, null)
  pass('neighbour actions update each domain without imports')

  const beforeOtherEffects = events.length
  const other = createTestScope({
    name: 'shop-preview',
    domains: [catalog, session, cart, analytics],
  })

  await other.emit('session.signIn', { email: 'grace@example.com' })
  await other.emit('cart.add', { sku: 'mug-black', qty: 1 })

  assert.equal(scope.read('catalog').products.find(product => product.sku === 'mug-white')?.price, 1500)
  assert.equal(other.read('catalog').products.find(product => product.sku === 'mug-white')?.price, 900)
  assert.notEqual(scope.read('catalog').products, other.read('catalog').products)
  assert.deepEqual(other.actionTypes(), ['session.signIn', 'session.signIn.done', 'cart.add', 'cart.add.done'])
  assert(events.length > beforeOtherEffects)
  pass('scope state is isolated; module-level effect output is not')

  const cancelledByDisposal = scope.emit('cart.applyCoupon', { code: 'SLOW10' })
  const readableAfterDisposal = scope.read('cart')

  unsubscribe()
  stopOrders()
  scope.dispose()
  other.dispose()

  await assert.rejects(cancelledByDisposal, /scope 'shop' was disposed/)
  await assert.rejects(scope.emit('cart.clear'), /scope 'shop' has been disposed/)
  assert.equal(scope.read('cart'), readableAfterDisposal)
  pass('dispose settles work, clears reactions, and preserves reads')

  console.log(`\n${actions.length} actions checked. Duck found no reason to narrate them twice.`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
