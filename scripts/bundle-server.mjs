// Build the packaged server bundle (server-dist/server.js) that the PACKAGED Electron app runs
// (electron.cjs → USE_BUNDLE). A source checkout runs `tsx server.ts` instead, so this bundle is
// ONLY exercised in the shipped app — which is exactly why it silently rotted: the previous
// `esbuild … --format=esm` invocation produced a bundle that threw "Dynamic require of \"fs\" is
// not supported" at startup (CJS deps like dotenv call require(), which is undefined in an ESM
// output). The fix is the canonical createRequire banner, injected via the JS API so we don't
// fight shell quoting. node-llama-cpp + its optional per-platform bindings are external (they are
// dynamically imported and guarded at runtime; bundling their cross-platform optional deps fails).
import { build } from 'esbuild'

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'server-dist/server.js',
  external: [
    'better-sqlite3',
    '@xenova/transformers',
    'electron',
    'node-llama-cpp',
    '@node-llama-cpp/*',
  ],
  // Shim the CJS globals that bundled CJS deps (dotenv, typescript, …) expect but that do not
  // exist in an ESM output: require, __filename, __dirname. Injected at module scope so esbuild's
  // per-module CJS wrappers resolve them. Without this the bundle throws at startup — the exact
  // silent-rot that froze the shipped bundle at an old build.
  banner: {
    js: [
      "import{createRequire as __crq}from'module';",
      "import{fileURLToPath as __f2p}from'url';",
      "import{dirname as __dnm}from'path';",
      "const require=__crq(import.meta.url);",
      "const __filename=__f2p(import.meta.url);",
      "const __dirname=__dnm(__filename);",
    ].join(''),
  },
  logLevel: 'info',
})
