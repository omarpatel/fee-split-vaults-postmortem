/**
 * @fee-split-vaults/fleet - the composition root.
 *
 * Every other package in this repository is a capability. This one is the
 * assembly: it turns a list of coins, a set of credentials and a clock into
 * running agent teams, and it is the only place that decides what is real in a
 * given process. Two things follow from that, and both are load-bearing:
 *
 *   IT NAMES ITS FAKES. A dependency with no credential is substituted, and the
 *   substitution is recorded - in a startup banner, and in every run record the
 *   process writes. A run served by fakes cannot be mistaken for a real one
 *   later, by anyone, including us.
 *   IT HOLDS NO POLICY. Every rule about what a coin's team may do lives in the
 *   packages it wires together. Nothing here decides a tier, a spend, or a post;
 *   this package only decides which implementation answers the question.
 *
 * ports.ts is deliberately NOT re-exported from this barrel: it is the module
 * OPS_PORTS_MODULE loads, it has side effects on import order, and it is
 * addressed as `@fee-split-vaults/fleet/ports`.
 */

export * from './coins.js'
export * from './directory-pg.js'
export * from './credentials.js'
export * from './fixtures.js'
export * from './sandbox.js'
export * from './adapters.js'
export * from './store.js'
export * from './runner.js'
export * from './bootstrap.js'
