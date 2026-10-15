/**
 * A wallet that changes the message after Orientim verified it (AUDIT section 10, section 0h).
 * Phantom documents that it may add Lighthouse assertions; wallets may also raise the priority fee.
 * The real pipeline prepares a swap against the fakes, a simulated wallet alters and signs it, and
 * the countersign step runs (as a browser wallet's flow would, with assertions accepted): it must
 * stop before E signs, and send nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  address, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getTransactionDecoder, getTransactionEncoder, partiallySignTransaction,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { LIGHTHOUSE_PROGRAM } from '@orientim/certificate';
import { sendAndConfirm } from '@orientimhq/swap/solana';
import { countersignProtectedSwap, DEFAULT_SETTINGS, OrientimError, prepareProtectedSwap } from '../src/swap.ts';
import type { Countersignable } from '../src/swap.ts';
import { BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, USDC } from './fakes.ts';
import type { Account } from './fakes.ts';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
// A stand-in for the Lighthouse program: what matters is that an instruction is appended.
const ASSERTION_PROGRAM = address('Sysvar1nstructions1111111111111111111111111');

/** `priority`: the price recent fees ask for, in micro-lamports per unit; far above the cap, the cap is used. */
async function prepared(priority?: bigint) {
  const owner = await generateKeyPairSigner();
  const E = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
  ]);
  for (const [key, account] of await fundedAccounts(owner.address, USDC)) accounts.set(key, account);
  expect(accounts.has(await ataOf(owner.address, USDC))).toBe(true);
  const sent: string[] = [];
  // A sent transaction lands at once, so the happy path settles without waiting.
  const rpc = fakeRpc(accounts, { sent, landOnSend: true, statuses: new Map() });
  const swap = await prepareProtectedSwap(
    {
      rpc, jupiter: fakeJupiter(), settings: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM },
      ...(priority ? { priorityFee: async () => priority } : {}),
    },
    {
      owner: owner.address, ephemeral: E, inputMint: USDC, outputMint: BONK, amountIn: 1_000_000n,
      inputDecimals: DECIMALS[USDC], outputDecimals: DECIMALS[BONK], version: 0,
    },
  );
  return { owner, E, rpc, sent, swap };
}

type Compiled = {
  header: { numReadonlyNonSignerAccounts: number };
  staticAccounts: Address[];
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
};

/** Re-encodes the message after `change` edits its compiled form, as a wallet would. */
function alter(tx: Transaction, change: (m: Compiled) => void): Transaction {
  const m = structuredClone(getCompiledTransactionMessageDecoder().decode(tx.messageBytes)) as unknown as Compiled;
  change(m);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(m as never);
  return { ...tx, messageBytes } as Transaction;
}

/** Phantom's documented behaviour: an assertion appended after the swap (AssertSysvarClock: no accounts). */
const appendAssertion = (m: Compiled) => {
  const before = m.staticAccounts.length;
  m.staticAccounts.push(ASSERTION_PROGRAM);
  m.header.numReadonlyNonSignerAccounts++;
  // Accounts from lookup tables are numbered after the static ones, so they move up by one.
  for (const ix of m.instructions) {
    if (ix.programAddressIndex >= before) ix.programAddressIndex++;
    ix.accountIndices = ix.accountIndices?.map(i => (i >= before ? i + 1 : i));
  }
  m.instructions.push({ programAddressIndex: before, data: new Uint8Array([15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) });
};

/** A wallet raising the priority fee: SetComputeUnitPrice (3) with a higher price. */
const raisePriorityFee = (m: Compiled) => {
  const budget = m.staticAccounts.indexOf(address(COMPUTE_BUDGET));
  const ix = m.instructions.find(i => i.programAddressIndex === budget && i.data?.[0] === 3);
  expect(ix).toBeDefined();
  const data = Uint8Array.from(ix!.data!);
  new DataView(data.buffer).setBigUint64(1, new DataView(data.buffer).getBigUint64(1, true) * 10n + 1n, true);
  ix!.data = data;
};

const encode = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));

/** The wallet signs whatever message it chose to sign, leaving E's slot empty. */
async function walletSigns(owner: KeyPairSigner, tx: Transaction) {
  return encode(await partiallySignTransaction([owner.keyPair], tx));
}

/** Signs last as E, then sends and settles: a wallet-return flow (the agent API itself accepts no assertions). */
async function finalizeProtectedSwap(args: { rpc: Parameters<typeof countersignProtectedSwap>[0]['rpc']; prepared: Countersignable; walletSignedBytes: Uint8Array; ephemeral: KeyPairSigner; acceptAssertions?: boolean }) {
  const signed = await countersignProtectedSwap(args);
  return { ...await sendAndConfirm({ rpc: args.rpc, transaction: signed, lastValidBlockHeight: args.prepared.lifetime.lastValidBlockHeight }), sent: signed };
}

async function finalize(p: Awaited<ReturnType<typeof prepared>>, walletSignedBytes: Uint8Array, acceptAssertions = false) {
  return finalizeProtectedSwap({ rpc: p.rpc, prepared: p.swap, walletSignedBytes, ephemeral: p.E, acceptAssertions });
}

/** Adds `key` as a static account in the read-only or writable non-signer group; returns its index. */
function addAccount(m: Compiled & { header: { numSignerAccounts: number; numReadonlySignerAccounts: number } }, key: Address, writable: boolean): number {
  const at = writable ? m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts : m.staticAccounts.length;
  m.staticAccounts.splice(at, 0, key);
  if (!writable) m.header.numReadonlyNonSignerAccounts++;
  // Indexes at or after the insertion move up by one: static accounts after it, and lookup-table accounts.
  for (const ix of m.instructions) {
    if (ix.programAddressIndex >= at) ix.programAddressIndex++;
    ix.accountIndices = ix.accountIndices?.map(i => (i >= at ? i + 1 : i));
  }
  return at;
}

/** Phantom's Lighthouse: an instruction of kind `kind` (9: AssertTokenAccount) on the wallet's input account. */
const lighthouse = (kind: number, owner: Address, extra?: { key: Address; writable: boolean }) => async (tx: Transaction) => {
  const input = await ataOf(owner, USDC);
  return alter(tx, m => {
    const mm = m as Parameters<typeof addAccount>[0];
    const program = addAccount(mm, LIGHTHOUSE_PROGRAM, false);
    const accounts = [m.staticAccounts.indexOf(input)];
    if (extra) accounts.push(addAccount(mm, extra.key, extra.writable));
    m.instructions.push({ programAddressIndex: m.staticAccounts.indexOf(LIGHTHOUSE_PROGRAM), accountIndices: accounts, data: new Uint8Array([kind, 0, 1, 2, 3]) });
    expect(program).toBeGreaterThan(0);
  });
};

/** A wallet raising the compute limit (SetComputeUnitLimit, 2) by `by` units. */
const raiseComputeLimit = (by: number) => (m: Compiled) => {
  const budget = m.staticAccounts.indexOf(address(COMPUTE_BUDGET));
  const ix = m.instructions.find(i => i.programAddressIndex === budget && i.data?.[0] === 2);
  expect(ix).toBeDefined();
  const data = Uint8Array.from(ix!.data!);
  const view = new DataView(data.buffer);
  view.setUint32(1, view.getUint32(1, true) + by, true);
  ix!.data = data;
};

async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(OrientimError);
  return e as OrientimError;
}

describe('a wallet that alters the message after verification (AUDIT section 10)', () => {
  it('the unaltered message, signed by W with E left empty, is countersigned and sent once', async () => {
    const p = await prepared();
    const result = await finalize(p, await walletSigns(p.owner, p.swap.transaction));
    expect(result.status).toBe('confirmed');
    expect(p.sent).toHaveLength(1);
    const wire = getTransactionDecoder().decode(Buffer.from(p.sent[0], 'base64'));
    expect([...wire.messageBytes]).toEqual([...p.swap.transaction.messageBytes]);
    expect(wire.signatures[p.E.address]).toBeTruthy();
    expect(wire.signatures[p.owner.address]).toBeTruthy();
  });

  it('an appended Lighthouse-style assertion is refused before E signs, and nothing is sent', async () => {
    const p = await prepared();
    const altered = alter(p.swap.transaction, appendAssertion);
    // The alteration is well formed: it still decodes, with one more instruction.
    const count = (t: Transaction) => (getCompiledTransactionMessageDecoder().decode(t.messageBytes) as unknown as Compiled).instructions.length;
    expect(count(altered)).toBe(count(p.swap.transaction) + 1);

    const e = await refusal(finalize(p, await walletSigns(p.owner, altered)));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail)).toEqual([
      'the wallet changed the transaction message',
      "the wallet's signature does not match the verified message",
    ]);
    expect(p.sent).toEqual([]);
  });

  it('a raised priority fee is refused the same way', async () => {
    const p = await prepared();
    const e = await refusal(finalize(p, await walletSigns(p.owner, alter(p.swap.transaction, raisePriorityFee))));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail)).toContain('the wallet changed the transaction message');
    expect(p.sent).toEqual([]);
  });

  it('a wallet that signs its altered message but returns the original bytes is refused too', async () => {
    const p = await prepared();
    const signedAltered = await partiallySignTransaction([p.owner.keyPair], alter(p.swap.transaction, appendAssertion));
    const disguised = { ...p.swap.transaction, signatures: { ...p.swap.transaction.signatures, ...signedAltered.signatures } } as Transaction;
    const e = await refusal(finalize(p, encode(disguised)));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail)).toEqual(["the wallet's signature does not match the verified message"]);
    expect(p.sent).toEqual([]);
  });
});

describe("Phantom's Lighthouse assertions, on the page", () => {
  it('an assertion added by the wallet is accepted: E signs the message the wallet signed, sent once', async () => {
    const p = await prepared();
    expect(p.swap.transaction.messageBytes.length).toBeGreaterThan(0);
    const altered = await lighthouse(9, p.owner.address)(p.swap.transaction);
    const result = await finalize(p, await walletSigns(p.owner, altered), true);
    expect(result.status).toBe('confirmed');
    expect(p.sent).toHaveLength(1);
    const wire = getTransactionDecoder().decode(Buffer.from(p.sent[0], 'base64'));
    expect([...wire.messageBytes]).toEqual([...altered.messageBytes]);
    expect(wire.signatures[p.E.address]).toBeTruthy();
  });

  it('with a new read-only account and a compute limit raised a little, it is still accepted', async () => {
    const p = await prepared();
    const readOnly = (await generateKeyPairSigner()).address;
    const withAccount = await lighthouse(10, p.owner.address, { key: readOnly, writable: false })(p.swap.transaction);
    const altered = alter(withAccount, raiseComputeLimit(20_000));
    const result = await finalize(p, await walletSigns(p.owner, altered), true);
    expect(result.status).toBe('confirmed');
  });

  it('with a lookup table of its own for what it asserts, read on chain, it is still accepted', async () => {
    const p = await prepared();
    const table = (await generateKeyPairSigner()).address;
    const asserted = (await generateKeyPairSigner()).address;
    const altered = alter(await lighthouse(9, p.owner.address)(p.swap.transaction), m => {
      const mm = m as Compiled & { addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[] };
      const loaded = (mm.addressTableLookups ?? []).reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
      mm.addressTableLookups = [...(mm.addressTableLookups ?? []), { lookupTableAddress: table, writableIndexes: [], readonlyIndexes: [0] }];
      mm.instructions[mm.instructions.length - 1]!.accountIndices!.push(m.staticAccounts.length + loaded);
    });
    // The table as the chain answers for it (jsonParsed), the rest as before.
    const base = p.rpc as unknown as { getMultipleAccounts: (a: string[], c?: { encoding?: string }) => { send: () => Promise<{ value: unknown[] }> } };
    const rpc = {
      ...p.rpc,
      getMultipleAccounts: (addresses: string[], config?: { encoding?: string }) => (config?.encoding === 'jsonParsed' && addresses.includes(table)
        ? {
          send: async () => ({
            context: { slot: 300_000_000n },
            value: addresses.map(a => (a === table
              ? {
                owner: 'AddressLookupTab1e1111111111111111111111111', lamports: 2_000_000n, executable: false, space: 88n,
                data: { program: 'address-lookup-table', space: 88n, parsed: { type: 'lookupTable', info: { addresses: [asserted], authority: null, deactivationSlot: '18446744073709551615', lastExtendedSlot: '1', lastExtendedSlotStartIndex: 0 } } },
              }
              : null)),
          }),
        }
        : base.getMultipleAccounts(addresses, config)),
    } as unknown as typeof p.rpc;
    const result = await finalizeProtectedSwap({ rpc, prepared: p.swap, walletSignedBytes: await walletSigns(p.owner, altered), ephemeral: p.E, acceptAssertions: true });
    expect(result.status).toBe('confirmed');
    expect(p.sent).toHaveLength(1);
    // Without the table on chain, the same message is refused and nothing is sent.
    const q = await prepared();
    const again = alter(await lighthouse(9, q.owner.address)(q.swap.transaction), m => {
      const mm = m as Compiled & { addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[] };
      mm.addressTableLookups = [...(mm.addressTableLookups ?? []), { lookupTableAddress: table, writableIndexes: [], readonlyIndexes: [0] }];
    });
    expect(await refusal(finalize(q, await walletSigns(q.owner, again), true))).toBeTruthy();
    expect(q.sent).toHaveLength(0);
  });

  it('the agent API path, which does not accept them, still refuses the same message', async () => {
    const p = await prepared();
    const altered = await lighthouse(9, p.owner.address)(p.swap.transaction);
    const e = await refusal(finalize(p, await walletSigns(p.owner, altered)));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(p.sent).toEqual([]);
  });

  const refused: [string, (p: Awaited<ReturnType<typeof prepared>>) => Promise<Transaction>, string][] = [
    ['a Lighthouse memory write (0)', p => lighthouse(0, p.owner.address)(p.swap.transaction), 'the wallet added a Lighthouse instruction that is not an assertion'],
    ['a Lighthouse memory close (1)', p => lighthouse(1, p.owner.address)(p.swap.transaction), 'the wallet added a Lighthouse instruction that is not an assertion'],
    ['a new writable account', async p => lighthouse(9, p.owner.address, { key: (await generateKeyPairSigner()).address, writable: true })(p.swap.transaction), 'an added account is writable or a signer'],
    ['a raised priority fee beside the assertion', async p => alter(await lighthouse(9, p.owner.address)(p.swap.transaction), raisePriorityFee), 'the wallet changed an instruction'],
    ['a compute limit raised too far', async p => alter(await lighthouse(9, p.owner.address)(p.swap.transaction), raiseComputeLimit(60_000)), 'the wallet changed the compute limit'],
    ['an instruction of another program', p => Promise.resolve(alter(p.swap.transaction, appendAssertion)), 'the wallet changed an instruction'],
  ];
  it('with the priority price at its cap, a compute limit raised as far as allowed still fits the fee limit', async () => {
    // A busy network: the price is capped, with room left for the compute a wallet may add.
    const p = await prepared(100_000_000n);
    expect(p.swap.priorityFeeCapped).toBe(true);
    const altered = alter(await lighthouse(9, p.owner.address)(p.swap.transaction), raiseComputeLimit(50_000));
    const result = await finalize(p, await walletSigns(p.owner, altered), true);
    expect(result.status).toBe('confirmed');
    // What was sent is the message the wallet signed, so a failure is read against its instructions.
    expect([...result.sent.messageBytes]).toEqual([...altered.messageBytes]);
  });

  it('a raised compute limit whose fee goes above the verified limit is refused, and nothing is sent', async () => {
    const p = await prepared(100_000_000n);
    const altered = alter(await lighthouse(9, p.owner.address)(p.swap.transaction), raiseComputeLimit(50_000));
    // The same message held to a lower limit than the one it was built for.
    const tighter = { ...p, swap: { ...p.swap, policy: { ...p.swap.policy, maxNetworkFeeLamports: p.swap.networkFeeLamports } } };
    const e = await refusal(finalize(tighter, await walletSigns(p.owner, altered), true));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail).join()).toContain(`above ${p.swap.networkFeeLamports}`);
    expect(p.sent).toEqual([]);
  });

  for (const [what, change, detail] of refused) {
    it(`${what} is refused, and nothing is sent`, async () => {
      const p = await prepared();
      const e = await refusal(finalize(p, await walletSigns(p.owner, await change(p)), true));
      expect(e.code).toBe('wallet-changed-transaction');
      expect(e.violations.map(v => v.detail)).toContain(detail);
      expect(p.sent).toEqual([]);
    });
  }
});
