#!/usr/bin/env node
/**
 * THE ONE INTERACTIVE STEP, GIVEN A WINDOW A PERSON CAN ACTUALLY USE.
 *
 * The evaluator itself runs an emulated phone, and Chromium sizes a headed
 * window from that viewport — which produced a 271×58 frame that was on screen
 * and impossible to sign into. Rather than fight the emulation, the sign-in gets
 * its own launch: a plain desktop window, no device emulation, pointed at
 * Crucible's normal Google flow.
 *
 * It writes into the SAME profile directory the evaluator uses, which is the
 * whole point — the session it establishes is the session the evaluator will
 * have, and it survives restarts. Only one Chromium may hold a profile at a
 * time, so the bridge must be stopped before this runs.
 *
 *   node evaluator/login.mjs
 */
import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TARGET = process.env.EVAL_TARGET || 'https://crucible.cam'
const PROFILE = path.join(HERE, '.profile')

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  // No viewport override and no device emulation: a normal window, normally sized.
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--window-size=1100,900', '--window-position=80,60'],
})

const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(`${TARGET}/auth/login`, { waitUntil: 'domcontentloaded' })
await page.bringToFront()

console.log('\n  A browser window is open. Sign in with Google and approve Crucible.')
console.log('  Waiting… (this exits by itself once the session exists)\n')

const signedIn = async () => {
  try {
    const r = await ctx.request.get(`${TARGET}/api/home`, { failOnStatusCode: false })
    return r.status() !== 401
  } catch { return false }
}

const deadline = Date.now() + 10 * 60_000
let ok = false
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000))
  if (await signedIn()) { ok = true; break }
  if (!ctx.pages().length) break
}

console.log(ok ? '  Signed in. Session stored in evaluator/.profile' : '  Gave up without a session.')
await ctx.close()
process.exit(ok ? 0 : 1)
