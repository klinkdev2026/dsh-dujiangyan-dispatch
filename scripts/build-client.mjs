// Build the browser half (lib/client.js) in the host's module format: a lazy CJS
// factory registered with window.__ModuleLoader__ under the package name.
// Host-provided modules stay external (packages/client/web/src/platform.ts in Harness 0.2.1-rc.2).
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const external = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]
const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external,
  write: false,
  legalComments: 'none',
})
const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports;\n} });\n`
mkdirSync('lib', { recursive: true })
writeFileSync('lib/client.js', wrapped)
console.log(`lib/client.js ${(wrapped.length / 1024).toFixed(1)} KiB`)
