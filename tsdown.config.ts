import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { typertArtifactsPlugin } from './scripts/typert-emit.mjs'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Single-package adaptation of the harness root tsdown config: tsc emits the
 * per-module runtime and declarations into lib/types, tsdown bundles the two
 * entry points into lib/ and (on the host face) regenerates the Typert Host
 * service and Remote client artifacts that back the cost dashboard's data
 * channel.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    entry: ['src/index.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: false,
    plugins: client
      ? []
      : [
        typertPlugin({ mode: 'package', faces: ['host'] }),
        typertArtifactsPlugin(),
      ],
  }
})
