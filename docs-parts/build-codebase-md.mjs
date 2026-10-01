// Assembler for codebase.md
// Takes the four curated part files, strips their own H1 + "Table of contents"
// block (the master has one global TOC instead), demotes headings by one level
// so the four parts nest cleanly under Part A-D, and concatenates them under a
// front matter authored by the coordinator.
//
// Usage: node build-codebase-md.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const PARTS = [
  { file: 'part-a-main-process.md', num: 'A', title: 'The Main Process Layer', blurb: 'App entry, the turn pipeline, window factories, the shared contract, and the preload bridge.' },
  { file: 'part-b-services.md', num: 'B', title: 'The Services Layer', blurb: 'All 29 services under `src/main/services/` — the tag DSL, the agent loop, providers, and the JSON stores.' },
  { file: 'part-c-renderer.md', num: 'C', title: 'The Renderer Layer', blurb: 'The three renderer entries, the per-display overlay, the ink geometry, and the settings panel.' },
  { file: 'part-d-toolchain-docs.md', num: 'D', title: 'Toolchain, Tests, Docs and the Marketing Site', blurb: 'Build config, the 40-file verification suite, the preload stubs, the prose docs, and `landing/`.' },
]

/**
 * Drop ONLY the part's "## Table of contents" block, positionally.
 *
 * The naive approach (consume the paragraph after the H1, then look for the TOC)
 * breaks on parts whose front matter has more than one intro paragraph or a `---`
 * rule before the TOC. So instead: locate the TOC heading anywhere in the file,
 * then skip forward to the next heading of rank <= 2. Everything before the TOC
 * (the H1 and its prose) is kept, minus the H1 itself.
 */
function stripFrontMatter(lines) {
  let tocAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+.*(table of contents|\bcontents\b)/i.test(lines[i])) {
      tocAt = i
      break
    }
  }
  if (tocAt === -1) return lines

  let after = tocAt + 1
  while (after < lines.length && !/^#{1,2}\s/.test(lines[after])) after++

  const head = lines.slice(0, tocAt)
  // drop the leading H1 but keep the intro prose that follows it
  const firstHeading = head.findIndex((l) => /^#\s+/.test(l))
  const withoutH1 = firstHeading === -1 ? head : [...head.slice(0, firstHeading), ...head.slice(firstHeading + 1)]

  return [...withoutH1, ...lines.slice(after)]
}

/** Demote every ATX heading by one level, capped at h6. */
function demote(lines) {
  return lines.map((l) => {
    const m = l.match(/^(#{1,5})(\s+)(.*)$/)
    if (!m) return l
    return `${m[1]}#${m[2]}${m[3]}`
  })
}

/** Rewrite "Part A"/"## 1." style numbering so the four parts read as one document. */
function renumber(lines, partNum) {
  return lines.map((l) => {
    // "## 1. something" -> "## A.1 something"
    let m = l.match(/^(#{2,6})\s+(\d+)\.\s+(.*)$/)
    if (m) return `${m[1]} ${partNum}.${m[2]} ${m[3]}`
    // "## 11b. Ground-truth appendix" -> "## A.11b. Ground-truth appendix"
    m = l.match(/^(#{2,6})\s+(\d+[a-z])\.\s+(.*)$/)
    if (m) return `${m[1]} ${partNum}.${m[2]} ${m[3]}`
    // strip a leading "Part A - " / "Part A — " from any heading
    m = l.match(/^(#{2,6})\s+Part\s+[A-D]\s*[-–—:]?\s*(.*)$/i)
    if (m) return `${m[1]} ${m[2]}`
    return l
  })
}

const front = readFileSync(join(here, 'front-matter.md'), 'utf8').replace(/\s+$/, '')

const out = [front, '']
for (const part of PARTS) {
  const raw = readFileSync(join(here, part.file), 'utf8').split(/\r?\n/)
  let body = renumber(demote(stripFrontMatter(raw)), part.num)
  // trim leading/trailing blank lines
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()

  out.push(`---`, '')
  out.push(`## Part ${part.num} — ${part.title}`, '')
  out.push(`*${part.blurb}*`, '')
  out.push(`*Source: [\`docs-parts/${part.file}\`](docs-parts/${part.file}).*`, '')
  out.push(...body, '')
}

const target = join(root, 'codebase.md')
writeFileSync(target, out.join('\n'), 'utf8')

const total = out.join('\n').split('\n').length
console.log(`wrote ${target}`)
console.log(`total lines: ${total}`)
for (const part of PARTS) {
  const n = readFileSync(join(here, part.file), 'utf8').split(/\r?\n/).length
  console.log(`  part ${part.num}: ${n} lines from ${part.file}`)
}
