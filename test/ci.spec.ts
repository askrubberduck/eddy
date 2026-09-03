import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('the internal-reference workflow gates', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
  // The publishing workflow carries its own copy of the identifier scan and can run without CI, so
  // a bound that holds here and not there publishes what this repository refuses to commit.
  const publishing = readFileSync(resolve('.github/workflows/wiki.yml'), 'utf8')

  const commandFor = (pattern: string): string => {
    const found = workflow.split('\n').filter(line => line.includes(pattern) && line.includes('git grep'))
    expect(found, `exactly one git grep line matching ${pattern}`).to.have.lengthOf(1)
    return found[0].trim()
  }

  it('keeps the local-path scan over the sources that ship', () => {
    expect(commandFor('/Users/')).to.match(/-- src README\.md wiki examples; then$/)
  })

  // Three digits, not two: a two-digit bound silently stops covering identifiers once the record
  // passes its ninety-ninth entry. A bound that quietly stops matching is worse than no bound,
  // because the green check reads as coverage.
  it('keeps the finding-identifier scan over every place this repository carries prose', () => {
    expect(commandFor('[0-9]{1,3}')).to.match(/-- src test wiki; then$/)
  })

  it('holds the publishing gate to the same bound, since it can publish without CI', () => {
    const found = publishing.split('\n').filter(line => line.includes('git grep') && line.includes('[A-E]'))
    expect(found, 'exactly one identifier scan in the publishing workflow').to.have.lengthOf(1)
    expect(found[0], 'three digits there too').to.contain('[A-E][0-9]{1,3}')
  })
})

describe('a tag cannot publish without the checks a release needs', () => {
  const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
  const release = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
  const gate = readFileSync(resolve('.github/workflows/release-gate.yml'), 'utf8')
  const usesGate = 'uses: ./.github/workflows/release-gate.yml'

  // release.yml and ci.yml each carrying their own copy of these steps is the shape that lets one
  // copy of a rule go stale while its twin is updated. Both must call the same file rather than
  // duplicate it.
  it('calls the same gate workflow from both the release and CI paths', () => {
    expect(ci).to.contain(usesGate)
    expect(release).to.contain(usesGate)
  })

  // The gate has to run, and the job that builds the tarball has to wait for it, or the tag can
  // still publish while the gate is only running in parallel.
  it('makes the job that builds the tarball wait on the gate', () => {
    expect(release).to.match(/build:\s*\n\s*needs:\s*release-gate\b/)
  })

  it('makes the job that publishes wait on the job that builds the tarball', () => {
    expect(release).to.match(/publish:\s*\n\s*needs:\s*build\b/)
  })

  it('runs the executable example, the artifact compile, and the react 19 suite in the gate', () => {
    expect(gate).to.match(/run:\s*npm run check:example-runs\b/)
    expect(gate).to.match(/run:\s*npm run check:artifact\b/)
    expect(gate).to.match(/react@19/)
  })
})
