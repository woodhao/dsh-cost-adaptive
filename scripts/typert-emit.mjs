/**
 * Typert artifact emission for the flat single-package repo.
 *
 * The published `typertPlugin` from @deepseek-ai/dsh-typert-generator only
 * emits inside a workspace layout (a package nested under `packages/` below a
 * root that carries `tsconfig.host.json`). This repo is a flat single npm
 * package, so this tsdown plugin mirrors `src/` into a throwaway workspace
 * under `node_modules/.cache`, runs the real `WorkspaceTypertGenerator` there,
 * and copies the generated Host face and Remote client artifacts into `lib/`.
 * The mirror is deleted again after emission; nothing is committed.
 *
 * @module dsh-cost-adaptive/scripts/typert-emit
 */

import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The generator's validateExport contract for this package's manifest. */
const MIRROR_MANIFEST = {
  name: 'dsh-cost-adaptive',
  version: '0.1.0-rc.7',
  type: 'module',
  main: 'lib/index.js',
  types: 'lib/types/index.d.ts',
  exports: {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' },
    './invariant': { types: './lib/types/invariant.d.ts', default: './lib/invariant.js' },
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    './src/*': './src/*',
    './package.json': './package.json',
  },
  files: [
    'lib/index.js',
    'lib/invariant.js',
    'lib/typert.host.js',
    'lib/typert.host.d.ts',
    'lib/typert.remote-client.js',
    'lib/typert.remote-client.d.ts',
    'lib/types/**/*.js',
    'lib/types/**/*.d.ts',
  ],
}

/** Compiler options shared by the mirror package and its host aggregate. */
const MIRROR_COMPILER_OPTIONS = {
  target: 'es2024',
  module: 'esnext',
  moduleResolution: 'bundler',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: false,
  types: ['node'],
  noEmit: true,
}

/** Route the protocol import to its in-workspace mirror (see writeBundle). */
const PROTOCOL_PATHS_FROM_ROOT = {
  '@deepseek-ai/dsh-typert-protocol': ['./packages/dsh-typert-protocol/lib/types/index.d.ts'],
}

/** Same mapping, resolved from the package's own tsconfig location. */
const PROTOCOL_PATHS_FROM_PACKAGE = {
  '@deepseek-ai/dsh-typert-protocol': ['../../packages/dsh-typert-protocol/lib/types/index.d.ts'],
}

/**
 * Write the generator's Host/Remote artifacts into `lib/` for the package
 * whose source currently lives in `src/`. Runs once per tsdown bundle pass;
 * the mirror workspace is created and removed within this call.
 */
export function typertArtifactsPlugin() {
  return {
    name: 'dsh-typert-emit',
    writeBundle() {
      const mirror = join(repoRoot, 'node_modules', '.cache', 'dsh-typert')
      const packageDir = join(mirror, 'packages', 'dsh-cost-adaptive')
      const protocolDir = join(mirror, 'packages', 'dsh-typert-protocol')
      const srcDir = join(packageDir, 'src')
      rmSync(mirror, { recursive: true, force: true })
      mkdirSync(srcDir, { recursive: true })

      // Physical copies, not symlinks: the generator resolves real paths, so
      // linked sources would fall outside the mirror package root.
      for (const file of readdirSync(join(repoRoot, 'src')).filter(name => name.endsWith('.ts'))) {
        copyFileSync(join(repoRoot, 'src', file), join(srcDir, file))
      }
      writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(MIRROR_MANIFEST, null, 2)}\n`)
      writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { ...MIRROR_COMPILER_OPTIONS, paths: PROTOCOL_PATHS_FROM_PACKAGE },
        include: ['src'],
      }, null, 2))

      // Mirror the installed protocol as a sibling workspace package: the
      // generator recognizes its meta symbols (Remote, TypertRemoteService,
      // bindTypertRemote) by workspace registration, which node_modules
      // resolution cannot provide. The package tsconfig paths below route the
      // protocol import to this copy so every declaration lands in-registration.
      const installedProtocol = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
      mkdirSync(protocolDir, { recursive: true })
      cpSync(join(installedProtocol, 'lib'), join(protocolDir, 'lib'), { recursive: true })
      const protocolManifest = JSON.parse(readFileSync(join(installedProtocol, 'package.json'), 'utf8'))
      writeFileSync(join(protocolDir, 'package.json'), JSON.stringify({
        name: protocolManifest.name,
        version: protocolManifest.version,
        type: protocolManifest.type ?? 'module',
        types: protocolManifest.types,
        exports: protocolManifest.exports,
      }, null, 2))
      writeFileSync(join(protocolDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: MIRROR_COMPILER_OPTIONS,
        include: ['lib/types'],
      }, null, 2))
      writeFileSync(join(mirror, 'tsconfig.host.json'), JSON.stringify({
        compilerOptions: { ...MIRROR_COMPILER_OPTIONS, paths: PROTOCOL_PATHS_FROM_ROOT },
        files: [],
        references: [
          { path: './packages/dsh-cost-adaptive' },
          { path: './packages/dsh-typert-protocol' },
        ],
      }, null, 2))
      // Resolve @deepseek-ai/*, zod, and @types/* from the installed tree.
      symlinkSync(join(repoRoot, 'node_modules'), join(mirror, 'node_modules'), 'dir')

      const artifacts = new WorkspaceTypertGenerator(mirror).generate(['dsh-cost-adaptive'], ['host'])
      const lib = join(repoRoot, 'lib')
      mkdirSync(lib, { recursive: true })
      for (const artifact of artifacts) {
        writeFileSync(join(lib, `typert.${artifact.face}.js`), artifact.js)
        writeFileSync(join(lib, `typert.${artifact.face}.d.ts`), artifact.dts)
        if (artifact.remote !== undefined) {
          writeFileSync(join(lib, 'typert.remote-client.js'), artifact.remote.js)
          writeFileSync(join(lib, 'typert.remote-client.d.ts'), artifact.remote.dts)
          writeFileSync(join(lib, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
        }
      }
      rmSync(mirror, { recursive: true, force: true })
    },
  }
}
