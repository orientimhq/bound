/**
 * The Guard's accounts as the SDK reads them: the owner's policy, the agent's grant, and the token
 * accounts a swap touches. The layouts follow programs/guard/src/lib.rs byte for byte.
 */
import { getAddressDecoder } from '@solana/kit';
import type { Address } from '@solana/kit';
import { MAX_FEEDS, MAX_LIMITS, MAX_OUTPUTS, MAX_PROGRAMS, MAX_VERIFIERS } from './instructions.ts';

const ZERO = '11111111111111111111111111111111' as Address;
const addresses = getAddressDecoder();

class Reader {
  at = 0;
  private readonly data: Uint8Array;
  private readonly view: DataView;
  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8() { return this.data[this.at++]; }
  u16() { const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u64() { const v = this.view.getBigUint64(this.at, true); this.at += 8; return v; }
  i64() { const v = this.view.getBigInt64(this.at, true); this.at += 8; return v; }
  key() { const v = addresses.decode(this.data.subarray(this.at, this.at + 32)); this.at += 32; return v; }
  bytes(n: number) { const v = this.data.slice(this.at, this.at + n); this.at += n; return v; }
}

export type PolicyState = {
  paused: boolean;
  threshold: number;
  owner: Address;
  verifiers: Address[];
  programs: Address[];
};

export function decodePolicy(data: Uint8Array): PolicyState {
  if (data[0] !== 1) throw new Error('not a Guard policy account');
  const r = new Reader(data);
  r.at = 1;
  r.u8();
  r.u8();
  const paused = r.u8() !== 0;
  const threshold = r.u8();
  const owner = r.key();
  const verifiers = Array.from({ length: MAX_VERIFIERS }, () => r.key()).filter(k => k !== ZERO);
  const programs = Array.from({ length: MAX_PROGRAMS }, () => r.key()).filter(k => k !== ZERO);
  return { paused, threshold, owner, verifiers, programs };
}

export type LimitState = { mint: Address; perSwap: bigint; perDay: bigint; usedToday: bigint; day: bigint };
export type GrantState = {
  status: number;
  expiresAt: bigint;
  owner: Address;
  agent: Address;
  limits: LimitState[];
  outputs: Address[];
  maxSlippageBps: number;
  allowUnpriced: boolean;
  /** Each priced mint and its Pyth feed id (32 bytes). */
  feeds: { mint: Address; feed: Uint8Array }[];
  maxLossPerDay: bigint;
  maxLossTotal: bigint;
  lossDay: bigint;
  lossToday: bigint;
  lossTotal: bigint;
};

export function decodeGrant(data: Uint8Array): GrantState {
  if (data[0] !== 2) throw new Error('not a Guard grant account');
  const r = new Reader(data);
  r.at = 1;
  r.u8();
  const status = r.u8();
  const expiresAt = r.i64();
  const owner = r.key();
  const agent = r.key();
  const limits = Array.from({ length: MAX_LIMITS }, () => ({ mint: r.key(), perSwap: r.u64(), perDay: r.u64(), usedToday: r.u64(), day: r.i64() }))
    .filter(l => l.mint !== ZERO);
  const outputs = Array.from({ length: MAX_OUTPUTS }, () => r.key()).filter(k => k !== ZERO);
  const maxSlippageBps = r.u16();
  const allowUnpriced = r.u8() !== 0;
  const feeds = Array.from({ length: MAX_FEEDS }, () => ({ mint: r.key(), feed: r.bytes(32) })).filter(f => f.mint !== ZERO);
  return {
    status, expiresAt, owner, agent, limits, outputs, maxSlippageBps, allowUnpriced, feeds,
    maxLossPerDay: r.u64(), maxLossTotal: r.u64(), lossDay: r.i64(), lossToday: r.u64(), lossTotal: r.u64(),
  };
}

export type TokenAccountState = { mint: Address; owner: Address; amount: bigint; delegate: Address | null; delegatedAmount: bigint };

/** An SPL token account (Token or Token-2022: the first 165 bytes are the same). */
export function decodeTokenAccount(data: Uint8Array): TokenAccountState {
  if (data.length < 165) throw new Error('not a token account');
  const r = new Reader(data);
  const mint = r.key();
  const owner = r.key();
  const amount = r.u64();
  const hasDelegate = new DataView(data.buffer, data.byteOffset).getUint32(72, true) === 1;
  r.at = 76;
  const delegate = r.key();
  r.at = 121;
  return { mint, owner, amount, delegate: hasDelegate ? delegate : null, delegatedAmount: r.u64() };
}
