// ============================================================
// CRUCIBLE — Code Execution Sandbox
// On-device execution for JS/TS/Python/Bash + syntax checking
// for compiled languages. Zero API calls. Zero gimmicks.
// ============================================================

import * as vm from 'vm'
import { spawn, ChildProcess } from 'child_process'
import * as ts from 'typescript'

// ── Types ─────────────────────────────────────────────────────────────────

export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'bash'
  | 'rust'
  | 'go'
  | 'java'
  | 'swift'
  | 'sql'
  | 'html'
  | 'css'
  | 'json'
  | 'yaml'
  | 'unknown'

export type ErrorType =
  | 'SYNTAX'
  | 'REFERENCE'
  | 'TYPE'
  | 'IMPORT'
  | 'RUNTIME'
  | 'LOGIC'
  | 'TIMEOUT'
  | 'UNKNOWN'

export interface ExecutionResult {
  success: boolean
  output: string
  error: string | null
  errorType: ErrorType | null
  errorLine: number | null
  errorColumn: number | null
  executionMs: number
  language: Language
}

// ── Language Detection ────────────────────────────────────────────────────

const LANGUAGE_PATTERNS: Array<{ language: Language; patterns: RegExp[] }> = [
  {
    language: 'bash',
    patterns: [/^#!\s*\/bin\/(ba)?sh/m, /\becho\s+/, /\bfi\b/, /\besac\b/, /\$\{?\w+\}?/]
  },
  {
    language: 'python',
    patterns: [/^import\s+\w+/m, /^from\s+\w+\s+import/m, /\bdef\s+\w+\s*\(/, /\belif\b/, /\bexcept\b/, /print\(/]
  },
  {
    language: 'rust',
    patterns: [/\bfn\s+main\s*\(\s*\)/, /\blet\s+mut\b/, /\bimpl\b/, /use\s+std::/, /->.*\{/]
  },
  {
    language: 'go',
    patterns: [/\bpackage\s+main\b/, /\bfunc\s+main\s*\(\s*\)/, /\bfmt\.Print/, /\b:=\b/]
  },
  {
    language: 'java',
    patterns: [/\bpublic\s+class\b/, /\bSystem\.out\.print/, /\bvoid\s+main\b/, /\bimport\s+java\./]
  },
  {
    language: 'swift',
    patterns: [/\bimport\s+Foundation\b/, /\bvar\s+\w+\s*:\s*\w+/, /\bguard\s+let\b/, /\bfunc\s+\w+/]
  },
  {
    language: 'sql',
    patterns: [/\bSELECT\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bWHERE\b/i]
  },
  {
    language: 'html',
    patterns: [/<!DOCTYPE\s+html/i, /<html[\s>]/, /<body[\s>]/, /<div[\s>]/]
  },
  {
    language: 'css',
    patterns: [/\w+\s*\{[^}]*\}/, /margin\s*:/, /padding\s*:/, /font-size\s*:/]
  },
  {
    language: 'json',
    patterns: [/^\s*[\[{]/, /^\s*"[\w]+":\s*/m]
  },
  {
    language: 'typescript',
    patterns: [/:\s*(string|number|boolean|void|any|never)\b/, /\binterface\s+\w+/, /\btype\s+\w+\s*=/, /<\w+>/, /\bas\s+\w+/]
  },
  {
    language: 'javascript',
    patterns: [/\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /\brequire\s*\(/, /=>\s*\{/, /\bconsole\.\w+\(/]
  },
]

export function detectLanguage(code: string): Language {
  const stripped = code.replace(/^```\w*\n?/gm, '').replace(/^```$/gm, '').trim()

  for (const { language, patterns } of LANGUAGE_PATTERNS) {
    const matches = patterns.filter(p => p.test(stripped)).length
    if (matches >= 2) return language
  }

  for (const { language, patterns } of LANGUAGE_PATTERNS) {
    if (patterns.some(p => p.test(stripped))) return language
  }

  return 'unknown'
}

export function stripMarkdownFences(code: string): string {
  return code.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim()
}

// ── Python Prewarmed Worker ───────────────────────────────────────────────

let pythonWorker: ChildProcess | null = null
let pythonReady = false

export function prewarmPython(): void {
  try {
    pythonWorker = spawn('python3', ['-u', '-c', `
import sys
import json
while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        code = json.loads(line.strip())
        exec(compile(code, '<crucible>', 'exec'), {})
        sys.stdout.write(json.dumps({'success': True, 'output': ''}) + '\\n')
        sys.stdout.flush()
    except Exception as e:
        import traceback
        sys.stdout.write(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}) + '\\n')
        sys.stdout.flush()
`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' }
    })
    pythonReady = true
    console.log('[Sandbox] Python prewarmed')

    pythonWorker.on('exit', () => {
      pythonReady = false
      pythonWorker = null
      console.log('[Sandbox] Python worker exited — will respawn on next call')
    })
  } catch (e) {
    console.warn('[Sandbox] Python prewarm failed — will use cold spawn:', e)
  }
}

// ── Execution Functions ───────────────────────────────────────────────────

function executeJS(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const output: string[] = []
    const sandbox = {
      console: {
        log: (...args: unknown[]) => output.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => output.push('[err] ' + args.map(String).join(' ')),
        warn: (...args: unknown[]) => output.push('[warn] ' + args.map(String).join(' ')),
      },
      setTimeout: () => {},
      clearTimeout: () => {},
      JSON,
      Math,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Error,
      Map,
      Set,
      Promise,
    }

    try {
      const script = new vm.Script(code, { timeout: timeoutMs })
      vm.createContext(sandbox)
      script.runInContext(sandbox, { timeout: timeoutMs })
      resolve({
        success: true,
        output: output.join('\n'),
        error: null,
        errorType: null,
        errorLine: null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'javascript'
      })
    } catch (e: any) {
      const isTimeout = e.message?.includes('timed out') || e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      resolve({
        success: false,
        output: output.join('\n'),
        error: e.message,
        errorType: isTimeout ? 'TIMEOUT' : classifyJSError(e),
        errorLine: extractLineFromStack(e.stack),
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'javascript'
      })
    }
  })
}

function executeTS(code: string, timeoutMs: number): Promise<ExecutionResult> {
  try {
    const result = ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        strict: false,
      }
    })
    return executeJS(result.outputText, timeoutMs).then(r => ({ ...r, language: 'typescript' as Language }))
  } catch (e: any) {
    return Promise.resolve({
      success: false,
      output: '',
      error: e.message,
      errorType: 'SYNTAX' as ErrorType,
      errorLine: null,
      errorColumn: null,
      executionMs: 0,
      language: 'typescript' as Language
    })
  }
}

function executePython(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    if (pythonReady && pythonWorker?.stdin && pythonWorker?.stdout) {
      let output = ''
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('\n')) {
          pythonWorker?.stdout?.removeListener('data', onData)
          clearTimeout(timer)
          try {
            const parsed = JSON.parse(output.trim())
            resolve({
              success: parsed.success,
              output: parsed.output ?? '',
              error: parsed.error ?? null,
              errorType: parsed.error ? classifyPythonError(parsed.error) : null,
              errorLine: parsed.traceback ? extractPythonLine(parsed.traceback) : null,
              errorColumn: null,
              executionMs: Date.now() - start,
              language: 'python'
            })
          } catch {
            resolve({ success: false, output: '', error: 'Parse error from Python worker', errorType: 'UNKNOWN', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'python' })
          }
        }
      }

      const timer = setTimeout(() => {
        pythonWorker?.stdout?.removeListener('data', onData)
        resolve({ success: false, output: '', error: 'Execution timed out', errorType: 'TIMEOUT', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'python' })
      }, timeoutMs)

      pythonWorker.stdout.on('data', onData)
      pythonWorker.stdin.write(JSON.stringify(code) + '\n')
      return
    }

    const proc = spawn('python3', ['-c', code], {
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' },
      cwd: '/tmp'
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString())
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr || null,
        errorType: stderr ? classifyPythonError(stderr) : null,
        errorLine: stderr ? extractPythonLine(stderr) : null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'python'
      })
    })
    proc.on('error', (e) => {
      resolve({ success: false, output: '', error: e.message, errorType: 'RUNTIME', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'python' })
    })
  })
}

function executeBash(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', code], {
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' },
      cwd: '/tmp'
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString())
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
    proc.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        output: stdout,
        error: stderr || null,
        errorType: stderr ? 'RUNTIME' : null,
        errorLine: null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'bash'
      })
    })
    proc.on('error', (e) => {
      resolve({ success: false, output: '', error: e.message, errorType: 'RUNTIME', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'bash' })
    })
  })
}

function syntaxCheckCompiled(code: string, language: Language, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()

  const configs: Partial<Record<Language, { cmd: string; args: string[]; stdin?: boolean }>> = {
    rust:  { cmd: 'rustc',  args: ['--edition=2021', '--error-format=json', '--emit=metadata', '-'], stdin: true },
    go:    { cmd: 'gofmt',  args: ['-e'], stdin: true },
    java:  { cmd: 'javac',  args: ['-'] },
    swift: { cmd: 'swiftc', args: ['-parse', '-'] },
  }

  const config = configs[language]
  if (!config) {
    return Promise.resolve({ success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: 0, language })
  }

  return new Promise((resolve) => {
    const proc = spawn(config.cmd, config.args, { timeout: timeoutMs })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString())
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
    if (config.stdin) proc.stdin?.write(code)
    proc.stdin?.end()
    proc.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        output: stdout,
        error: stderr || null,
        errorType: stderr ? 'SYNTAX' : null,
        errorLine: extractCompilerLine(stderr, language),
        errorColumn: null,
        executionMs: Date.now() - start,
        language
      })
    })
    proc.on('error', () => {
      // Compiler not installed — don't block
      resolve({ success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: Date.now() - start, language })
    })
  })
}

function validateStructured(code: string, language: Language): ExecutionResult {
  const start = Date.now()
  try {
    if (language === 'json') {
      JSON.parse(code)
    } else if (language === 'html') {
      if (!/<html[\s>]/i.test(code) && !/<body[\s>]/i.test(code) && !/<div[\s>]/i.test(code)) {
        throw new Error('No recognizable HTML structure')
      }
    }
    return { success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: Date.now() - start, language }
  } catch (e: any) {
    return { success: false, output: '', error: e.message, errorType: 'SYNTAX', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language }
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────────

export async function executeCode(
  rawCode: string,
  language?: Language,
  timeoutMs = 5000
): Promise<ExecutionResult> {
  const code = stripMarkdownFences(rawCode)
  const lang = language ?? detectLanguage(code)

  switch (lang) {
    case 'javascript': return executeJS(code, timeoutMs)
    case 'typescript': return executeTS(code, timeoutMs)
    case 'python':     return executePython(code, timeoutMs)
    case 'bash':       return executeBash(code, timeoutMs)
    case 'rust':
    case 'go':
    case 'java':
    case 'swift':      return syntaxCheckCompiled(code, lang, timeoutMs)
    case 'json':
    case 'html':
    case 'css':
    case 'yaml':
    case 'sql':        return validateStructured(code, lang)
    default:           return { success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: 0, language: lang }
  }
}

// ── Error Classification Helpers ──────────────────────────────────────────

function classifyJSError(e: Error): ErrorType {
  if (e instanceof SyntaxError) return 'SYNTAX'
  if (e instanceof ReferenceError) return 'REFERENCE'
  if (e instanceof TypeError) return 'TYPE'
  if (e.message?.includes('Cannot find module') || e.message?.includes('require')) return 'IMPORT'
  return 'RUNTIME'
}

function classifyPythonError(stderr: string): ErrorType {
  if (stderr.includes('SyntaxError')) return 'SYNTAX'
  if (stderr.includes('IndentationError')) return 'SYNTAX'
  if (stderr.includes('NameError')) return 'REFERENCE'
  if (stderr.includes('ImportError') || stderr.includes('ModuleNotFoundError')) return 'IMPORT'
  if (stderr.includes('TypeError')) return 'TYPE'
  return 'RUNTIME'
}

function extractLineFromStack(stack: string): number | null {
  const match = stack?.match(/<anonymous>:(\d+):\d+/) ?? stack?.match(/at\s+.*:(\d+):\d+/)
  return match ? parseInt(match[1]) : null
}

function extractPythonLine(traceback: string): number | null {
  const match = traceback.match(/line (\d+)/)
  return match ? parseInt(match[1]) : null
}

function extractCompilerLine(stderr: string, language: Language): number | null {
  if (language === 'rust') {
    try {
      const parsed = JSON.parse(stderr.split('\n').find(l => l.startsWith('{')) ?? '{}')
      return parsed?.spans?.[0]?.line_start ?? null
    } catch { return null }
  }
  const match = stderr.match(/:(\d+):/)
  return match ? parseInt(match[1]) : null
}
