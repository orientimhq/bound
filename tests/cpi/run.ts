/**
 * T6: the external swap program is malicious code, not just a malicious instruction list.
 *
 * T1 (tests/integration/mainnet.ts) replaces Jupiter's instruction with attacker instructions and
 * simulates them. That covers a hostile route, but not a hostile *program*: a swap program is free
 * to make cross-program invocations of its own, with any account metas it likes. This test deploys
 * such a program (tests/cpi/attacker) into a real Solana VM and lets it run.
 *
 * Orientim gives it exactly what the design allows — the temporary account E_in, the one-time key E
 * and, for token outputs, the wallet's output account W_out — and the runtime, not Orientim, decides
 * the rest. Every case asserts the same invariant: nothing beyond the approved amount moves, no
 * permission survives the transaction, and a swap that does not deliver the minimum reverts whole.
 *
 *   node tests/cpi/run.ts
 *
 * Needs tests/cpi/attacker/target/deploy/orientim_attacker.so (cargo build-sbf) and Linux or macOS:
 * litesvm ships no Windows binary. CI (.github/workflows/cpi.yml) does both.
 */
import { signTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAX_ROUTE_KEPT_LAMPORTS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@orientim/core';
import {
  approve, balancesOf, CLOSE_ACCOUNT, deliver, invariants, IX, MIN_OUT, MIN_OUT_SOL, OUT_DECIMALS, protectedSwap, requireProgram,
  send, setAuthority, setup, SOL, SWAP_AMOUNT, takeFrom, transfer, transferChecked, transferSol,
} from './world.ts';
import type { Inner, IssuerDelegate, Variant, World } from './world.ts';

const OUT_DIR = 'tests/cpi/results';
const log = (...a: unknown[]) => console.log(...a);
requireProgram();

// ---------------------------------------------------------------- the cases

type Case = {
  name: string;
  variant: Variant;
  /** Classic SPL by default; selected cases run the same hostile CPI through Token-2022. */
  tokenProgram?: Address;
  /** A permanent delegate on both swap mints (Token-2022 only); see `IssuerDelegate`. */
  issuer?: IssuerDelegate;
  /** Rent Orientim sends E for an account the route opens in E's name (PumpSwap). */
  takerRent?: bigint;
  /** What the malicious program attempts, in order. */
  inners: (w: World) => Inner[];
  /** Accounts the route demands on top of what Orientim allows. */
  extra?: (w: World) => Address[];
  expect: 'succeeds' | 'reverts' | 'refused before signing';
  /** What the case proves, for the report. */
  proves: string;
};

const CASES: Case[] = [
  {
    name: 'takes the approved amount and delivers the minimum',
    variant: 'C', expect: 'succeeds',
    proves: 'an honest-looking route works: exactly the approved amount leaves, the minimum arrives',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    name: 'takes the approved amount and delivers nothing',
    variant: 'C', expect: 'reverts',
    proves: "Orientim's minimum-output check undoes the theft",
    inners: () => [takeFrom(SWAP_AMOUNT)],
  },
  {
    name: 'delivers one unit less than the minimum',
    variant: 'C', expect: 'reverts',
    proves: 'the minimum is exact, not approximate',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT - 1n)],
  },
  {
    name: 'tries to take more than the approved amount',
    variant: 'C', expect: 'reverts',
    proves: 'the temporary account holds the approved amount and nothing more',
    inners: () => [takeFrom(SWAP_AMOUNT + 1n)],
  },
  {
    name: "tries to spend the wallet's input account",
    variant: 'C', expect: 'reverts',
    proves: 'the rest of the balance of the same token is out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1_000_000n),
    }],
  },
  {
    name: "tries to spend the wallet's other token",
    variant: 'C', expect: 'reverts',
    proves: 'tokens that have nothing to do with the swap are out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: "tries to take the wallet's SOL",
    variant: 'C', expect: 'reverts',
    proves: 'the wallet is never handed over, so its SOL cannot move',
    inners: w => [{
      program: IX.system,
      metas: [{ key: w.W.address, w: true, s: true }, { key: w.attacker, w: true }],
      data: transferSol(SOL),
    }],
  },
  {
    name: "tries to take the wallet's SOL while forging a signature",
    variant: 'C', expect: 'reverts',
    proves: 'a program cannot sign for a wallet with a key of its own',
    inners: w => [{
      program: IX.system, signed: true,
      metas: [{ key: w.W.address, w: true, s: true }, { key: w.attacker, w: true }],
      data: transferSol(SOL),
    }],
  },
  {
    name: 'tries to take the balance already in the output account',
    variant: 'C', expect: 'reverts',
    proves: 'the output account is handed over to receive, not to be spent',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: 'tries to leave a delegate on the output account',
    variant: 'C', expect: 'reverts',
    proves: 'no spending permission can be left behind for later',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.poolAuthority }, { key: w.W.address, s: true }],
      data: approve(2n ** 63n),
    }],
  },
  {
    name: 'tries to take ownership of the output account',
    variant: 'C', expect: 'reverts',
    proves: "ownership of the wallet's account cannot be reassigned",
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.W.address, s: true }],
      data: setAuthority(2, w.attacker),
    }],
  },
  {
    name: 'tries to close the output account to the attacker',
    variant: 'C', expect: 'reverts',
    proves: "the rent inside the wallet's account cannot be taken either",
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.attacker, w: true }, { key: w.W.address, s: true }],
      data: CLOSE_ACCOUNT,
    }],
  },
  {
    name: 'leaves a delegate on the temporary account, then delivers',
    variant: 'C', expect: 'succeeds',
    proves: 'a permission on the temporary account dies with it: cleanup closes the account',
    inners: () => [
      { program: IX.token, metas: [{ key: IX.eIn, w: true }, { key: IX.poolAuthority }, { key: IX.E, s: true }], data: approve(2n ** 63n) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
  {
    name: "the route demands the wallet's input account",
    variant: 'C', expect: 'refused before signing',
    proves: 'rule R1 stops such a route before the wallet is ever asked to sign',
    extra: w => [w.wIn],
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    // Orientim's cleanup closes E_in unconditionally. A route that destroys it first would, if the
    // swap still counted as a success, keep the rent W paid to open it. It does not: the close
    // fails on an account that no longer exists, and that takes the whole transaction with it.
    name: 'destroys the temporary input account after emptying it',
    variant: 'C', expect: 'reverts',
    proves: 'a route cannot complete around a temporary account it destroyed: cleanup fails and everything is undone',
    inners: w => [
      takeFrom(SWAP_AMOUNT),
      {
        program: IX.token,
        metas: [{ key: IX.eIn, w: true }, { key: IX.attackerIn, w: true }, { key: IX.E, s: true }],
        data: CLOSE_ACCOUNT,
      },
      deliver(MIN_OUT),
    ],
  },
  {
    // To re-create E_in and hide the theft, the attacker needs a payer that signs and holds
    // lamports. The only lamports within reach are E_in's own rent, and the only key it can sign
    // for is its program-derived authority — which Orientim handed over read-only. A cross-program
    // call cannot widen that.
    name: 'sends the temporary account\'s rent to a key it can sign for',
    variant: 'C', expect: 'reverts',
    proves: 'an account handed over read-only stays read-only inside the program\'s own inner call, so the rent cannot be moved somewhere the attacker could spend it',
    inners: () => [
      takeFrom(SWAP_AMOUNT),
      {
        program: IX.token,
        metas: [{ key: IX.eIn, w: true }, { key: IX.poolAuthority, w: true }, { key: IX.E, s: true }],
        data: CLOSE_ACCOUNT,
      },
      deliver(MIN_OUT),
    ],
  },
  {
    name: 'SPL → SOL: takes the approved amount and delivers the minimum',
    variant: 'A', expect: 'succeeds',
    proves: 'the wrapped-SOL variant works and closes both temporary accounts',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT_SOL)],
  },
  {
    name: 'SPL → SOL: delivers nothing',
    variant: 'A', expect: 'reverts',
    proves: 'the minimum is checked on the temporary output account too',
    inners: () => [takeFrom(SWAP_AMOUNT)],
  },
  {
    name: 'SPL → SOL: closes the temporary output account to the attacker',
    variant: 'A', expect: 'reverts',
    proves: 'taking the temporary account itself still fails the minimum check',
    inners: w => [takeFrom(SWAP_AMOUNT), {
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.attacker, w: true }, { key: IX.E, s: true }],
      data: CLOSE_ACCOUNT,
    }],
  },
  {
    name: 'Token-2022: takes the approved amount and delivers the minimum',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'succeeds',
    proves: 'the protected path itself works with real Token-2022 program CPIs',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    name: 'Token-2022: takes the approved amount and delivers nothing',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'the minimum-output check rolls back a Token-2022 theft too',
    inners: () => [takeFrom(SWAP_AMOUNT)],
  },
  {
    name: "Token-2022: tries to spend the wallet's remaining input balance",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'the Token-2022 input balance beyond the approved amount is out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1_000_000n),
    }],
  },
  {
    name: "Token-2022: tries to spend the wallet's unrelated token",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'an unrelated Token-2022 balance is out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: "Token-2022: tries to take the wallet's SOL",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'using Token-2022 in the route does not expose the wallet or its SOL',
    inners: w => [{
      program: IX.system,
      metas: [{ key: w.W.address, w: true, s: true }, { key: w.attacker, w: true }],
      data: transferSol(SOL),
    }],
  },
  {
    name: 'Token-2022: tries to spend the balance already in the output account',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'the Token-2022 output account can receive but cannot be spent by the route',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: 'Token-2022: tries to leave a delegate on the output account',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'a Token-2022 spending permission cannot be left behind',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.poolAuthority }, { key: w.W.address, s: true }],
      data: approve(2n ** 63n),
    }],
  },
  {
    name: 'Token-2022: tries to take ownership of the output account',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: "ownership of the wallet's Token-2022 account cannot be reassigned",
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.W.address, s: true }],
      data: setAuthority(2, w.attacker),
    }],
  },
  {
    // PYUSD's shape: the issuer's delegate is an ordinary key. The swap itself must still work.
    name: 'issuer delegate is an ordinary key: takes the approved amount and delivers the minimum',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'key', expect: 'succeeds',
    proves: 'a token whose issuer can move it anywhere still swaps through the protected path',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    // The attacker is the issuer here, and uses its delegate power on the wallet's output account.
    // The key is an ordinary one, so it can act only as a signer, and it never signs the swap.
    name: "issuer delegate is an ordinary key: the attacker holds it and tries to take the wallet's output balance",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'key', expect: 'reverts',
    proves: 'an issuer key that is not a signer of the transaction cannot act inside it, even when the route belongs to the issuer and hands the key along',
    // The route even passes the issuer's key along, so the only thing missing is its signature.
    extra: w => [w.attacker],
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: w.attacker, s: true }],
      data: transfer(1n),
    }],
  },
  {
    // The delegate R7 lets through as an ordinary address is a multisig the route's program signs
    // for: it can move tokens out of the wallet's output account inside the swap. What stops it is
    // Orientim's minimum-output check, which counts that account's balance after the swap.
    name: "issuer delegate is a multisig the route's program signs for: takes from the wallet's output balance and delivers the minimum",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'multisig', expect: 'reverts',
    proves: 'a delegate hidden behind an ordinary-looking multisig can act inside the swap, and the minimum-output check reverts the whole transaction when it takes from what the wallet held',
    extra: w => [w.multisig!],
    inners: w => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT), {
      program: IX.token, signed: true,
      metas: [{ key: IX.output, w: true }, { key: 9 }, { key: IX.pool, w: true }, { key: w.multisig! }, { key: IX.poolAuthority, s: true }],
      data: transferChecked(1n, OUT_DECIMALS),
    }],
  },
  {
    // The bound SECURITY.md states: such a delegate can keep only what arrived above the minimum.
    name: 'issuer delegate is a multisig the route signs for: takes back only what it delivered above the minimum',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'multisig', expect: 'succeeds',
    proves: "the most such a delegate can take is the surplus above the minimum: the wallet still nets the minimum, and nothing it held before",
    extra: w => [w.multisig!],
    inners: w => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT + 5n), {
      program: IX.token, signed: true,
      metas: [{ key: IX.output, w: true }, { key: 9 }, { key: IX.pool, w: true }, { key: w.multisig! }, { key: IX.poolAuthority, s: true }],
      data: transferChecked(5n, OUT_DECIMALS),
    }],
  },
  {
    // The xStocks' shape: the delegate is an address a program can sign for. If that program is
    // the route, it could sign as the issuer inside the swap, so Orientim refuses before signing.
    name: "issuer delegate is the route program's own address",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'program', expect: 'refused before signing',
    proves: 'a delegate a program can sign for is refused (R7) before the wallet is ever asked',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    // A market may charge its rent to the buyer, which here is E, so Orientim sends E exactly that. With
    // nothing closed again in the same transaction, the route may keep at most MAX_ROUTE_KEPT_LAMPORTS
    // of it. A hostile route may pocket that instead: it is the most it can take on top of the approved amount.
    name: 'route rent: takes the rent Orientim sent the temporary key, and the approved amount',
    variant: 'C', takerRent: MAX_ROUTE_KEPT_LAMPORTS, expect: 'succeeds',
    proves: "the SOL a route can reach is the stated rent and nothing more; the wallet's own SOL stays out of reach",
    extra: w => [w.attacker],
    inners: w => [
      { program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: w.attacker, w: true }], data: transferSol(MAX_ROUTE_KEPT_LAMPORTS) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
  {
    name: 'route rent: tries to take one lamport more than the rent',
    variant: 'C', takerRent: MAX_ROUTE_KEPT_LAMPORTS, expect: 'reverts',
    proves: 'the temporary key holds exactly the rent, so there is nothing more to take',
    extra: w => [w.attacker],
    inners: w => [
      { program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: w.attacker, w: true }], data: transferSol(MAX_ROUTE_KEPT_LAMPORTS + 1n) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
  {
    name: 'route rent: keeps more rent than the limit, with nothing closed again',
    variant: 'C', takerRent: 1_346_200n, expect: 'refused before signing',
    proves: 'rent above MAX_ROUTE_KEPT_LAMPORTS that no closed account returns is refused (R4) before the wallet is ever asked',
    extra: w => [w.attacker],
    inners: w => [
      { program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: w.attacker, w: true }], data: transferSol(1_346_200n) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
];

// ---------------------------------------------------------------- run

type Row = { name: string; proves: string; expected: string; outcome: string; verifier: string; broken: string[]; pass: boolean };

const rows: Row[] = [];
for (const c of CASES) {
  const w = await setup(c.tokenProgram ?? TOKEN_PROGRAM, c.issuer);
  const { policy, transaction, swapIndex, verdict } = await protectedSwap(w, c.variant, c.inners(w), c.extra?.(w) ?? [], c.takerRent ?? 0n);
  const verifier = verdict.ok ? 'e pranoi' : `e refuzoi (${[...new Set(verdict.violations.map(v => v.rule))].join(', ')})`;

  if (c.expect === 'refused before signing') {
    const pass = !verdict.ok;
    rows.push({ name: c.name, proves: c.proves, expected: 'refuzohet para nënshkrimit', outcome: verifier, verifier, broken: [], pass });
    log(`${pass ? 'OK  ' : 'FAIL'} ${c.name}: verifier ${verifier}`);
    continue;
  }

  const before = balancesOf(w);
  const result = send(w.svm, await signTransaction([w.W.keyPair, w.E.keyPair], transaction));
  const after = balancesOf(w);
  const broken = invariants(w, policy, before, after, result.ok);
  const where = result.index === null ? '' : result.index === swapIndex ? ', te sulmi' : `, te instruction-i ${result.index} (sulmi te ${swapIndex})`;
  const pass = result.ok === (c.expect === 'succeeds') && broken.length === 0 && verdict.ok;
  rows.push({
    name: c.name, proves: c.proves,
    expected: c.expect === 'succeeds' ? 'kalon' : 'anulohet',
    outcome: result.ok ? 'kaloi' : `u anulua${where}: ${result.error}`,
    verifier, broken, pass,
  });
  log(`${pass ? 'OK  ' : 'FAIL'} ${c.name}: ${rows.at(-1)!.outcome}${broken.length ? ` — SHKELJE: ${broken.join('; ')}` : ''}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const failed = rows.filter(r => !r.pass).length;
writeFileSync(`${OUT_DIR}/cpi.md`, [
  '# T6 — kur programi i jashtëm është kod keqdashës',
  '',
  `${rows.length - failed}/${rows.length} raste kaluan. Programi sulmues: \`tests/cpi/attacker\`, i ngarkuar në një makinë virtuale Solana.`,
  '',
  '| Rasti | Pritej | Ndodhi | Verifier-i | Shkelje | Çfarë provon |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.name} | ${r.expected} | ${r.outcome} | ${r.verifier} | ${r.broken.join('; ') || '—'} | ${r.proves} |`),
  '',
].join('\n'));
log(`\nT6 ${rows.length - failed}/${rows.length}  →  ${OUT_DIR}/cpi.md`);
process.exit(failed ? 1 : 0);
