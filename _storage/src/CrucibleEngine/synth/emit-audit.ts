import { readdirSync } from 'fs'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { listSkills, extractFeatures } from './synthEngine'

const SKILLS_DIR = join(process.cwd(), 'src/CrucibleEngine/synth/skills')
const OUT_DIR = '/tmp/crucible-emit-audit'

async function main() {
  // Import every skill file so they self-register via registerSkill()
  const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.ts'))
  for (const file of files) {
    try {
      await import(join(SKILLS_DIR, file))
    } catch (err: any) {
      console.log(`SKIP (failed to load source) ${file}: ${err?.message?.split('\n')[0]}`)
    }
  }

  const skills = listSkills()
  console.log(`\n${skills.length} skills registered. Auditing emit() output for each...\n`)

  mkdirSync(OUT_DIR, { recursive: true })

  let ok = 0
  let failed: { id: string; error: string }[] = []

  for (const skill of skills) {
    try {
      // Use the skill's own summary as the spec — every skill should self-match its own description
      const features = extractFeatures(skill.summary)
      const outFiles = skill.emit(features)

      if (!outFiles || outFiles.length === 0) {
        failed.push({ id: skill.id, error: 'emit() returned no files' })
        continue
      }

      let allImported = true
      let lastErr = ''
      for (let i = 0; i < outFiles.length; i++) {
        const safeName = skill.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + i + '.ts'
        const outPath = join(OUT_DIR, safeName)
        writeFileSync(outPath, outFiles[i].content)
        try {
          await import(outPath + '?t=' + Date.now())
        } catch (err: any) {
          allImported = false
          lastErr = err?.message?.split('\n')[0] ?? String(err)
        }
      }

      if (allImported) {
        ok++
      } else {
        failed.push({ id: skill.id, error: lastErr })
      }
    } catch (err: any) {
      failed.push({ id: skill.id, error: 'emit() threw: ' + (err?.message?.split('\n')[0] ?? String(err)) })
    }
  }

  console.log(`=== EMIT AUDIT COMPLETE ===`)
  console.log(`Total skills: ${skills.length}`)
  console.log(`Emitted code imports cleanly: ${ok}`)
  console.log(`Emitted code fails to import: ${failed.length}`)

  if (failed.length > 0) {
    console.log(`\n--- FAILING SKILLS ---`)
    for (const f of failed) {
      console.log(`  ${f.id}`)
      console.log(`    -> ${f.error}`)
    }
  } else {
    console.log(`\nEvery skill's emitted code is at least syntactically valid and loadable.`)
  }
}

main()
