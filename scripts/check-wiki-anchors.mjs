import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wiki = path.join(root, 'wiki')
const anchorPattern = /(?<![\w./-])([\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|md))#([A-Za-z_$][A-Za-z0-9_$]*)/g
const linePattern = /(?<![\w./-])([\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|md)):\d+(?:-\d+)?/g

// Covers declaration syntax used here; use a parser if documented anchors need more shapes.
const declarationPatterns = [
  escaped => `^[ \\t]*(?:export\\s+)?(?:const|let)\\s+${escaped}\\b`,
  escaped => `^[ \\t]*(?:export\\s+)?(?:const|let)\\s*\\{[^{}]*\\b${escaped}\\b[^{}]*\\}\\s*=`,
  escaped =>
    `^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\b(?:<[^>]*>)?\\s*\\(`,
  escaped => `^[ \\t]*(?:export\\s+)?type\\s+${escaped}\\b(?:<[^>]*>)?\\s*=`,
  escaped => `^[ \\t]*(?:export\\s+)?interface\\s+${escaped}\\b(?:<[^>]*>)?`,
  escaped => `^[ \\t]*(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b(?:<[^>]*>)?`,
  escaped => `^[ \\t]*(?:async\\s+)?\\*?\\s*${escaped}\\b\\s*\\([^()]*\\)\\s*\\{`,
  escaped => `^[ \\t]*(?:readonly\\s+)?${escaped}\\b\\??\\s*:(?!:)`,
  escaped => `"${escaped}"\\s*:`,
]

function isDeclared(symbol, source) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return declarationPatterns.some(build => new RegExp(build(escaped), 'm').test(source))
}

// Recursive since the pages moved into `Core/` and `Integration/`: a flat read would have passed
// vacuously on the two pages left at the top level.
const markdown = fs
  .readdirSync(wiki, { recursive: true })
  .filter(file => file.endsWith('.md'))
  .sort()
const failures = []
let anchors = 0

for (const wikiFile of markdown) {
  const wikiPath = path.join(wiki, wikiFile)
  const contents = fs.readFileSync(wikiPath, 'utf8')

  for (const match of contents.matchAll(linePattern)) {
    const line = contents.slice(0, match.index).split('\n').length
    failures.push(`${path.relative(root, wikiPath)}:${line}: legacy line anchor '${match[0]}'`)
  }

  for (const match of contents.matchAll(anchorPattern)) {
    anchors++
    const [, file, symbol] = match
    const line = contents.slice(0, match.index).split('\n').length
    const candidates = [path.join(root, file), path.join(root, 'src', file), path.join(root, 'src/internal', file)]
    const sourcePath = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())

    if (!sourcePath) {
      failures.push(`${path.relative(root, wikiPath)}:${line}: '${match[0]}' names a file that does not exist`)
      continue
    }

    const source = fs.readFileSync(sourcePath, 'utf8')
    if (!isDeclared(symbol, source)) {
      failures.push(
        `${path.relative(root, wikiPath)}:${line}: '${match[0]}' names missing symbol '${symbol}' in ${path.relative(root, sourcePath)}` +
          ` (found no declaration of '${symbol}' — only an occurrence, if any)`,
      )
    }
  }
}

if (anchors === 0) {
  failures.push('wiki anchor check found zero symbol anchors; refusing to pass vacuously')
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`wiki anchor check passed: ${anchors} anchors`)
