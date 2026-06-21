// Step 9 — Remote Brain: macOS accessibility tools
// These give the agent "eyes" (UI tree) and "hands" (click, type) on the Mac.
// All implemented via osascript/Accessibility APIs — no vision model needed.
// Every function is fail-silent: errors returned as descriptive strings, never throws.

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ── get_ui_tree ───────────────────────────────────────────────────────────────
// Dumps the macOS Accessibility tree of the currently focused window as structured text.
// Returns every interactive element (button, text field, menu item, link, etc.) with
// its label, role, and whether it's enabled — the agent reads this to understand the UI
// without needing a screenshot or vision model.

export interface UIElement {
  role: string
  title: string
  enabled: boolean
  focused: boolean
  children?: UIElement[]
}

export interface UITreeResult {
  app: string
  window: string
  elements: UIElement[]
  raw: string   // condensed text form for model injection
}

const UI_TREE_SCRIPT = `
tell application "System Events"
  set frontApp to first process whose frontmost is true
  set appName to name of frontApp
  set focusedWindow to "unknown"
  try
    set focusedWindow to name of front window of frontApp
  end try

  set output to "APP: " & appName & "\nWINDOW: " & focusedWindow & "\n"

  try
    set uiElements to entire contents of front window of frontApp
    set elementCount to 0
    repeat with elem in uiElements
      try
        set elemRole to role of elem
        set elemTitle to ""
        try
          set elemTitle to title of elem
        end try
        if elemTitle is "" then
          try
            set elemTitle to value of elem
          end try
        end if
        if elemTitle is "" then
          try
            set elemTitle to description of elem
          end try
        end if
        -- Only output interactive or labelled elements
        if elemTitle is not "" and elemTitle is not missing value then
          set output to output & elemRole & ": " & elemTitle & "\n"
          set elementCount to elementCount + 1
          if elementCount > 100 then exit repeat
        end if
      end try
    end repeat
  end try
  return output
end tell
`

export async function getUITree(): Promise<string> {
  try {
    const { stdout } = await execAsync(`osascript -e '${UI_TREE_SCRIPT.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 })
    const result = stdout.trim()
    if (!result || result === 'APP: \nWINDOW: unknown') {
      return 'No focused window. Use navigate_browser or open_app to bring an app to the foreground first.'
    }
    return result.slice(0, 3000)
  } catch (e: any) {
    const msg = String(e.message ?? '')
    if (/not authorized|accessibility|AXError/i.test(msg)) {
      return 'Accessibility access not granted. Go to System Settings → Privacy & Security → Accessibility and enable access for Terminal/Node.'
    }
    return `Error reading UI tree: ${msg.slice(0, 100)}`
  }
}

// ── click_element ─────────────────────────────────────────────────────────────
// Clicks a UI element by its title or partial title match using Accessibility APIs.
// The agent specifies what to click in natural language; this resolves to the element.

export async function clickElement(targetTitle: string, appName?: string): Promise<string> {
  const appTarget = appName
    ? `process "${appName}"`
    : 'first process whose frontmost is true'

  const escaped = targetTitle.replace(/"/g, '\\"')
  const script = `
tell application "System Events"
  set targetApp to ${appTarget}
  try
    set matchedEl to first UI element of front window of targetApp whose title contains "${escaped}"
    click matchedEl
    return "Clicked: " & title of matchedEl
  end try
  try
    set matchedEl to first button of front window of targetApp whose title contains "${escaped}"
    click matchedEl
    return "Clicked button: " & title of matchedEl
  end try
  try
    set matchedEl to first menu item of front window of targetApp whose title contains "${escaped}"
    click matchedEl
    return "Clicked menu item: " & title of matchedEl
  end try
  return "Element not found: ${escaped}"
end tell`

  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 })
    const result = stdout.trim()
    if (result.startsWith('Element not found')) return result
    // Post-click pause: give the UI 300ms to react, then confirm by re-reading tree
    await new Promise(r => setTimeout(r, 300))
    return result + ' (click dispatched)'
  } catch (e: any) {
    return `Click failed: ${e.message?.slice(0, 100)}`
  }
}

// ── type_text ─────────────────────────────────────────────────────────────────
// Types text into the currently focused field. Uses System Events keystroke.
// The agent must first ensure the right field is focused (via click_element or UI check).

export async function typeText(text: string): Promise<string> {
  if (!text || text.length === 0) return 'No text provided'
  if (text.length > 1000) return 'Text too long (max 1000 chars)'

  // Escape special characters for osascript
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')

  const script = `
tell application "System Events"
  keystroke "${escaped}"
  return "Typed: ${escaped.slice(0, 40)}..."
end tell`

  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 10000 })
    return stdout.trim()
  } catch (e: any) {
    return `Type failed: ${e.message?.slice(0, 100)}`
  }
}

// ── open_app ──────────────────────────────────────────────────────────────────
// Opens an application or URL on the Mac. Already exists in the registry but
// providing here as a unified export for Remote Brain mode.

export async function openApp(target: string): Promise<string> {
  try {
    // URL pattern — open in default browser
    if (/^https?:\/\//.test(target)) {
      await execAsync(`open "${target.replace(/"/g, '\\"')}"`, { timeout: 5000 })
      return `Opened URL: ${target.slice(0, 80)}`
    }
    // Absolute file path — open directly
    if (target.startsWith('/') || target.startsWith('~')) {
      await execAsync(`open "${target.replace(/"/g, '\\"')}"`, { timeout: 5000 })
      return `Opened: ${target.slice(0, 80)}`
    }
    // App name — use -a flag only. Do NOT fall back to open without -a:
    // that resolves the name as a relative path from cwd and produces a
    // misleading "file not found" error instead of "app not installed".
    await execAsync(`open -a "${target.replace(/"/g, '\\"')}"`, { timeout: 5000 })
    return `Opened app: ${target}`
  } catch (e: any) {
    const msg = String(e.message ?? '')
    if (msg.includes('Unable to find application') || msg.includes('does not exist') || msg.includes('No such file')) {
      return `App not found: "${target}" does not appear to be installed on this Mac.`
    }
    return `Open failed: ${msg.slice(0, 100)}`
  }
}

// ── navigate_browser ──────────────────────────────────────────────────────────
// Opens a URL in the default browser, or brings a named app to the foreground.
// If a URL is given: opens it in Safari (or default browser).
// If an app name is given: brings it to the foreground; launches it if not running.
// Use this before get_ui_tree when you need to ensure the right app is focused.

export async function navigateBrowser(target: string): Promise<string> {
  try {
    if (/^https?:\/\//.test(target)) {
      // URL — open in default browser
      await execAsync(`open "${target.replace(/"/g, '\\"')}"`, { timeout: 5000 })
      // Give browser 800ms to load and come to foreground
      await new Promise(r => setTimeout(r, 800))
      return `Opened URL in browser: ${target.slice(0, 100)}`
    }
    // App name — activate or launch
    const activateScript = `
tell application "${target.replace(/"/g, '\\"')}"
  activate
end tell`
    await execAsync(`osascript -e '${activateScript.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 })
    await new Promise(r => setTimeout(r, 600))
    return `Activated app: ${target}`
  } catch (e: any) {
    const msg = String(e.message ?? '')
    if (msg.includes('not find') || msg.includes('does not exist')) {
      return `App not found: "${target}". Try open_app instead, or check the exact app name.`
    }
    return `navigate_browser failed: ${msg.slice(0, 100)}`
  }
}

// ── take_screenshot ───────────────────────────────────────────────────────────
// Captures the screen as a JPEG and returns the base64-encoded bytes.
// Used by the MJPEG stream endpoint (server.ts) and optionally by the agent.

export async function takeScreenshot(quality = 60): Promise<Buffer | null> {
  try {
    const { stdout } = await execAsync(
      `screencapture -x -t jpg -q ${quality} -`,
      { encoding: 'buffer', timeout: 3000 } as any,
    )
    return stdout as unknown as Buffer
  } catch {
    return null
  }
}
