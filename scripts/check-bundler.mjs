// The published package has to survive metro 0.72, which React Native applications still ship. Two things break
// there and neither is visible to `tsc`, so neither was caught until a real bundle was run:
//
//   1. metro 0.72's minifier is a JS parser older than ES2021. `??=` and numeric separators survive
//      an ES2022 emit untouched, so the release bundle failed on `output/internal/version.js` and
//      `output/scope.js` — the *core* entry point, not just the React subpath. The target stays
//      ES2022 by decision, so the fix is at the source and this check is what keeps it there.
//   2. That metro predates `package.json#exports`, so every subpath needs a file at the package root
//      to resolve to.
//
// Deliberately a scan of the emitted output rather than of `src/`: what ships is what matters, and a
// future compiler option could reintroduce either syntax without the source changing.

import { readFileSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

// Both are matched with the string boundaries that make a false positive unlikely: `??=` is not
// valid anywhere else, and a separator is only a separator between two digits.
const SYNTAX = [
  { name: 'a logical assignment (`??=`, `||=`, `&&=`)', pattern: /(\?\?|\|\||&&)=/ },
  { name: 'a numeric separator (`10_000`)', pattern: /\b\d[\d_]*_\d/ },
]

// Comments and string bodies are removed before the scan, because a tokenizer skips both and this
// check has to see what metro's parser sees. Without it the check fires on its own explanatory
// comments — it did, which is how this function came to exist. Known ceiling: a regex literal
// containing a quote or `//` would confuse it. None exists in this output, and the failure direction
// is a false positive that a human reads, not a silent pass.
const strip = source => {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const skipped = end === -1 ? source.slice(i) : source.slice(i, end + 2)
      // Keep the newlines so reported line numbers still point at the real line.
      out += skipped.replace(/[^\n]/g, ' ')
      i = end === -1 ? source.length : end + 2
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i]
      out += quote
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        else if (source[i] === '\n') out += '\n'
        i += 1
      }
      out += quote
      i += 1
    } else {
      out += source[i]
      i += 1
    }
  }
  return out
}

const walk = async dir => {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(path)))
    else if (entry.name.endsWith('.js')) found.push(path)
  }
  return found
}

const output = join(root, 'output')
if (!existsSync(output)) {
  console.error('bundler check: no output/ — run `npm run build` first')
  process.exit(2)
}

for (const file of await walk(output)) {
  const lines = strip(readFileSync(file, 'utf8')).split('\n')
  for (const [index, line] of lines.entries()) {
    for (const { name, pattern } of SYNTAX) {
      if (pattern.test(line)) {
        failures.push(`${file.slice(root.length + 1)}:${index + 1} emits ${name}, which metro 0.72 cannot parse`)
      }
    }
  }
}

// Every subpath in `exports` needs a root file, or a resolver that predates `exports` cannot reach it.
const { exports: declared } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const subpath of Object.keys(declared)) {
  if (subpath === '.' || subpath === './package.json') continue
  const name = subpath.slice(2)
  for (const extension of ['.js', '.d.ts']) {
    if (!existsSync(join(root, name + extension))) {
      failures.push(`'${subpath}' is in package.json#exports with no root '${name}${extension}' to fall back to`)
    }
  }
}

if (failures.length > 0) {
  console.error(`bundler check failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('bundler check passed: output parses under metro 0.72, and every subpath has a root fallback')
