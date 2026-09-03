import { expect } from 'chai'
import { isAddressSegment, parseAddress } from '../src/internal/address'

describe('parseAddress', () => {
  describe('valid shapes', () => {
    it('a pure two-segment address, with no stage', () => {
      expect(parseAddress('cart.add')).to.deep.equal({
        domain: 'cart',
        action: 'add',
        stage: undefined,
        base: 'cart.add',
      })
    })

    it('the done outcome', () => {
      expect(parseAddress('cart.add.done')).to.deep.equal({
        domain: 'cart',
        action: 'add',
        stage: 'done',
        base: 'cart.add',
      })
    })

    it('the failed outcome', () => {
      expect(parseAddress('cart.add.failed')).to.deep.equal({
        domain: 'cart',
        action: 'add',
        stage: 'failed',
        base: 'cart.add',
      })
    })

    it('every character class a name may carry: letters, digits, underscore and dollar', () => {
      expect(parseAddress('Cart_1.$add2')).to.deep.equal({
        domain: 'Cart_1',
        action: '$add2',
        stage: undefined,
        base: 'Cart_1.$add2',
      })
    })

    it('a name starting with underscore or dollar, which digits may not', () => {
      expect(parseAddress('_cart.$action')).to.deep.equal({
        domain: '_cart',
        action: '$action',
        stage: undefined,
        base: '_cart.$action',
      })
    })
  })

  describe('no other stage suffix exists', () => {
    it('a third segment that is not done or failed is not a stage — the whole address is refused', () => {
      expect(parseAddress('cart.add.pending')).to.be.undefined
    })

    it('a fourth segment past a real stage is refused the same way', () => {
      expect(parseAddress('cart.add.done.extra')).to.be.undefined
    })

    it('the stage literal is case-sensitive', () => {
      expect(parseAddress('cart.add.Done')).to.be.undefined
      expect(parseAddress('cart.add.FAILED')).to.be.undefined
    })
  })

  describe('what the grammar refuses', () => {
    it('the empty string', () => {
      expect(parseAddress('')).to.be.undefined
    })

    it('an empty domain segment (leading dot)', () => {
      expect(parseAddress('.add')).to.be.undefined
    })

    it('an empty action segment (trailing dot)', () => {
      expect(parseAddress('cart.')).to.be.undefined
    })

    it('a double dot, wherever it falls', () => {
      expect(parseAddress('cart..add')).to.be.undefined
      expect(parseAddress('cart.add..done')).to.be.undefined
    })

    it('a single segment with no dot at all', () => {
      expect(parseAddress('cart')).to.be.undefined
    })

    it('whitespace inside or around a segment', () => {
      expect(parseAddress('cart .add')).to.be.undefined
      expect(parseAddress('cart. add')).to.be.undefined
      expect(parseAddress(' cart.add')).to.be.undefined
      expect(parseAddress('cart.add ')).to.be.undefined
      expect(parseAddress('cart.add\n')).to.be.undefined
    })

    it('a segment starting with a digit, though digits are welcome afterwards', () => {
      expect(parseAddress('1cart.add')).to.be.undefined
      expect(parseAddress('cart.1add')).to.be.undefined
    })

    it('a character outside the identifier class, such as a hyphen', () => {
      expect(parseAddress('ca-rt.add')).to.be.undefined
    })
  })

  describe('prototype-pollution-shaped names', () => {
    it('accepts __proto__, constructor, prototype and toString as a domain segment', () => {
      expect(parseAddress('__proto__.add')).to.deep.equal({
        domain: '__proto__',
        action: 'add',
        stage: undefined,
        base: '__proto__.add',
      })
      expect(parseAddress('constructor.add')).to.deep.equal({
        domain: 'constructor',
        action: 'add',
        stage: undefined,
        base: 'constructor.add',
      })
      expect(parseAddress('prototype.add')).to.deep.equal({
        domain: 'prototype',
        action: 'add',
        stage: undefined,
        base: 'prototype.add',
      })
      expect(parseAddress('toString.add')).to.deep.equal({
        domain: 'toString',
        action: 'add',
        stage: undefined,
        base: 'toString.add',
      })
    })

    it('accepts the same names as an action segment, done/failed included', () => {
      expect(parseAddress('cart.__proto__')).to.deep.equal({
        domain: 'cart',
        action: '__proto__',
        stage: undefined,
        base: 'cart.__proto__',
      })
      expect(parseAddress('cart.constructor.done')).to.deep.equal({
        domain: 'cart',
        action: 'constructor',
        stage: 'done',
        base: 'cart.constructor',
      })
      expect(parseAddress('cart.prototype.failed')).to.deep.equal({
        domain: 'cart',
        action: 'prototype',
        stage: 'failed',
        base: 'cart.prototype',
      })
    })

    it('a name that is entirely __proto__ still composes into base the same as any other pair', () => {
      const parsed = parseAddress('__proto__.__proto__')
      expect(parsed).to.deep.equal({
        domain: '__proto__',
        action: '__proto__',
        stage: undefined,
        base: '__proto__.__proto__',
      })

      expect(Object.getPrototypeOf({})).to.not.equal(parsed)
    })
  })
})

describe('isAddressSegment', () => {
  it('accepts a plain identifier', () => {
    expect(isAddressSegment('cart')).to.equal(true)
    expect(isAddressSegment('_a$1')).to.equal(true)
  })

  it('refuses what IDENTIFIER refuses: empty, dotted, or carrying a foreign character', () => {
    expect(isAddressSegment('')).to.equal(false)
    expect(isAddressSegment('we.ird')).to.equal(false)
    expect(isAddressSegment('ca-rt')).to.equal(false)
    expect(isAddressSegment('1cart')).to.equal(false)
  })

  it('accepts __proto__ and constructor as segments — the same syntactic blindness parseAddress has', () => {
    expect(isAddressSegment('__proto__')).to.equal(true)
    expect(isAddressSegment('constructor')).to.equal(true)
  })
})
