/**
 * The owner's one set-up: the policy, the agent's grant, the accounts every swap needs (the agent's
 * hopper and the treasury's account for each input mint) and the approval of the Guard's authority over
 * each input account, for a budget. It is larger than one Solana transaction (1232 bytes), so
 * `ownerSetupTransactions` packs it into as few as fit, which the owner signs together in one wallet
 * approval (signAllTransactions) and sends in order. `sendOwnerSetup` does all of it, and can be run
 * again after a set-up that stopped part way: it reads what exists and sends only what is missing.
 */
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getTransactionEncoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, Transaction } from '@solana/kit';
import {
  ATA_PROGRAM, ataOf, authorityOf, grantOf, initPolicy, policyOf, setGrant, SYSTEM_PROGRAM, TOKEN_PROGRAM, TREASURY,
} from './instructions.ts';
import type { GrantRules } from './instructions.ts';
import { decodeTokenAccount } from './accounts.ts';
import type { Chain } from './client.ts';

/** Creates `owner`'s associated account for `mint` if it is missing, paid by `payer`. */
export const createAtaIdempotent = (payer: Address, ata: Address, owner: Address, mint: Address, tokenProgram: Address): Instruction => ({
  programAddress: ATA_PROGRAM,
  accounts: [
    { address: payer, role: AccountRole.WRITABLE_SIGNER }, { address: ata, role: AccountRole.WRITABLE },
    { address: owner, role: AccountRole.READONLY }, { address: mint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }, { address: tokenProgram, role: AccountRole.READONLY },
  ],
  data: Uint8Array.of(1),
});

/** SPL Approve: `delegate` may move up to `amount` from `source`, until the owner revokes it. */
export const approve = (source: Address, delegate: Address, owner: Address, amount: bigint, tokenProgram: Address): Instruction => {
  const data = new Uint8Array(9);
  data[0] = 4;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return {
    programAddress: tokenProgram,
    accounts: [
      { address: source, role: AccountRole.WRITABLE }, { address: delegate, role: AccountRole.READONLY },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
};

/** SPL Revoke: the end of every approval of `source`; the owner's way to stop all agents without Orientim. */
export const revoke = (source: Address, owner: Address, tokenProgram: Address): Instruction => ({
  programAddress: tokenProgram,
  accounts: [{ address: source, role: AccountRole.WRITABLE }, { address: owner, role: AccountRole.READONLY_SIGNER }],
  data: Uint8Array.of(5),
});

export type OwnerSetup = {
  program: Address;
  owner: Address;
  agent: Address;
  /** Orientim's verifier, and optionally the owner's own (then `threshold` may be 2). */
  verifiers: Address[];
  threshold?: number;
  /** Swap programs allowed between Pull and Settle (Jupiter's by default). */
  programs: Address[];
  rules: GrantRules;
  /** The budget the owner approves over each input mint, in its base units. */
  budgets: { mint: Address; amount: bigint; tokenProgram?: Address }[];
  /** Whether the policy exists already (then only the grant and approvals are set). */
  policyExists?: boolean;
  /** The token program of an output mint that is not the classic Token program's. */
  outputTokenPrograms?: Record<Address, Address>;
  /** SOL for the agent's network fees, sent with the set-up (e.g. 10_000_000n, 0.01 SOL). */
  agentLamports?: bigint;
  /**
   * What is already on chain and is not set again: the grant, accounts that exist, input accounts
   * whose approval is already the Guard's, and whether the agent was funded. `sendOwnerSetup` fills it.
   */
  existing?: { grant?: boolean; accounts?: Address[]; approved?: Address[]; funded?: boolean };
};

/** System transfer: `lamports` from `from` to `to`. */
export const transferSol = (from: Address, to: Address, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  data[0] = 2;
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [{ address: from, role: AccountRole.WRITABLE_SIGNER }, { address: to, role: AccountRole.WRITABLE }],
    data,
  };
};

export async function ownerSetup(s: OwnerSetup): Promise<Instruction[]> {
  const policy = await policyOf(s.program, s.owner);
  const authority = await authorityOf(s.program, s.owner);
  const ixs: Instruction[] = [];
  const has = (a: Address) => !!s.existing?.accounts?.includes(a);
  const account = async (holder: Address, mint: Address, tokenProgram: Address) => {
    const ata = await ataOf(holder, mint, tokenProgram);
    if (!has(ata)) ixs.push(createAtaIdempotent(s.owner, ata, holder, mint, tokenProgram));
  };
  if (!s.policyExists) ixs.push(initPolicy({ program: s.program, owner: s.owner, policy, verifiers: s.verifiers, programs: s.programs, threshold: s.threshold }));
  if (!s.existing?.grant) ixs.push(setGrant({ program: s.program, owner: s.owner, policy, grant: await grantOf(s.program, s.owner, s.agent), agent: s.agent, rules: s.rules }));
  for (const b of s.budgets) {
    const tokenProgram = b.tokenProgram ?? TOKEN_PROGRAM;
    await account(s.agent, b.mint, tokenProgram);
    await account(TREASURY, b.mint, tokenProgram);
    const source = await ataOf(s.owner, b.mint, tokenProgram);
    if (!s.existing?.approved?.includes(source)) ixs.push(approve(source, authority, s.owner, b.amount, tokenProgram));
  }
  // Every output arrives in the owner's own account for its mint, which must exist before a swap.
  for (const mint of s.rules.outputs) await account(s.owner, mint, s.outputTokenPrograms?.[mint] ?? TOKEN_PROGRAM);
  if (s.agentLamports && !s.existing?.funded) ixs.push(transferSol(s.owner, s.agent, s.agentLamports));
  return ixs;
}

const MAX_TRANSACTION_SIZE = 1232;

/**
 * The set-up's instructions packed in order into as few unsigned transactions, paid by the owner, as fit
 * in 1232 bytes each. Send them in this order, each confirmed before the next: the grant needs the policy.
 */
export function ownerSetupTransactions(
  ixs: Instruction[], owner: Address, lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
): Transaction[] {
  const compile = (part: Instruction[]) => compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(owner, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(part, m),
  ));
  const size = (tx: Transaction) => getTransactionEncoder().encode(tx).length;
  const out: Transaction[] = [];
  let part: Instruction[] = [];
  for (const ix of ixs) {
    if (part.length && size(compile([...part, ix])) > MAX_TRANSACTION_SIZE) {
      out.push(compile(part));
      part = [];
    }
    part.push(ix);
    if (part.length === 1 && size(compile(part)) > MAX_TRANSACTION_SIZE) throw new Error('one set-up instruction is larger than a transaction');
  }
  if (part.length) out.push(compile(part));
  return out;
}

/**
 * The owner's whole set-up, sent: reads what is already on chain, packs the rest into transactions,
 * has the wallet sign them all at once (`signAll`, e.g. a wallet's signAllTransactions) and sends them
 * in order, each confirmed before the next. On a failure it says which transaction failed.
 *
 * Run again after a set-up that stopped part way, it sends only what is missing: nothing that is
 * already there is set again without the owner asking (`skipped` lists it). An existing grant keeps its
 * rules (change them with SetGrant), an input account already approved to the Guard keeps its budget
 * (pass `approveAgain: true` to set it to `budgets`), and `agentLamports` is sent only for an agent
 * that had no grant when the run began (pass `fundAgent: true` to send it anyway).
 */
export async function sendOwnerSetup(
  chain: Chain, s: OwnerSetup & { approveAgain?: boolean; fundAgent?: boolean }, signAll: (txs: Transaction[]) => Promise<Transaction[]>,
): Promise<
  | { ok: true; transactions: number; skipped: string[] }
  | { ok: false; error: string; confirmed: number; transactions: number; skipped: string[] }
> {
  const authority = await authorityOf(s.program, s.owner);
  const sources = await Promise.all(s.budgets.map(b => ataOf(s.owner, b.mint, b.tokenProgram ?? TOKEN_PROGRAM)));
  const atas = [
    ...await Promise.all(s.budgets.flatMap(b => [ataOf(s.agent, b.mint, b.tokenProgram ?? TOKEN_PROGRAM), ataOf(TREASURY, b.mint, b.tokenProgram ?? TOKEN_PROGRAM)])),
    ...await Promise.all(s.rules.outputs.map(m => ataOf(s.owner, m, s.outputTokenPrograms?.[m] ?? TOKEN_PROGRAM))),
  ];
  const [policy, grant, ...rest] = await chain.getAccounts([await policyOf(s.program, s.owner), await grantOf(s.program, s.owner, s.agent), ...sources, ...atas]);
  const sourceAccounts = rest.slice(0, sources.length);
  const ataAccounts = rest.slice(sources.length);
  const policyExists = !!policy && policy.owner === s.program;
  const grantExists = !!grant && grant.owner === s.program;
  const approved = s.approveAgain ? [] : sources.filter((_, i) => {
    const a = sourceAccounts[i];
    try {
      return !!a && decodeTokenAccount(a.data).delegate === authority;
    } catch {
      return false;
    }
  });
  const existing = { grant: grantExists, accounts: atas.filter((_, i) => !!ataAccounts[i]), approved, funded: grantExists && !s.fundAgent };
  const skipped = [
    ...(grantExists ? ['the grant exists: its rules are kept'] : []),
    ...approved.map(a => `${a} is already approved to the Guard: its budget is kept`),
    ...(existing.funded && s.agentLamports ? ['agentLamports: the agent had a grant already, so no SOL was sent (fundAgent: true sends it)'] : []),
  ];
  const ixs = await ownerSetup({ ...s, policyExists, existing });
  if (!ixs.length) return { ok: true, transactions: 0, skipped };
  const txs = ownerSetupTransactions(ixs, s.owner, await chain.latestBlockhash());
  const signed = await signAll(txs);
  for (const [i, tx] of signed.entries()) {
    const r = await chain.send(tx);
    if (!r.ok) return { ok: false, error: `set-up transaction ${i + 1} of ${signed.length}: ${r.error ?? 'failed'}`, confirmed: i, transactions: signed.length, skipped };
  }
  return { ok: true, transactions: signed.length, skipped };
}
