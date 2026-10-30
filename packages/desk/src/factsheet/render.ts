/**
 * Canonical rendering for fact values, and the explorer links that let a holder
 * check any of it without trusting this desk.
 *
 * Rendering is done ONCE, here, at FactSheet build time. The T1 model is handed
 * the finished string and never the underlying number, so it has no opportunity
 * to round, re-unit, or restate a value on the way out.
 */

import type { FactValue } from './fields.js'

/** Group an integer digit string in threes without touching a float. */
function groupDigits(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return out
}

/**
 * Minor units to a display string. Truncates, never rounds: a rounded supply
 * that reads higher than the real one is a claim we did not verify.
 */
export function formatTokenAmount(
  minor: bigint,
  decimals: number,
  maxFractionDigits = 4,
): string {
  const negative = minor < 0n
  const abs = negative ? -minor : minor
  const scale = 10n ** BigInt(decimals)
  const whole = abs / scale
  const fraction = abs % scale
  let text = groupDigits(whole.toString())
  if (fraction > 0n && maxFractionDigits > 0) {
    const padded = fraction.toString().padStart(decimals, '0').slice(0, maxFractionDigits)
    const trimmed = padded.replace(/0+$/, '')
    if (trimmed.length > 0) text += '.' + trimmed
  }
  return negative ? '-' + text : text
}

export function formatUsd(usd: number): string {
  const negative = usd < 0
  const abs = Math.abs(usd)
  const fixed = abs.toFixed(2)
  const [whole = '0', fraction = '00'] = fixed.split('.')
  return `${negative ? '-' : ''}$${groupDigits(whole)}.${fraction}`
}

export function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

export function formatUnixTime(unix: number): string {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`
}

export function renderFactValue(value: FactValue): string {
  switch (value.kind) {
    case 'address':
      return value.address
    case 'address_list':
      return value.addresses.length === 0 ? 'none' : value.addresses.join(', ')
    case 'pool_id':
      return value.poolId
    case 'string':
      return value.text
    case 'integer':
      return groupDigits(Math.trunc(value.value).toString())
    case 'bps':
      return formatBpsAsPercent(value.bps)
    case 'percent':
      return `${value.pct.toFixed(1)}%`
    case 'bool':
      return value.value ? 'yes' : 'no'
    case 'token_amount':
      return `${formatTokenAmount(value.minor, value.decimals)} ${value.symbol}`
    case 'usd':
      return formatUsd(value.usd.usd)
    case 'unix_time':
      return formatUnixTime(value.unix)
    case 'duration_seconds':
      return formatDuration(value.seconds)
  }
}

// ---------------------------------------------------------------------------
// Explorer links
// ---------------------------------------------------------------------------

export interface ExplorerConfig {
  /** Shown to holders, e.g. "the chain 4663 explorer". */
  name: string
  addressUrl(address: string): string
  tokenUrl(token: string): string
  txUrl(hash: string): string
  blockUrl(hash: string): string
}

/**
 * Conventional explorer paths over a supplied base. The base is configuration,
 * not a constant: guessing an explorer host and printing it to holders is
 * exactly the kind of unverified value this desk refuses to emit.
 */
export function urlExplorer(base: string, name = 'the block explorer'): ExplorerConfig {
  const root = base.replace(/\/+$/, '')
  return {
    name,
    addressUrl: (address) => `${root}/address/${address}`,
    tokenUrl: (token) => `${root}/token/${token}`,
    txUrl: (hash) => `${root}/tx/${hash}`,
    blockUrl: (hash) => `${root}/block/${hash}`,
  }
}
