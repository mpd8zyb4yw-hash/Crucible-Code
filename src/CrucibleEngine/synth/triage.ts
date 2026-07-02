import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SKILLS_DIR = join(process.cwd(), 'src/CrucibleEngine/synth/skills')

interface Result {
  file: string
  fixedBadImport: boolean
  importError: string | null
}

function findBadEngineImport(content: string): boolean {
  return /from\s+['"]\.\.\/engine['"]/.test(content)
}

function fixBadEngineImport(content: string): string {
  return content.replace(/from\s+(['"])\.\.\/engine\1/g, "from '../synthEngine'")
}

async function main() {
  const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.ts'))
  console.log(`Found ${files.length} skill files. Triaging...\n`)

  const results: Result[] = []

  // Pass 1: fix the known bad import pattern across every file
  for (const file of files) {
    const fullPath = join(SKILLS_DIR, file)
    const content = readFileSync(fullPath, 'utf-8')
    const bad = findBadEngineImport(content)
    if (bad) {
      writeFileSync(fullPath, fixBadEngineImport(content))
      console.log(`FIXED bad import: ${file}`)
    }
    results.push({ file, fixedBadImport: bad, importError: null })
  }

  console.log(`\nPass 1 complete. Fixed ${results.filter(r => r.fixedBadImport).length} files with the known bad import.\n`)
  console.log('Pass 2: attempting to actually import every skill file to catch other errors...\n')

  // Pass 2: try to dynamically import every file and catch any remaining errors
  for (const r of results) {
    const fullPath = join(SKILLS_DIR, r.file)
    try {
      await import(fullPath + '?t=' + Date.now())
    } catch (err: any) {
      r.importError = err?.message?.split('\n')[0] ?? String(err)
    }
  }

  const broken = results.filter(r => r.importError !== null)
  const clean = results.filter(r => r.importError === null)

  console.log(`\n=== TRIAGE COMPLETE ===`)
  console.log(`Total skill files: ${results.length}`)
  console.log(`Clean (import successfully): ${clean.length}`)
  console.log(`Broken (still error on import): ${broken.length}`)
  console.log(`Auto-fixed this run: ${results.filter(r => r.fixedBadImport).length}`)

  if (broken.length > 0) {
    console.log(`\n--- BROKEN FILES (need manual review) ---`)
    for (const r of broken) {
      console.log(`  ${r.file}`)
      console.log(`    -> ${r.importError}`)
    }
  } else {
    console.log(`\nAll skill files import cleanly.`)
  }
}

main()
