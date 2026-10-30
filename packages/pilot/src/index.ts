/**
 * @fee-split-vaults/pilot - the Section 9 experiment harness.
 *
 * This package answers one question and refuses to answer it loosely: does a
 * staffed desk raise a coin's quote-denominated Venue-pool creator fees? Every
 * other package in this repository is architecture around an affirmative answer
 * here, so the harness is built to make a negative answer easy to reach and
 * impossible to talk around.
 *
 * The pilot is FREE. No fee take, no budget, no vault, no contract beyond a
 * one-page agreement. It randomizes WHEN a free service is provided, never
 * whether: every coin has full coverage for the second half of the trial, and
 * the assignment generator asserts it.
 */

export * from './types.js'
export * from './hash.js'
export * from './assignment.js'
export * from './notice.js'
export * from './measurement.js'
export * from './stats.js'
export * from './power.js'
export * from './prereg.js'
export * from './document.js'
export * from './exclusions.js'
export * from './analysis.js'
export * from './power-simulation.js'
export * from './eti.js'
export * from './testing/synthetic.js'
