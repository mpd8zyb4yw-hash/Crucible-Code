import fs from 'fs'
import path from 'path'

const INDEX_FILE = path.join(process.cwd(), '.crucible-index.json')

const INDEXABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.md']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])
const MAX_FILE_BYTES = 50_000

export interface IndexedFile {
  filePath: string
  relativePath: string
  content: string
  tokens: string[]
}

export interface CodebaseIndex {
  rootPath: string
  indexedAt: number
  files: IndexedFile[]
}

let activeIndex: CodebaseIndex | null = null

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length > 2)
}

function walkDir(dir: string, root: string, results: IndexedFile[]) {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDir(fullPath, root, results)
    } else if (entry.isFile() && INDEXABLE_EXTENSIONS.includes(path.extname(entry.name))) {
      try {
        const stat = fs.statSync(fullPath)
        if (stat.size > MAX_FILE_BYTES) continue
        const content = fs.readFileSync(fullPath, 'utf-8')
        results.push({
          filePath: fullPath,
          relativePath: path.relative(root, fullPath),
          content,
          tokens: tokenize(content),
        })
      } catch { /* skip unreadable files */ }
    }
  }
}

export function buildIndex(rootPath: string): CodebaseIndex {
  const files: IndexedFile[] = []
  walkDir(rootPath, rootPath, files)
  const index: CodebaseIndex = { rootPath, indexedAt: Date.now(), files }
  activeIndex = index
  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    rootPath,
    indexedAt: index.indexedAt,
    files: files.map(f => ({ filePath: f.filePath, relativePath: f.relativePath, tokens: f.tokens, content: f.content.slice(0, 500) }))
  }))
  console.log(`[RAG] Indexed ${files.length} files in ${rootPath}`)
  return index
}

export function loadIndex(): CodebaseIndex | null {
  if (activeIndex) return activeIndex
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'))
      activeIndex = raw
      return raw
    }
  } catch { /* ignore */ }
  return null
}

export function queryIndex(prompt: string, topK = 3): string {
  const index = loadIndex()
  if (!index || index.files.length === 0) return ''
  const queryTokens = new Set(
    prompt.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 2)
  )
  const scored = index.files.map(f => {
    const overlap = f.tokens.filter(t => queryTokens.has(t)).length
    const score = overlap / (Math.sqrt(f.tokens.length) + 1)
    return { f, score }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK)

  if (scored.length === 0) return ''

  return scored.map(({ f }) =>
    `// File: ${f.relativePath}\n${f.content.slice(0, 800)}`
  ).join('\n\n')
}

export function getIndexStats(): { fileCount: number; rootPath: string; indexedAt: number } | null {
  const index = loadIndex()
  if (!index) return null
  return { fileCount: index.files.length, rootPath: index.rootPath, indexedAt: index.indexedAt }
}
