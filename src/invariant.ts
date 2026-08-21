/**
 * Package-owned invariant companion for `dsh-cost-adaptive`.
 * @module dsh-cost-adaptive/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-cost-adaptive'

/** Cordis companion plugin name. */
export const name = 'cost-adaptive-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the cost snapshot is private to one session-event
 * listener and the statistics file; no package-owned event or snapshot is
 * published for an independent companion to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
