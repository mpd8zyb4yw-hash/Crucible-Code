// One-shot migration — re-embed every corpus chunk with the real ONNX semantic
// embedder (all-MiniLM-L6-v2, 384-dim). The corpus was originally embedded with the
// 256-dim hash fallback (semantically meaningless — "entropy" matched "networking"),
// which made the corpus-first answer gate (Track O Layer 1) untrustworthy. Run once
// after installing @xenova/transformers:  npx tsx src/CrucibleEngine/corpus/reembed.ts
//
// Idempotent: re-running simply recomputes embeddings. Safe to re-run after ingest.

import { embed } from '../masterpiece/corpus/embed.js'
import { getCorpusDb } from './db.js'

async function main() {
  const db = getCorpusDb()
  const rows = db.prepare(`SELECT id, content FROM chunks`).all() as Array<{ id: string; content: string }>
  console.log(`[reembed] ${rows.length} chunks to re-embed with ONNX (384-dim)…`)

  const update = db.prepare(`UPDATE chunks SET embedding = ? WHERE id = ?`)
  let done = 0, failed = 0
  for (const row of rows) {
    try {
      const vec = await embed(row.content)
      if (vec.length !== 384) { failed++; continue }  // ONNX unavailable → don't poison with hash
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
      update.run(buf, row.id)
      done++
      if (done % 200 === 0) console.log(`[reembed]   ${done}/${rows.length}…`)
    } catch (e: any) {
      failed++
      if (failed <= 3) console.warn(`[reembed]   failed ${row.id}: ${e?.message?.slice(0, 80)}`)
    }
  }
  console.log(`[reembed] done: ${done} re-embedded, ${failed} failed.`)
  if (failed > 0 && done === 0) {
    console.error('[reembed] ALL failed — ONNX embedder unavailable. Install @xenova/transformers and retry.')
    process.exit(1)
  }
  process.exit(0)
}

main()
