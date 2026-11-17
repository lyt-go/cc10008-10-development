/**
 * 验收脚本入口：用已安装的 esbuild 把 TypeScript 打成一个临时 ESM 文件再执行。
 * 这样不需要额外安装 tsx / vitest，`npm run verify:label` 在现有依赖下即可复现。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const workDir = await mkdtemp(join(tmpdir(), 'feature-label-verify-'))
const outfile = join(workDir, 'verify.mjs')

try {
  await build({
    entryPoints: [resolve(root, 'scripts/verify-feature-label.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
