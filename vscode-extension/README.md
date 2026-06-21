# Crucible for VS Code

Send the selected code straight to your Crucible multi-model pipeline from inside the
editor. Three right-click commands review, explain, or improve your selection, then
render the synthesis — plus any adversarial-critic findings and confidence calibration
— in a dark panel styled to match the Crucible app.

## Commands

Select code in the editor, right-click, and choose one of:

- **Review with Crucible** (`crucible.reviewSelection`) — bugs, edge cases, security, design.
- **Explain with Crucible** (`crucible.explainSelection`) — a step-by-step walkthrough.
- **Improve with Crucible** (`crucible.improveSelection`) — a cleaner, safer rewrite.

Each command POSTs the selection to `${endpoint}/api/chat` with body
`{ message, mode: "auto" }`, reads the SSE stream, and shows the result in a webview
panel beside your editor.

## Configuration

Open Settings and search for "Crucible":

| Setting | Default | Description |
| --- | --- | --- |
| `crucible.endpoint` | `https://crucible.cam` | Base URL of your Crucible pipeline. |
| `crucible.apiKey` | `` | Your Crucible session JWT. Sent as the `crucible_session` cookie and a `Bearer` Authorization header. |

To get your JWT: sign in to your Crucible instance in the browser and copy the value of
the `crucible_session` cookie, or use the token your deployment issues.

## Build and install

Requires VS Code `^1.85.0` (Node 18+ runtime — `fetch` is provided by VS Code; no
runtime dependencies are bundled).

```bash
# from this folder: vscode-extension/
npm install        # installs dev deps (@types/vscode, @types/node, typescript)
npm run compile    # type-checks and emits out/extension.js
```

### Run it locally (Extension Development Host)

1. Open the `vscode-extension/` folder in VS Code.
2. Press `F5`. A new "Extension Development Host" window launches with Crucible loaded.
3. In that window, set `crucible.apiKey` in Settings, select code, and right-click.

### Package a `.vsix`

```bash
npm install -g @vscode/vsce   # one-time
vsce package                  # produces crucible-vscode-<version>.vsix
code --install-extension crucible-vscode-<version>.vsix
```

## Notes

- Only the `vscode` module and the global `fetch` are used — no third-party runtime
  dependencies.
- The result webview runs with scripts disabled and a strict Content-Security-Policy;
  all model text is HTML-escaped before rendering.
