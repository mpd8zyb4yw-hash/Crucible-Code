// Multimodal grounding (Session H) — vision tools for the Researcher.
// read_image / read_pdf base64-encode a local file or fetched URL and send it to
// Google Gemini Flash via the native generateContent REST endpoint using inline_data.
// Gemini Flash reads images AND PDFs natively, so we extract text/description without
// any extra OCR/parsing deps. Both functions NEVER throw — on any failure they return a
// short "[<fn> failed: <reason>]" string so the agent loop is never blocked.

import fs from 'fs'
import path from 'path'

// Free-tier philosophy: reuse the existing Gemini key already wired for the project.
const GEMINI_MODEL = 'gemini-2.0-flash'
const TIMEOUT_MS = 10_000

// Map common image extensions to MIME types Gemini accepts via inline_data.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

/** Load bytes from a local file path or an http(s) URL. Returns base64 + best-guess mime. */
async function loadBytes(
  pathOrUrl: string,
  fallbackMime: string,
): Promise<{ base64: string; mime: string }> {
  const isUrl = /^https?:\/\//i.test(pathOrUrl)
  if (isUrl) {
    const res = await fetch(pathOrUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`fetch returned HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const headerMime = res.headers.get('content-type')?.split(';')[0]?.trim()
    const extMime = IMAGE_MIME[path.extname(new URL(pathOrUrl).pathname).toLowerCase()]
    return { base64: buf.toString('base64'), mime: headerMime || extMime || fallbackMime }
  }
  const abs = path.isAbsolute(pathOrUrl)
    ? pathOrUrl
    : path.resolve(pathOrUrl.replace(/^~/, process.env.HOME ?? ''))
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`)
  if (fs.statSync(abs).isDirectory()) throw new Error(`${abs} is a directory, not a file`)
  const buf = fs.readFileSync(abs)
  const extMime = IMAGE_MIME[path.extname(abs).toLowerCase()]
  return { base64: buf.toString('base64'), mime: extMime || fallbackMime }
}

/** POST an inline_data part to Gemini generateContent and return the extracted text. */
async function callGeminiVision(base64: string, mime: string, prompt: string): Promise<string> {
  const key = process.env.VITE_GEMINI_API_KEY
  if (!key) throw new Error('VITE_GEMINI_API_KEY not set in .env.local')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: base64 } },
        ],
      },
    ],
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Gemini HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  const data = (await res.json()) as any
  const parts: any[] = data?.candidates?.[0]?.content?.parts ?? []
  const text = parts.map((p: any) => p?.text ?? '').join('').trim()
  if (!text) {
    const block = data?.promptFeedback?.blockReason
    throw new Error(block ? `no text returned (blocked: ${block})` : 'no text returned by Gemini')
  }
  return text
}

/**
 * Read an image from a local path OR a URL, send it to Gemini Flash vision, and return
 * the extracted text / description. Never throws.
 */
export async function read_image(pathOrUrl: string): Promise<string> {
  try {
    const target = String(pathOrUrl ?? '').trim()
    if (!target) return '[read_image failed: a non-empty path or URL is required]'
    const { base64, mime } = await loadBytes(target, 'image/png')
    return await callGeminiVision(
      base64,
      mime,
      'Describe this image in detail. Transcribe any visible text exactly. If it is a chart, ' +
        'diagram, or table, explain its structure and report the data it contains.',
    )
  } catch (e: any) {
    return `[read_image failed: ${e?.message ?? e}]`
  }
}

/**
 * Read a PDF from a local path OR a URL by sending the raw bytes to Gemini Flash (which reads
 * PDFs natively) and return the extracted text with structure preserved. Never throws.
 */
export async function read_pdf(pathOrUrl: string): Promise<string> {
  try {
    const target = String(pathOrUrl ?? '').trim()
    if (!target) return '[read_pdf failed: a non-empty path or URL is required]'
    const { base64 } = await loadBytes(target, 'application/pdf')
    return await callGeminiVision(
      base64,
      'application/pdf',
      'Extract the full text content of this PDF. Preserve the document structure: keep headings, ' +
        'section order, lists, and tables. Render tables as readable plain text. Do not summarize — ' +
        'transcribe the content faithfully.',
    )
  } catch (e: any) {
    return `[read_pdf failed: ${e?.message ?? e}]`
  }
}
