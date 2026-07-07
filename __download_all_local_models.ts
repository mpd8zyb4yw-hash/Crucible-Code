import { LOCAL_MODEL_CATALOG } from './src/CrucibleEngine/agent/localModelCatalog'
import { downloadModel } from './src/CrucibleEngine/agent/modelDownloadManager'

async function main() {
  for (const spec of LOCAL_MODEL_CATALOG) {
    process.stdout.write(`\n== ${spec.id} (${spec.approxSizeGB}GB) ==\n`)
    let lastPct = -1
    try {
      await downloadModel(spec.id, s => {
        if (s.bytesTotal) {
          const pct = Math.round((s.bytesDone / s.bytesTotal) * 100)
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct
            process.stdout.write(`  ${pct}%\n`)
          }
        }
      })
      console.log(`  DONE: ${spec.id}`)
    } catch (err: any) {
      console.log(`  FAILED: ${spec.id}: ${err?.message ?? err}`)
    }
  }
}

main()
