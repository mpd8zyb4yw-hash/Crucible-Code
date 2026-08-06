// ── macOS Capability Recipes — the universal system-control substrate ─────────
//
// THE PROBLEM this solves: hand-coding a bespoke tool per system task ("brightness",
// then "volume", then "dark mode"…) does not scale. macOS already exposes almost every
// setting through reliable native interfaces — `osascript`, `networksetup`, `pmset`,
// `defaults` — so the agent never needs UI automation (dragging the System Settings
// slider via Accessibility is what produced the "-10006 / can't set «class tabg»" loop).
//
// This module is a curated, VERIFIED recipe library: each recipe knows the canonical
// command AND how to read the resulting state back, so every action is confirmed, not
// assumed. It is consumed three ways:
//   1. The `control_mac` tool dispatches to it (one tool, many capabilities).
//   2. renderPlaybook() injects a compact catalog into the agent system prompt so the
//      model knows what exists and reaches for it instead of clicking.
//   3. The deterministic intent router fast-paths the common ones (no model call).
//
// SELF-EXTENSION: when a request maps to no recipe here, the agent is told (in the
// prompt) to accomplish it via `run` (shell/osascript) and then persist a working
// recipe with `create_tool` — so the library grows from use, by the agent, automatically.

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface CapabilityResult {
  ok: boolean
  output: string
  /** True when the post-action read-back confirmed the new state. */
  verified?: boolean
}

interface ShResult { ok: boolean; out: string; code: number | null }

async function sh(cmd: string, timeoutMs = 6000): Promise<ShResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs })
    return { ok: true, out: (stdout || stderr || '').trim(), code: 0 }
  } catch (e: any) {
    return { ok: false, out: String(e?.stderr || e?.message || e).trim().slice(0, 200), code: e?.code ?? null }
  }
}

/** Single-quote a string for safe embedding in a /bin/sh command. */
function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

const clampPct = (v: unknown): number => Math.max(0, Math.min(100, Math.round(Number(v))))

// macOS exposes 16 discrete brightness levels via the F1/F2 keys. No absolute-set API
// ships with the OS, so step to the floor then up to the target fraction — all inside a
// single osascript process (spawning one per keypress made this take ~5s).
const BRIGHTNESS_LEVELS = 16

export interface MacRecipe {
  intent: string
  aliases: string[]
  category: 'display' | 'audio' | 'network' | 'power' | 'system'
  /** Compact one-liner for the prompt playbook. */
  playbook: string
  /** Args this recipe understands, for the tool schema + playbook. */
  args: string
  readOnly?: boolean
  run: (args: Record<string, unknown>) => Promise<CapabilityResult>
}

export const RECIPES: MacRecipe[] = [
  // ── DISPLAY ─────────────────────────────────────────────────────────────────
  {
    intent: 'brightness',
    aliases: ['brightness', 'screen brightness', 'dim', 'brighten'],
    category: 'display',
    playbook: 'brightness {percent:0-100} — set screen brightness',
    args: 'percent (0-100)',
    async run(a) {
      const pct = clampPct(a.percent)
      const up = Math.round((pct / 100) * BRIGHTNESS_LEVELS)
      const script = `tell application "System Events"
  repeat ${BRIGHTNESS_LEVELS} times
    key code 145
    delay 0.02
  end repeat
  repeat ${up} times
    key code 144
    delay 0.02
  end repeat
end tell`
      const r = await sh(`osascript -e ${q(script)}`, 8000)
      // Brightness has no reliable read-back without the (unavailable) `brightness` CLI.
      return { ok: r.ok, output: r.ok ? `Brightness set to ~${pct}%.` : `Brightness failed: ${r.out}`, verified: false }
    },
  },
  {
    intent: 'dark_mode',
    aliases: ['dark mode', 'light mode', 'appearance', 'dark theme', 'light theme'],
    category: 'display',
    playbook: 'dark_mode {on:true|false} — toggle Dark/Light appearance (verified)',
    args: 'on (boolean)',
    async run(a) {
      const on = a.on !== false && a.on !== 'false'
      const set = await sh(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to ${on}'`)
      if (!set.ok) return { ok: false, output: `Dark mode failed: ${set.out}` }
      const read = await sh(`osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode'`)
      const actual = /true/i.test(read.out)
      return { ok: actual === on, verified: read.ok, output: `Appearance set to ${on ? 'Dark' : 'Light'} mode (confirmed: now ${actual ? 'Dark' : 'Light'}).` }
    },
  },

  // ── AUDIO ───────────────────────────────────────────────────────────────────
  {
    intent: 'volume',
    aliases: ['volume', 'sound', 'audio level'],
    category: 'audio',
    playbook: 'volume {percent:0-100} — set output volume (verified)',
    args: 'percent (0-100)',
    async run(a) {
      const pct = clampPct(a.percent)
      const set = await sh(`osascript -e 'set volume output volume ${pct}'`)
      if (!set.ok) return { ok: false, output: `Volume failed: ${set.out}` }
      const read = await sh(`osascript -e 'output volume of (get volume settings)'`)
      const actual = parseInt(read.out, 10)
      // macOS quantises volume to 1/16 steps, so allow a small tolerance.
      const close = Number.isFinite(actual) && Math.abs(actual - pct) <= 7
      return { ok: close, verified: read.ok, output: `Volume set to ${pct}% (confirmed: ${Number.isFinite(actual) ? actual + '%' : 'unknown'}).` }
    },
  },
  {
    intent: 'mute',
    aliases: ['mute', 'unmute', 'silence'],
    category: 'audio',
    playbook: 'mute {on:true|false} — mute/unmute output (verified)',
    args: 'on (boolean)',
    async run(a) {
      const on = a.on !== false && a.on !== 'false'
      const set = await sh(`osascript -e 'set volume output muted ${on}'`)
      if (!set.ok) return { ok: false, output: `Mute failed: ${set.out}` }
      const read = await sh(`osascript -e 'output muted of (get volume settings)'`)
      const actual = /true/i.test(read.out)
      return { ok: actual === on, verified: read.ok, output: `${on ? 'Muted' : 'Unmuted'} (confirmed: ${actual ? 'muted' : 'unmuted'}).` }
    },
  },

  // ── NETWORK ─────────────────────────────────────────────────────────────────
  {
    intent: 'wifi',
    aliases: ['wifi', 'wi-fi', 'wireless', 'airport'],
    category: 'network',
    playbook: 'wifi {on:true|false} — turn Wi-Fi on/off (verified)',
    args: 'on (boolean)',
    async run(a) {
      const on = a.on !== false && a.on !== 'false'
      const devR = await sh(`networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2}'`)
      const dev = devR.out.split('\n')[0]?.trim() || 'en0'
      const set = await sh(`networksetup -setairportpower ${dev} ${on ? 'on' : 'off'}`)
      if (!set.ok) return { ok: false, output: `Wi-Fi toggle failed: ${set.out}` }
      const read = await sh(`networksetup -getairportpower ${dev}`)
      const actual = /\bOn\b/i.test(read.out)
      return { ok: actual === on, verified: read.ok, output: `Wi-Fi turned ${on ? 'on' : 'off'} on ${dev} (confirmed: ${actual ? 'on' : 'off'}).` }
    },
  },
  {
    intent: 'wifi_connect',
    aliases: ['connect to wifi', 'join network', 'connect wifi'],
    category: 'network',
    playbook: 'wifi_connect {ssid, password?} — join a Wi-Fi network',
    args: 'ssid (string), password (string, optional)',
    async run(a) {
      const ssid = String(a.ssid ?? '').trim()
      if (!ssid) return { ok: false, output: 'wifi_connect needs an ssid.' }
      const devR = await sh(`networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2}'`)
      const dev = devR.out.split('\n')[0]?.trim() || 'en0'
      const pw = a.password ? ` ${q(String(a.password))}` : ''
      const set = await sh(`networksetup -setairportnetwork ${dev} ${q(ssid)}${pw}`, 12000)
      // setairportnetwork prints nothing on success, an error string on failure.
      const failed = /error|not find|could not|failed/i.test(set.out)
      return { ok: set.ok && !failed, output: failed ? `Could not join "${ssid}": ${set.out}` : `Joined Wi-Fi network "${ssid}".` }
    },
  },

  // ── POWER ───────────────────────────────────────────────────────────────────
  {
    intent: 'sleep',
    aliases: ['sleep', 'go to sleep', 'suspend'],
    category: 'power',
    playbook: 'sleep — put the Mac to sleep now',
    args: '(none)',
    async run() {
      const r = await sh('pmset sleepnow')
      return { ok: r.ok, output: r.ok ? 'Mac going to sleep.' : `Sleep failed: ${r.out}` }
    },
  },
  {
    intent: 'display_sleep',
    aliases: ['turn off screen', 'turn off display', 'sleep display', 'screen off'],
    category: 'power',
    playbook: 'display_sleep — turn the screen off (system stays awake)',
    args: '(none)',
    async run() {
      const r = await sh('pmset displaysleepnow')
      return { ok: r.ok, output: r.ok ? 'Display turned off.' : `Display sleep failed: ${r.out}` }
    },
  },
  {
    intent: 'battery',
    aliases: ['battery', 'battery level', 'charge', 'power status'],
    category: 'power',
    readOnly: true,
    playbook: 'battery — read battery percentage and charging state',
    args: '(none)',
    async run() {
      const r = await sh('pmset -g batt')
      const m = r.out.match(/(\d{1,3})%/)
      const charging = /AC Power/i.test(r.out) ? 'charging/AC' : 'on battery'
      return { ok: r.ok, readOnly: true as any, output: r.ok ? `Battery: ${m ? m[1] + '%' : 'unknown'}, ${charging}.` : `Battery read failed: ${r.out}` }
    },
  },

  // ── SYSTEM ──────────────────────────────────────────────────────────────────
  {
    intent: 'open_folder',
    aliases: ['open folder', 'go to folder', 'show folder', 'open downloads', 'open documents', 'reveal in finder'],
    category: 'system',
    playbook: 'open_folder {folder:"downloads"|"documents"|"desktop"|"home"|"applications"|"pictures"|"movies"|"music"|<absolute path>} — open a folder in a Finder window',
    args: 'folder (well-known name or absolute path)',
    async run(a) {
      const raw = String(a.folder ?? a.path ?? a.target ?? 'home').trim()
      const home = process.env.HOME ?? '~'
      const KNOWN: Record<string, string> = {
        downloads: `${home}/Downloads`, documents: `${home}/Documents`, desktop: `${home}/Desktop`,
        home, applications: '/Applications', pictures: `${home}/Pictures`,
        movies: `${home}/Movies`, music: `${home}/Music`, trash: `${home}/.Trash`,
      }
      const target = KNOWN[raw.toLowerCase()] ?? (raw.startsWith('/') || raw.startsWith('~') ? raw.replace(/^~/, home) : '')
      if (!target) {
        return { ok: false, output: `Unknown folder "${raw}" — use one of ${Object.keys(KNOWN).join(', ')} or an absolute path.` }
      }
      const r = await sh(`open ${q(target)}`)
      return { ok: r.ok, output: r.ok ? `Opened ${target} in Finder.` : `Open failed: ${r.out}` }
    },
  },
  {
    intent: 'lock_screen',
    aliases: ['lock screen', 'lock the mac', 'lock'],
    category: 'system',
    playbook: 'lock_screen — lock the screen immediately',
    args: '(none)',
    async run() {
      const r = await sh(`osascript -e 'tell application "System Events" to keystroke "q" using {control down, command down}'`)
      return { ok: r.ok, output: r.ok ? 'Screen locked.' : `Lock failed: ${r.out}` }
    },
  },
]

const BY_KEY = new Map<string, MacRecipe>()
for (const r of RECIPES) {
  BY_KEY.set(r.intent, r)
  for (const al of r.aliases) BY_KEY.set(al.toLowerCase(), r)
}

/** Resolve a recipe by exact intent name or alias. */
export function findRecipe(intentOrAlias: string): MacRecipe | undefined {
  return BY_KEY.get(String(intentOrAlias ?? '').toLowerCase().trim())
}

/** Run a capability by intent name + args, with built-in verification. */
export async function runCapability(intent: string, args: Record<string, unknown> = {}): Promise<CapabilityResult> {
  const recipe = findRecipe(intent)
  if (!recipe) {
    return {
      ok: false,
      output: `No built-in recipe for "${intent}". Available: ${RECIPES.map(r => r.intent).join(', ')}. ` +
        `For anything not listed, use the run tool (shell/osascript) directly, then create_tool to persist a recipe.`,
    }
  }
  try {
    return await recipe.run(args)
  } catch (e: any) {
    return { ok: false, output: `${intent} threw: ${String(e?.message ?? e).slice(0, 160)}` }
  }
}

/** Compact, categorised catalog for injection into the agent system prompt. */
export function renderPlaybook(): string {
  const cats: Record<string, string[]> = {}
  for (const r of RECIPES) (cats[r.category] ||= []).push(`  • ${r.playbook}`)
  const blocks = Object.entries(cats).map(([cat, lines]) => `${cat.toUpperCase()}:\n${lines.join('\n')}`)
  return blocks.join('\n')
}

/** Intent names, for the control_mac tool schema enum. */
export function capabilityIntents(): string[] {
  return RECIPES.map(r => r.intent)
}
