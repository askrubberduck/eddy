const latency = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class OutOfStock extends Error {
  constructor(public readonly sku: string) {
    super(`'${sku}' is out of stock`)
    this.name = 'OutOfStock'
  }
}

export type Reservation = { sku: string; qty: number; unitPrice: number }

export const apiCalls: string[] = []

const stock: Record<string, number> = {
  'mug-white': 40,
  'mug-black': 12,
  'lamp-noir': 0,
  'rug-jute': 3,
}

const coupons: Record<string, number> = {
  SLOW10: 10,
  FAST20: 20,
}

export const api = {
  async reserve(sku: string, qty: number, unitPrice: number, signal: AbortSignal): Promise<Reservation> {
    apiCalls.push(`reserve ${sku} x${qty}`)
    await latency(25)

    if (signal.aborted) {
      throw signal.reason
    }

    if ((stock[sku] ?? 0) < qty) {
      throw new OutOfStock(sku)
    }

    return { sku, qty, unitPrice }
  },

  async placeOrder(totalPence: number, signal: AbortSignal): Promise<{ id: string }> {
    apiCalls.push(`placeOrder ${totalPence}`)
    await latency(30)

    if (signal.aborted) {
      throw signal.reason
    }

    return { id: `ord-${(orderCounter += 1).toString().padStart(3, '0')}` }
  },

  async validateCoupon(code: string, signal: AbortSignal): Promise<{ code: string; percent: number }> {
    apiCalls.push(`validateCoupon ${code}`)
    await latency(40)

    if (signal.aborted) {
      throw signal.reason
    }

    const percent = coupons[code]
    if (percent === undefined) {
      throw new Error(`Unknown coupon '${code}'`)
    }

    return { code, percent }
  },

  async authenticate(email: string): Promise<{ id: string }> {
    apiCalls.push(`authenticate ${email}`)
    await latency(15)
    return { id: `usr-${email.split('@')[0]}` }
  },

  reset(): void {
    apiCalls.length = 0
    orderCounter = 0
  },
}

let orderCounter = 0
