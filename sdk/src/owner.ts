/**
 * The owner's one set-up, as instructions for one transaction the owner signs: the policy, the
 * agent's grant, the accounts every swap needs (the agent's hopper and the treasury's account for each
 * input mint) and the approval of the Guard's authority over each input account, for a budget.
 */
import { AccountRole } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import {
  ATA_PROGRAM, ataOf, authorityOf, grantOf, initPolicy, policyOf, setGrant, SYSTEM_PROGRAM, TOKEN_PROGRAM, TREASURY,
} from './instructions.ts';
import type { GrantRules } from './instructions.ts';

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
};

export async function ownerSetup(s: OwnerSetup): Promise<Instruction[]> {
  const policy = await policyOf(s.program, s.owner);
  const authority = await authorityOf(s.program, s.owner);
  const ixs: Instruction[] = [];
  if (!s.policyExists) ixs.push(initPolicy({ program: s.program, owner: s.owner, policy, verifiers: s.verifiers, programs: s.programs, threshold: s.threshold }));
  ixs.push(setGrant({ program: s.program, owner: s.owner, policy, grant: await grantOf(s.program, s.owner, s.agent), agent: s.agent, rules: s.rules }));
  for (const b of s.budgets) {
    const tokenProgram = b.tokenProgram ?? TOKEN_PROGRAM;
    ixs.push(
      createAtaIdempotent(s.owner, await ataOf(s.agent, b.mint, tokenProgram), s.agent, b.mint, tokenProgram),
      createAtaIdempotent(s.owner, await ataOf(TREASURY, b.mint, tokenProgram), TREASURY, b.mint, tokenProgram),
      approve(await ataOf(s.owner, b.mint, tokenProgram), authority, s.owner, b.amount, tokenProgram),
    );
  }
  return ixs;
}
