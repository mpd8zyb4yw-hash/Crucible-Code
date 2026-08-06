"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const COMMANDS = [
    {
        id: 'crucible.reviewSelection',
        kind: 'review',
        title: 'Review with Crucible',
        buildPrompt: (code, lang) => `Review the following ${lang} code. Identify bugs, edge cases, security issues, and design problems. ` +
            `Be specific and reference concrete lines or constructs.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
    },
    {
        id: 'crucible.explainSelection',
        kind: 'explain',
        title: 'Explain with Crucible',
        buildPrompt: (code, lang) => `Explain what the following ${lang} code does, step by step, including its purpose, inputs, ` +
            `outputs, and any non-obvious behavior.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
    },
    {
        id: 'crucible.improveSelection',
        kind: 'improve',
        title: 'Improve with Crucible',
        buildPrompt: (code, lang) => `Improve the following ${lang} code. Provide a cleaner, safer, more idiomatic version and briefly ` +
            `explain each change. Keep behavior equivalent unless a bug requires a fix.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
    },
];
function activate(context) {
    for (const spec of COMMANDS) {
        context.subscriptions.push(vscode.commands.registerCommand(spec.id, () => runCommand(spec, context)));
    }
}
function deactivate() {
    // No persistent resources to release.
}
async function runCommand(spec, context) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Crucible: open a file and select some code first.');
        return;
    }
    const code = editor.document.getText(editor.selection);
    if (!code.trim()) {
        vscode.window.showWarningMessage('Crucible: select some code first.');
        return;
    }
    const config = vscode.workspace.getConfiguration('crucible');
    const endpoint = (config.get('endpoint') || 'https://crucible.cam').replace(/\/+$/, '');
    const apiKey = config.get('apiKey') || '';
    if (!apiKey) {
        const pick = await vscode.window.showWarningMessage('Crucible: no API key set. Add your session JWT in Settings (crucible.apiKey).', 'Open Settings');
        if (pick === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'crucible.apiKey');
        }
        return;
    }
    const message = spec.buildPrompt(code, editor.document.languageId || 'text');
    const panel = vscode.window.createWebviewPanel('crucibleResult', `Crucible: ${labelForKind(spec.kind)}`, vscode.ViewColumn.Beside, { enableScripts: false, retainContextWhenHidden: true });
    panel.webview.html = renderHtml({
        kind: spec.kind,
        status: 'streaming',
        result: { synthesis: '', criticProblems: [] },
    });
    try {
        await streamPipeline({
            endpoint,
            apiKey,
            message,
            onUpdate: (result, done) => {
                panel.webview.html = renderHtml({
                    kind: spec.kind,
                    status: done ? 'done' : 'streaming',
                    result,
                });
            },
        });
    }
    catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderHtml({
            kind: spec.kind,
            status: 'error',
            result: { synthesis: '', criticProblems: [], error: messageText },
        });
    }
}
function labelForKind(kind) {
    if (kind === 'review')
        return 'Review';
    if (kind === 'explain')
        return 'Explain';
    return 'Improve';
}
async function streamPipeline(args) {
    const { endpoint, apiKey, message, onUpdate } = args;
    const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            // The Crucible server authenticates via the crucible_session cookie; we also send
            // a Bearer header so deployments that read Authorization keep working.
            Cookie: `crucible_session=${apiKey}`,
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ message, mode: 'auto' }),
    });
    if (!response.ok) {
        let detail = '';
        try {
            detail = await response.text();
        }
        catch {
            /* ignore */
        }
        throw new Error(`Pipeline returned ${response.status} ${response.statusText}` +
            (detail ? ` — ${detail.slice(0, 300)}` : ''));
    }
    if (!response.body) {
        throw new Error('Pipeline response had no body.');
    }
    const result = { synthesis: '', criticProblems: [] };
    // While the pipeline streams synthesis_token chunks we accumulate them; a final
    // `synthesis` event with replace:true supersedes the streamed draft with polished text.
    let streamedDraft = '';
    let finalSynthesis = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flush = (done) => {
        result.synthesis = finalSynthesis !== null ? finalSynthesis : streamedDraft;
        onUpdate(result, done);
    };
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const rawLine = buffer.slice(0, newlineIdx).trimEnd();
                buffer = buffer.slice(newlineIdx + 1);
                if (!rawLine.startsWith('data: '))
                    continue;
                const payload = rawLine.slice('data: '.length);
                if (payload === '[DONE]') {
                    flush(true);
                    return;
                }
                let event;
                try {
                    event = JSON.parse(payload);
                }
                catch {
                    continue;
                }
                switch (event.type) {
                    case 'synthesis_token':
                        if (typeof event.text === 'string') {
                            streamedDraft += event.text;
                            flush(false);
                        }
                        break;
                    case 'synthesis':
                        if (typeof event.text === 'string') {
                            // A done/replace synthesis is the authoritative final text.
                            if (event.replace || event.done) {
                                finalSynthesis = event.text;
                            }
                            else {
                                streamedDraft += event.text;
                            }
                            flush(false);
                        }
                        break;
                    case 'confidence':
                        result.confidence = {
                            overallTier: String(event.overallTier ?? ''),
                            overallScore: Number(event.overallScore ?? 0),
                            summary: event.summary,
                            flaggedClaims: Array.isArray(event.flaggedClaims) ? event.flaggedClaims : [],
                        };
                        flush(false);
                        break;
                    case 'critic':
                        if (Array.isArray(event.problems)) {
                            result.criticProblems = event.problems.map((p) => String(p));
                            flush(false);
                        }
                        break;
                    default:
                        break;
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    flush(true);
}
function renderHtml(args) {
    const { kind, status, result } = args;
    const title = labelForKind(kind);
    let statusBadge = '';
    if (status === 'streaming') {
        statusBadge = '<span class="badge badge-live">Running pipeline</span>';
    }
    else if (status === 'done') {
        statusBadge = '<span class="badge badge-done">Complete</span>';
    }
    else {
        statusBadge = '<span class="badge badge-error">Error</span>';
    }
    let body = '';
    if (status === 'error') {
        body += `<section class="card error"><h2>Request failed</h2><pre class="synthesis">${escapeHtml(result.error || 'Unknown error.')}</pre></section>`;
    }
    else {
        const synthesis = result.synthesis.trim();
        if (synthesis) {
            body += `<section class="card"><h2>Synthesis</h2><div class="synthesis">${renderText(synthesis)}</div></section>`;
        }
        else if (status === 'streaming') {
            body += `<section class="card"><div class="placeholder">Waiting for the pipeline to respond...</div></section>`;
        }
        else {
            body += `<section class="card"><div class="placeholder">No synthesis was returned.</div></section>`;
        }
        if (result.confidence) {
            body += renderConfidence(result.confidence);
        }
        if (result.criticProblems.length > 0) {
            const items = result.criticProblems
                .map((p) => `<li>${escapeHtml(p)}</li>`)
                .join('');
            body += `<section class="card critic"><h2>Adversarial critic</h2><ul>${items}</ul></section>`;
        }
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>Crucible</title>
<style>
  :root {
    --bg: #16171d;
    --text: #9ca3af;
    --text-h: #f3f4f6;
    --border: #2e303a;
    --code-bg: #1f2028;
    --accent: #c084fc;
    --accent-bg: rgba(192, 132, 252, 0.15);
    --accent-border: rgba(192, 132, 252, 0.5);
    --warn: #f0b35b;
    --warn-bg: rgba(240, 179, 91, 0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 18px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 system-ui, 'Segoe UI', Roboto, sans-serif;
    letter-spacing: 0.1px;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    color: var(--text-h);
    font-weight: 600;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-h);
    font-weight: 600;
  }
  .badge {
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .badge-live { color: var(--accent); border-color: var(--accent-border); background: var(--accent-bg); }
  .badge-done { color: #7fd1a6; border-color: rgba(127, 209, 166, 0.5); background: rgba(127, 209, 166, 0.12); }
  .badge-error { color: #f08a8a; border-color: rgba(240, 138, 138, 0.5); background: rgba(240, 138, 138, 0.12); }
  .card {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 14px;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .card.error { border-color: rgba(240, 138, 138, 0.5); }
  .card.critic { border-color: var(--accent-border); }
  .synthesis {
    color: var(--text-h);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    margin: 0;
    font-family: inherit;
    font-size: 14px;
  }
  pre.synthesis { font-family: ui-monospace, Consolas, monospace; }
  .synthesis code, .codeblock {
    display: block;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 8px 0;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-h);
  }
  .inline-code {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12.5px;
  }
  .placeholder { color: var(--text); font-style: italic; }
  ul { margin: 4px 0 0; padding-left: 18px; }
  li { margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; }
  .conf-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .tier {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    color: var(--text-h);
  }
  .tier-HIGH { color: #7fd1a6; border-color: rgba(127, 209, 166, 0.5); }
  .tier-MEDIUM { color: var(--warn); border-color: rgba(240, 179, 91, 0.5); }
  .tier-LOW, .tier-UNVERIFIED { color: #f08a8a; border-color: rgba(240, 138, 138, 0.5); }
  .meter { height: 6px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; flex: 1 1 120px; min-width: 120px; }
  .meter > span { display: block; height: 100%; background: var(--accent); }
  .flagged { margin-top: 8px; }
  .flagged .label { color: var(--warn); font-size: 12px; }
</style>
</head>
<body>
  <header>
    <h1>Crucible &mdash; ${escapeHtml(title)}</h1>
    ${statusBadge}
  </header>
  ${body}
</body>
</html>`;
}
function renderConfidence(conf) {
    const tier = (conf.overallTier || 'UNVERIFIED').toUpperCase();
    const pct = Math.max(0, Math.min(100, Math.round((conf.overallScore || 0) * 100)));
    let summaryLine = '';
    if (conf.summary) {
        const s = conf.summary;
        summaryLine = `<div class="placeholder" style="margin-top:6px;font-size:12px;">High ${s.high} &middot; Medium ${s.medium} &middot; Low ${s.low} &middot; Unverified ${s.unverified}</div>`;
    }
    let flagged = '';
    if (conf.flaggedClaims && conf.flaggedClaims.length > 0) {
        const items = conf.flaggedClaims
            .map((c) => `<li><span class="label">[${escapeHtml(c.tier)}]</span> ${escapeHtml(c.claim)}</li>`)
            .join('');
        flagged = `<div class="flagged"><div class="label">Flagged claims</div><ul>${items}</ul></div>`;
    }
    return `<section class="card">
    <h2>Confidence</h2>
    <div class="conf-head">
      <span class="tier tier-${escapeHtml(tier)}">${escapeHtml(tier)}</span>
      <div class="meter"><span style="width:${pct}%"></span></div>
      <span style="font-size:12px;color:var(--text-h);">${pct}%</span>
    </div>
    ${summaryLine}
    ${flagged}
  </section>`;
}
// ── Lightweight markdown-ish rendering ───────────────────────────────────────
// Renders fenced code blocks and inline code so the synthesis is readable. Everything
// is escaped first; only the markers we recognize produce structural HTML.
function renderText(text) {
    const parts = text.split(/```/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            // Inside a fenced block. Strip an optional language hint on the first line.
            const block = parts[i].replace(/^[^\n]*\n/, (m) => (m.trim().includes(' ') ? m : ''));
            html += `<div class="codeblock">${escapeHtml(block.replace(/^\n/, ''))}</div>`;
        }
        else {
            html += inlineCode(escapeHtml(parts[i]));
        }
    }
    return html;
}
function inlineCode(escaped) {
    return escaped.replace(/`([^`]+)`/g, (_m, p1) => `<span class="inline-code">${p1}</span>`);
}
function escapeHtml(input) {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
//# sourceMappingURL=extension.js.map