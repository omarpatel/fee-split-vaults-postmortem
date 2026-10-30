import { describe, expect, it } from 'vitest'
import { RpcError } from '../errors.js'
import { JsonRpcClient } from '../json-rpc.js'

type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } }

function client(replies: Record<string, Reply>): { rpc: JsonRpcClient; requests: { method: string; params: unknown[] }[] } {
  const requests: { method: string; params: unknown[] }[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
    requests.push({ method: body.method, params: body.params })
    const reply = replies[body.method] ?? { error: { code: -32601, message: `no script for ${body.method}` } }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { rpc: new JsonRpcClient({ endpointId: 'test', url: 'http://rpc.test', fetchImpl }), requests }
}

const HASH: `0x${string}` = `0x${'ab'.repeat(32)}`
const RECEIPT = {
  transactionHash: HASH,
  status: '0x1',
  blockNumber: '0x10',
  blockHash: `0x${'cd'.repeat(32)}`,
  gasUsed: '0x5208',
  logs: [],
}

describe('JsonRpcClient write side', () => {
  it('parses a receipt and refuses a status that is neither 0 nor 1', async () => {
    const ok = client({ eth_getTransactionReceipt: { result: RECEIPT } })
    expect(await ok.rpc.getTransactionReceipt(HASH)).toEqual({
      transactionHash: HASH,
      status: 1,
      blockNumber: 16n,
      blockHash: `0x${'cd'.repeat(32)}`,
      gasUsed: 21_000n,
      logs: [],
    })
    expect(await client({ eth_getTransactionReceipt: { result: null } }).rpc.getTransactionReceipt(HASH)).toBeNull()

    const odd = client({ eth_getTransactionReceipt: { result: { ...RECEIPT, status: '0x2' } } })
    await expect(odd.rpc.getTransactionReceipt(HASH)).rejects.toBeInstanceOf(RpcError)
  })

  it('refuses a base fee from a block that carries none rather than defaulting it', async () => {
    const legacy = client({ eth_getBlockByNumber: { result: { number: '0x1', hash: HASH, parentHash: HASH, timestamp: '0x1' } } })
    await expect(legacy.rpc.getBaseFeePerGas('latest')).rejects.toBeInstanceOf(RpcError)

    const modern = client({ eth_getBlockByNumber: { result: { baseFeePerGas: '0x3b9aca00' } } })
    expect(await modern.rpc.getBaseFeePerGas('latest')).toBe(1_000_000_000n)
  })

  it('surfaces revert data from a node error so the custom error selector is readable', async () => {
    const { rpc } = client({
      eth_estimateGas: { error: { code: 3, message: 'execution reverted', data: '0x4a5d8bd6' } },
    })
    await expect(
      rpc.estimateGas({ from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`, data: '0x' }),
    ).rejects.toThrow(/revert data 0x4a5d8bd6/)
  })

  it('sends the nonce tag and the pending block for estimation as given', async () => {
    const { rpc, requests } = client({
      eth_getTransactionCount: { result: '0x7' },
      eth_estimateGas: { result: '0x186a0' },
      eth_sendRawTransaction: { result: HASH },
    })
    expect(await rpc.getTransactionCount(`0x${'11'.repeat(20)}`, 'pending')).toBe(7n)
    expect(await rpc.estimateGas({ from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`, data: '0x', value: 5n })).toBe(
      100_000n,
    )
    expect(await rpc.sendRawTransaction('0x02c0')).toBe(HASH)
    expect(requests.map((r) => r.params)).toEqual([
      [`0x${'11'.repeat(20)}`, 'pending'],
      [{ from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`, data: '0x', value: '0x5' }, 'pending'],
      ['0x02c0'],
    ])
  })
})
