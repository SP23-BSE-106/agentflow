import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `tsc` does not rewrite the `@/` path alias the app uses (tsconfig
 * `paths`), so the compiled team test output would fail with
 * MODULE_NOT_FOUND on every `@/lib/...` import. This step rewrites those
 * requires in the compiled files under tests/team/out to relative paths.
 * Source files are never touched. (Same pattern as tests/phase0.)
 */
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'out')

function* jsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* jsFiles(full)
    else if (entry.name.endsWith('.js')) yield full
  }
}

let rewritten = 0
for (const file of jsFiles(outDir)) {
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(/require\("@\/([^"]+)"\)/g, (_match, spec) => {
    const target = path.join(outDir, 'src', `${spec}.js`)
    let rel = path.relative(path.dirname(file), target)
    if (!rel.startsWith('.')) rel = `./${rel}`
    rewritten += 1
    return `require("${rel}")`
  })
  if (next !== text) fs.writeFileSync(file, next)
}

console.log(`Rewrote ${rewritten} @/ require(s) in compiled team test output.`)
