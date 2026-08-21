import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import * as costAdaptive from 'dsh-cost-adaptive'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<{ context: Context; root: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cost-adaptive-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['dsh-cost-adaptive', costAdaptive],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { context, root }
}

describe('real Loader composition', () => {
  it('loads the shipped cost-adaptive plugin row with a configured stats path', async () => {
    const statsDir = await mkdtemp(join(tmpdir(), 'dsh-cost-adaptive-stats-'))
    const { context: loaded } = await loadYaml([
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: 'dsh-cost-adaptive'",
      '  config:',
      '    statsPath: ' + JSON.stringify(join(statsDir, 'stats.json')),
      '    minCalls: 1',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    // The plugin registered its system-prompt section under the Loader boot.
    const assembled = await loaded.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    expect(assembled.sections.map(section => section.name)).toContain('cost-adaptive:guidance')
  })

  it('rejects an invalid scalar after Schemastery normalization', async () => {
    // The exported schema is the same validation the Loader applies to plugin
    // rows; exercise it directly for the rejection message. Schemastery's
    // object schema tolerates unknown keys but rejects invalid scalar values.
    const result = await costAdaptive.Config['~standard'].validate({ minCalls: 0 })
    expect(result.issues).toBeDefined()
    expect(result.issues?.[0]?.message).toMatch(/minCalls expected number >= 1/)
    // A valid partial config validates cleanly and keeps its value.
    const valid = await costAdaptive.Config['~standard'].validate({ minCalls: 7 })
    expect(valid.issues).toBeUndefined()
    expect((valid as { value: { minCalls: number } }).value.minCalls).toBe(7)
  })
})
