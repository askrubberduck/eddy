export type Outcome = 'done' | 'failed'

export type ParsedAddress = {
  domain: string
  action: string
  stage?: Outcome
  base: string
}

const NAME = /[A-Za-z_$][A-Za-z0-9_$]*/
const IDENTIFIER = new RegExp(`^${NAME.source}$`)
const ADDRESS = new RegExp(`^(${NAME.source})\\.(${NAME.source})(?:\\.(done|failed))?$`)

export const isAddressSegment = (name: string): boolean => IDENTIFIER.test(name)

export function parseAddress(address: string): ParsedAddress | undefined {
  const match = ADDRESS.exec(address)
  if (!match) {
    return undefined
  }

  const [, domain, action, stage] = match
  return { domain, action, stage: stage as Outcome | undefined, base: `${domain}.${action}` }
}
