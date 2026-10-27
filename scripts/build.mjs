/**
 * Build both halves of the plugin with esbuild.
 *
 * - lib/index.js : Node ESM host half. Everything is bundled except
 *   @deepseek-ai/schemastery (a real runtime dependency of the profile) and
 *   node: builtins.
 * - lib/client.js : a classic-script browser bundle. It must call
 *   window.__ModuleLoader__.load(...) at top level and may only require the
 *   shared platform module "react"; `react` stays external so the module
 *   loader resolves it from the shared table.
 *
 * The browser half must remain a single classic script: dsh serves it as a
 * plugin bundle and synchronous require of relative chunks is unsupported.
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outdir = join(root, 'lib')
mkdirSync(outdir, { recursive: true })

const common = {
  bundle: true,
  logLevel: 'info',
  legalComments: 'none',
}

await build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outdir, 'index.js'),
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/schemastery'],
})

await build({
  ...common,
  entryPoints: [join(root, 'src/client.ts')],
  outfile: join(outdir, 'client.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  external: ['react'],
})

const client = readFileSync(join(outdir, 'client.js'), 'utf8')
if (!client.includes('__ModuleLoader__.load')) {
  throw new Error('client bundle does not call window.__ModuleLoader__.load')
}
// The factory receives the loader's `require` under whatever local parameter
// name the source uses; accept both spellings.
if (!/(?:require|req)\(["']react["']\)/u.test(client)) {
  throw new Error('client bundle does not require the shared "react" module')
}
console.log('build ok: lib/index.js, lib/client.js')
