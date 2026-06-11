# Crucible — Session Handoff 5

## CRITICAL: Project Location Changed
**OLD:** ~/Desktop/crucible (iCloud — BROKEN, do not use)
**NEW:** ~/crucible-local (local, iCloud-free)

## How to Run
- Terminal 1: cd ~/crucible-local && npx electron electron.cjs
- This spawns server and Vite automatically
- NEVER run npm run build
- If ports conflict: pkill -f "tsx"; pkill -f "vite"; pkill -f "Electron"; sleep 2

## What Happened This Session
1. Fixed True/False bug in modelData.ts (was causing blank screen)
2. Added Cloudflare Workers AI provider to server.ts and modelRegistry.ts
3. Removed broken Mistral 7B HF model (novita router doesn't support it)
4. Fixed provider type union in modelRegistry.ts to include huggingface and cloudflare
5. Lowered pass threshold from 0.65 to 0.55 in types.ts
6. Fixed EPIPE errors in electron.cjs (added stdout error handlers)
7. Built rag-context.ts (codebase indexer with queryIndex)
8. Built checkpoint.ts (git checkpoint system)
9. Added agentic tool-calling loop (callModelAgentic) to server.ts
10. Added /api/file/read, /api/file/write, /api/file/list endpoints
11. Added /api/checkpoint, /api/checkpoint/rollback, /api/checkpoints endpoints
12. Fought iCloud for 2 hours — project moved to ~/crucible-local

## iCloud Warning
NEVER put this project in ~/Desktop or ~/Documents if iCloud Desktop/Documents sync is enabled.
iCloud adds com.apple.macl xattr to files which causes tsx to hang indefinitely.
Always work from ~/crucible-local or another non-iCloud path.

## Stack
- Frontend: src/App.tsx (~1510 lines)
- Backend: server.ts (~870 lines)
- Model registry: modelRegistry.ts (server-side)
- Browser-safe model data: src/modelData.ts
- Engine: src/CrucibleEngine/ (NEEDS RECONSTRUCTION — see below)
- Electron entry: electron.cjs

## FIRST THING NEXT SESSION: Reconstruct src/CrucibleEngine/

All 8 files need to be recreated. The src/CrucibleEngine/ folder is empty.
node_modules is installed. server.ts imports from these files so server won't start until they exist.

### Files to reconstruct in order:

#### 1. src/CrucibleEngine/types.ts
Key contents:
- PromptType = 'coding' | 'reasoning' | 'creative' | 'factual' | 'math' | 'general'
- ScoringInput interface with contract field
- ScoringConfig interface
- DEFAULT_SCORING_CONFIG = { pass: 0.55, weights: { contract: 0.5, functional: 0.3, novelty: 0.1, knowledge: 0.1 } }
- InterfaceContract interface with systemPrompt, requirements[], antiPatterns[], successCriteria[]

#### 2. src/CrucibleEngine/tokenizer.ts
- Simple tokenizer that extracts architectural pattern tokens
- Used by scoring engine for Jaccard similarity

#### 3. src/CrucibleEngine/knowledge-base.ts
- Empty file (was empty before session 5)

#### 4. src/CrucibleEngine/contract-generator.ts
- generateContract(promptType, message) -> InterfaceContract
- Generates system prompt and requirements based on prompt type

#### 5. src/CrucibleEngine/scoring-engine.ts
- evaluateIteration(input, config, layer) -> { score, critiqueText }
- computeContractScore() — 50% of composite score
- Composite: contract 50%, functional 30%, novelty 10%, knowledge 10%

#### 6. src/CrucibleEngine/error-intelligence.ts
- Error pattern detection and remediation hints

#### 7. src/CrucibleEngine/sandbox.ts
- Python sandbox for code execution
- prewarmPython() called on server start

#### 8. src/CrucibleEngine/rag-context.ts (NEW this session)
- buildIndex(rootPath) — walks file tree, stores index
- queryIndex(prompt, topK=3) — finds relevant files for a prompt
- getIndexStats() — returns file count and root path
- INDEX_FILE = .crucible-index.json
- INDEXABLE_EXTENSIONS = .ts .tsx .js .jsx .py .json .md
- SKIP_DIRS = node_modules .git dist build .next coverage

#### 9. src/CrucibleEngine/checkpoint.ts (NEW this session)
- createCheckpoint(projectPath, message) -> Checkpoint
- rollbackToCheckpoint(hash, projectPath) -> boolean
- getCheckpoints(projectPath?) -> Checkpoint[]
- ensureGitRepo(projectPath) — inits git if not present
- Auto-commits before writes, stores log in .crucible-checkpoints.json

#### 10. src/CrucibleEngine/index.ts
- Exports: evaluateIteration, DEFAULT_SCORING_CONFIG, generateContract, getAspectContext
- getAspectContext(modelId, promptType, fit, slotIndex) -> string

## server.ts Key Additions This Session

### Imports added (lines 15-16):

import { buildIndex, queryIndex, getIndexStats } from './src/CrucibleEngine/rag-context'
import { createCheckpoint, rollbackToCheckpoint, getCheckpoints, ensureGitRepo } from './src/CrucibleEngine/checkpoint'

Note: These are commented out right now because CrucibleEngine is empty. Uncomment after reconstruction.

### Agentic loop (line ~128):
- TOOL_SYSTEM_ADDON — injected into system prompt, tells models how to use file tools
- extractToolCall(text) — detects <tool>read_file</tool><path>...</path> pattern
- executeToolCall(tool, path) — reads file or lists directory
- callModelAgentic(model, messages, maxIterations=3) — wraps callModel with tool loop
- Used in remediation pass (line ~547)

### Cloudflare provider (line ~199):
- Uses process.env.CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY
- Endpoint: https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}
- Returns data.result.response

### File tool endpoints:
- POST /api/file/read — reads a file by path
- POST /api/file/write — writes file, creates checkpoint first
- POST /api/file/list — lists directory contents

### Checkpoint endpoints:
- POST /api/checkpoint — creates a checkpoint
- POST /api/checkpoint/rollback — rolls back to a hash
- GET /api/checkpoints — lists checkpoints

### RAG injection (line ~454):
- queryIndex(message) called before each model in Stage 1
- Injects top 3 relevant files into system prompt

## modelRegistry.ts Key Changes
- Provider type union now includes 'huggingface' | 'cloudflare'
- Mistral 7B HF removed (novita router doesn't support it)
- 4 Cloudflare models added:
  - cloudflare/@cf/meta/llama-3.1-8b-instruct (fast)
  - cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast (standard)
  - cloudflare/@cf/mistral/mistral-7b-instruct-v0.1 (fast)
  - cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct (standard)

## src/modelData.ts (needs reconstruction)
Same 4 CF models plus all existing models. All free: true (lowercase).
CF models use provider: 'cloudflare'.

## .env.local (needs recreation)

VITE_HF_API_KEY=<huggingface token>
VITE_GEMINI_API_KEY=<gemini key>
GROQ_API_KEY=<groq key>
MISTRAL_API_KEY=<mistral key>
OPENROUTER_API_KEY=<openrouter key>
CLOUDFLARE_ACCOUNT_ID=<cf account id>
CLOUDFLARE_API_KEY=<cf api token>

## Missing Frontend Files (need reconstruction)
- src/modelData.ts — MODEL_REGISTRY array, ModelEntry interface, all models
- src/main.tsx — standard Vite/React entry point, ~10 lines
- src/App.css — minimal styles
- src/index.css — global styles
- src/CrucibleMark.tsx — animated logo component
- src/assets/ — static assets (logos etc)

## Known Issues Remaining
- Timeout storm on OpenRouter models (GPT OSS 120B, Nemotron)
- Groq daily 100k TPD limit on Llama 3.3 70B
- CrucibleEngine files need reconstruction before server starts
- Agentic file tool not yet wired into Stage 1 streaming (only in remediation)
- Dynamic UI (code panel) not yet built
- Project memory / project detection not yet built

## Vision Reminder
Vibe coding platform. Models autonomously navigate codebase, write and fix code, checkpoint before every write. UI adapts — code panel expands when code is returned, collapses otherwise. No mode switching required from user.

## Workflow Rules
- Never paste full files
- Always sed -n 'X,Yp' to extract before editing
- All edits via Python scripts written to /tmp/ and run with python3
- Pattern: cat > /tmp/fix.py << 'PYEOF' … PYEOF then python3 /tmp/fix.py
- Verify every patch output before moving on
- grep -n before editing to confirm line numbers
- Use Claude Code for agentic tasks where possible
