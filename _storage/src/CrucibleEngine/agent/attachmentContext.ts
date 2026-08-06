// ── Attachment contextual awareness (cont.66k) ──
//
// The composer's paperclip uploads files into the workspace sandbox and the client folds a
// note like "[User attached 2 file(s) to the workspace sandbox: a.txt, photo.png. Read them
// from the sandbox if relevant to this request.]" into the message. Before this module,
// NOTHING on the chat path ever read those files — the model saw only the paths, so an
// attachment was pure theater. foldAttachmentContext() parses that note, reads each file
// from the sandbox and appends real content the on-device brain can act on:
//
//   text-ish files  → inlined verbatim (capped per file and in total — 3B-class context)
//   images          → on-device Apple Vision OCR (swift shell-out, zero model, zero cloud)
//                     plus pixel dimensions; the extracted text is what the FM reasons over
//   other binaries  → name + size, honestly declared unreadable
//
// Doctrine: same shape as whisper.cpp STT — capability comes from deterministic on-device
// tooling the weak model orchestrates, never from "needs a bigger model".

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.toml', '.ini',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h',
  '.cpp', '.hpp', '.swift', '.sh', '.zsh', '.bash', '.sql', '.html', '.css', '.svg', '.log', '.env',
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp'])

const PER_FILE_CAP = 24_000      // chars of inlined text per file
const TOTAL_CAP = 48_000         // chars across all attachments — keep the 3B context sane

// The note the composer folds into the message on send (see App.tsx attachNote).
const NOTE_RE = /\[User attached \d+ file\(s\) to the workspace sandbox: ([^\]]+?)\. Read them from the sandbox if relevant to this request\.\]/

/** Extract sandbox-relative attachment paths from the message note, if present. */
export function parseAttachmentNote(message: string): string[] {
  const m = message.match(NOTE_RE)
  if (!m) return []
  return m[1].split(',').map(s => s.trim()).filter(Boolean).slice(0, 8)
}

function run(bin: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(0, 200))) : resolve(stdout))
  })
}

// Apple Vision OCR — compiled once per process to a cached binary would be nicer, but `swift`
// script mode is fast enough for an attach (~1-2 s) and keeps this dependency-free. Falls
// back to empty text when the toolchain is unavailable (fail-open: the image is still
// described by name/dimensions).
const OCR_SWIFT = `
import Vision
import AppKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
for o in (req.results ?? []) { if let c = o.topCandidates(1).first { print(c.string) } }
`

let ocrScriptPath: string | null = null
async function ocrImage(absPath: string): Promise<string> {
  if (process.platform !== 'darwin') return ''
  try {
    if (!ocrScriptPath) {
      ocrScriptPath = path.join(os.tmpdir(), `crucible-ocr-${process.pid}.swift`)
      fs.writeFileSync(ocrScriptPath, OCR_SWIFT)
    }
    return (await run('swift', [ocrScriptPath, absPath], 30000)).trim()
  } catch { return '' }
}

/** Image pixel dimensions via sips (ships with macOS). Empty string off-platform/failure. */
async function imageDims(absPath: string): Promise<string> {
  try {
    const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', absPath], 8000)
    const w = out.match(/pixelWidth: (\d+)/)?.[1], h = out.match(/pixelHeight: (\d+)/)?.[1]
    return w && h ? `${w}x${h}px` : ''
  } catch { return '' }
}

/** Cheap binary sniff for extension-less files: NUL byte in the first 4 KB → binary. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * If `message` carries the composer's attachment note, read each attached file from the
 * sandbox and return the message with an appended ATTACHED FILE CONTENT block the model can
 * actually reason over. Message is returned unchanged when there is no note, and every
 * failure degrades to an honest per-file placeholder — this must never break a send.
 */
export async function foldAttachmentContext(
  message: string,
  sandboxResolve: (rel: string) => string | null,
): Promise<string> {
  const rels = parseAttachmentNote(message)
  if (!rels.length) return message
  const blocks: string[] = []
  let budget = TOTAL_CAP
  for (const rel of rels) {
    try {
      const abs = sandboxResolve(rel)
      if (!abs || !fs.existsSync(abs)) { blocks.push(`--- ${rel}: not found in the workspace ---`); continue }
      const ext = path.extname(rel).toLowerCase()
      const size = fs.statSync(abs).size
      if (IMAGE_EXT.has(ext)) {
        const [dims, text] = await Promise.all([imageDims(abs), ocrImage(abs)])
        const clipped = text.slice(0, Math.min(PER_FILE_CAP, budget))
        budget -= clipped.length
        blocks.push(clipped
          ? `--- ${rel} (image${dims ? ', ' + dims : ''}, ${size} bytes) — text extracted on-device via OCR ---\n${clipped}`
          : `--- ${rel} (image${dims ? ', ' + dims : ''}, ${size} bytes) — no readable text found in the image ---`)
        continue
      }
      const buf = fs.readFileSync(abs)
      const isText = TEXT_EXT.has(ext) || (!ext && !looksBinary(buf))
      if (!isText) { blocks.push(`--- ${rel} (${size} bytes) — binary file, contents not readable as text ---`); continue }
      const content = buf.toString('utf8').slice(0, Math.min(PER_FILE_CAP, budget))
      budget -= content.length
      blocks.push(`--- ${rel} (${size} bytes) ---\n${content}${buf.length > content.length ? '\n[…truncated]' : ''}`)
    } catch (e: any) {
      blocks.push(`--- ${rel}: could not read (${String(e?.message ?? e).slice(0, 80)}) ---`)
    }
    if (budget <= 0) { blocks.push('[…remaining attachments omitted — context budget reached]'); break }
  }
  return `${message}\n\nATTACHED FILE CONTENT (read from the workspace sandbox — use this to answer):\n${blocks.join('\n\n')}`
}
