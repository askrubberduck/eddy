import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Compiles the TypeScript in wiki/*.md, so the code a reader copies is known to build.
//
// Each fence is compiled on its own, prepended with wiki/.fences/prelude.ts, because the pages are
// written as fragments around one running example rather than as programs. Per fence and not per
// page is deliberate: a fence is the unit a reader copies, and a page-wide program would let one
// fence's declarations silently satisfy another's omissions.
//
// A fence that cannot stand alone — an object-literal fragment, two alternatives shown back to
// back, or prose set in a `ts` block — opts out with an HTML comment on the line before it:
//
//   <!-- fence: skip reason -->      not compiled; the reason is required and is printed
//   <!-- fence: expect-error -->     the fence must fail to compile, and is checked that it does
//
// The compiler runs against `src/`, not `output/`, because the wiki documents the library rather
// than a build of it. `check:artifact` is what compiles what a consumer eats.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wiki = path.join(root, 'wiki')
const fencePattern = /(^|\n)```(ts|tsx)\r?\n([\s\S]*?)\r?\n```/g
const directivePattern = /<!--\s*fence:\s*(skip|expect-error)\b([^>]*?)-->\s*$/

const prelude = fs.readFileSync(path.join(root, 'scripts', 'wip', 'fences', 'prelude.ts'), 'utf8')
const preludeLines = prelude.split('\n').length

// Inside the repository, so a generated file resolves `@types/*` by the ordinary walk up to
// node_modules; `paths` resolves the specifier the wiki writes to the source it documents.
const work = path.join(root, 'node_modules', '.cache', 'eddy-wiki-fences')
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

const compilerOptions = {
  noEmit: true,
  strict: true,
  target: 'es2022',
  module: 'esnext',
  moduleResolution: 'bundler',
  jsx: 'react-jsx',
  skipLibCheck: true,
  types: ['node', 'mocha'],
  // Relative to this generated tsconfig, three levels down in node_modules/.cache. TypeScript 7
  // removed `baseUrl`, so the specifier the wiki writes is mapped by hand.
  paths: {
    '@askrubberduck/eddy': ['../../../src/index.ts'],
    '@askrubberduck/eddy/react': ['../../../src/react.ts'],
    '@askrubberduck/eddy/testing': ['../../../src/testing.ts'],
  },
}

const pages = fs
  .readdirSync(wiki, { recursive: true })
  .filter(file => file.endsWith('.md'))
  .sort()
const failures = []
let compiled = 0
let skipped = 0
let expected = 0

for (const page of pages) {
  const source = fs.readFileSync(path.join(wiki, page), 'utf8')
  let index = 0

  for (const match of source.matchAll(fencePattern)) {
    const opensAt = match.index + match[1].length
    const line = source.slice(0, opensAt).split('\n').length
    const directive = directivePattern.exec(source.slice(0, opensAt).trimEnd())
    index += 1

    if (directive?.[1] === 'skip') {
      if (!directive[2].trim()) {
        failures.push(`${page}:${line}: 'fence: skip' needs a reason`)
      }
      skipped += 1
      continue
    }

    // Flattened: a page in `Core/` would otherwise want a directory in the work dir that nothing
    // creates, and the stem only has to be unique.
    const stem = `${page.replace(/\.md$/, '').replace(/[/\\]/g, '-')}-${index}`
    const file = path.join(work, `${stem}.${match[2]}`)
    fs.writeFileSync(file, `${prelude}\n${match[3]}`)

    const project = path.join(work, `${stem}.tsconfig.json`)
    fs.writeFileSync(project, JSON.stringify({ compilerOptions, files: [file] }))

    let output = ''
    let failed = false
    try {
      execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      failed = true
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    }

    if (directive?.[1] === 'expect-error') {
      expected += 1
      if (!failed) {
        failures.push(`${page}:${line}: marked 'fence: expect-error' and it compiles`)
      }
      continue
    }

    if (failed) {
      // Diagnostics are numbered against the generated file; shift them onto the fence's own lines.
      const named = output
        .split('\n')
        .map(entry =>
          entry.replace(/^.*?\((\d+),(\d+)\): /, (whole, row, column) => {
            const within = Number(row) - preludeLines
            return within > 0 ? `${page}:${line + within} (col ${column}): ` : whole
          }),
        )
        .join('\n')
      failures.push(`${page}:${line}: fence does not compile\n${named.replace(/^/gm, '    ')}`)
    }

    compiled += 1
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n\n'))
  console.error(`\nwiki fence check failed: ${failures.length} of ${compiled + skipped} fences`)
  process.exit(1)
}

console.log(
  `wiki fence check passed: ${compiled} fences over ${pages.length} pages` +
    `${expected > 0 ? `, ${expected} expected to fail` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}`,
)
