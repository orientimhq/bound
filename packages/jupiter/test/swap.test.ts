/**
 * Route selection: a route whose accounts, together with Orientim's own, exceed Solana's 64-account
 * limit must count as "does not fit" (try a smaller maxAccounts), not crash the pipeline. Seen on
 * mainnet with USDC → HNT on 19 September 2026.
 */
import { describe, expect, it } from 'vitest';
import {
  AccountRole, appendTransactionMessageInstruction, compileTransaction, createNoopSigner, createTransactionMessage,
  generateKeyPairSigner, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Blockhash } from '@solana/kit';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, tokenAccountSizeFor } from '@orientimhq/swap/core';
import {
  compileIfFits, DEFAULT_SETTINGS, isMinimumOutputCheckInstruction, PUMP_CURVE_PROGRAM, quotedMinimum, slippageFor,
  strictMinimumOutput,
} from '../src/swap.ts';

describe('the strict on-chain minimum model', () => {
  const quote = { outAmount: '1000000', otherAmountThreshold: '1' };

  it('never lets a weak router threshold lower Orientim\'s slippage floor', () => {
    expect(strictMinimumOutput(quote, 50)).toBe(995_000n);
  });

  it('keeps a stricter minimum already accepted by the user', () => {
    expect(strictMinimumOutput(quote, 50, 999_000n)).toBe(999_000n);
  });

  for (const programAddress of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    it(`recognizes the on-chain self-transfer under ${programAddress}`, () => {
      expect(isMinimumOutputCheckInstruction({
        programAddress,
        data: new Uint8Array([12]),
        accounts: [{ address: 'output' }, { address: 'mint' }, { address: 'output' }],
      })).toBe(true);
    });
  }

  it('does not mistake an instruction without accounts for the minimum check', () => {
    // Both missing accounts read as undefined, and undefined === undefined.
    expect(isMinimumOutputCheckInstruction({ programAddress: TOKEN_PROGRAM, data: new Uint8Array([12]), accounts: [] }))
      .toBe(false);
  });

  it('does not mistake an ordinary transfer for the minimum check', () => {
    expect(isMinimumOutputCheckInstruction({
      programAddress: TOKEN_PROGRAM,
      data: new Uint8Array([12]),
      accounts: [{ address: 'source' }, { address: 'mint' }, { address: 'destination' }],
    })).toBe(false);
  });
});

async function transactionWith(accountCount: number) {
  const payer = createNoopSigner((await generateKeyPairSigner()).address);
  const accounts = await Promise.all(
    Array.from({ length: accountCount }, async () => ({ address: (await generateKeyPairSigner()).address as Address, role: AccountRole.WRITABLE })),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 1n }, m),
    m => appendTransactionMessageInstruction({ programAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address, accounts, data: new Uint8Array([1]) }, m),
  );
  return () => compileTransaction(message);
}

describe('route selection', () => {
  it('a route over the 64-account limit does not fit', async () => {
    expect(compileIfFits(await transactionWith(70))).toBeNull();
  });

  it('a route within the limit compiles', async () => {
    expect(compileIfFits(await transactionWith(40))).not.toBeNull();
  });

  it('any other compile error still surfaces', () => {
    expect(() => compileIfFits(() => { throw new Error('boom'); })).toThrow('boom');
  });
});

describe('the size of a new token account, which decides the rent shown before signing', () => {
  /** A Token-2022 mint whose extension area holds these (type, length) entries, zero-filled. */
  const mint2022 = (extensions: [number, number][]) => {
    const data = new Uint8Array(166 + extensions.reduce((n, [, l]) => n + 4 + l, 0));
    data[165] = 1; // AccountType::Mint
    const view = new DataView(data.buffer);
    let at = 166;
    for (const [type, length] of extensions) {
      view.setUint16(at, type, true);
      view.setUint16(at + 2, length, true);
      at += 4 + length;
    }
    return data;
  };

  it('a classic account is 165 bytes', () => {
    expect(tokenAccountSizeFor(TOKEN_PROGRAM, new Uint8Array(82))).toBe(165);
  });

  it('a Token-2022 account with no extensions still carries the ImmutableOwner marker: 170', () => {
    expect(tokenAccountSizeFor(TOKEN_2022_PROGRAM, new Uint8Array(82))).toBe(170);
  });

  // Measured on mainnet: the real associated accounts of these tokens are this size.
  it('PYUSD and USDG accounts are 187 bytes, as on mainnet', () => {
    const pyusd = mint2022([[3, 32], [12, 32], [1, 108], [4, 65], [16, 129], [14, 64], [18, 64], [19, 174]]);
    expect(tokenAccountSizeFor(TOKEN_2022_PROGRAM, pyusd)).toBe(187);
  });

  it('CASH accounts are 175 bytes, as on mainnet', () => {
    const cash = mint2022([[3, 32], [12, 32], [6, 1], [4, 65], [14, 64], [18, 64], [19, 138]]);
    expect(tokenAccountSizeFor(TOKEN_2022_PROGRAM, cash)).toBe(175);
  });
});

describe('which slippage a route gets', () => {
  const route = (labels: string[], programs: string[] = []) => ({
    routePlan: labels.map(label => ({ percent: 100, swapInfo: { label, ammKey: '' } })),
    swapInstruction: { programId: '', data: '', accounts: programs.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })) },
  });

  it('3% when a leg trades on a Pump.fun bonding curve and the route invokes the curve program', () => {
    expect(slippageFor(route(['Pump.fun'], [PUMP_CURVE_PROGRAM]), DEFAULT_SETTINGS)).toBe(300);
    expect(slippageFor(route(['Whirlpool', 'Pump.fun'], [PUMP_CURVE_PROGRAM]), DEFAULT_SETTINGS)).toBe(300);
  });

  it('0.5% otherwise, including a curve label on a route without the curve program', () => {
    expect(slippageFor(route(['Pump.fun']), DEFAULT_SETTINGS)).toBe(50);
    expect(slippageFor(route(['Whirlpool'], [PUMP_CURVE_PROGRAM]), DEFAULT_SETTINGS)).toBe(50);
    expect(slippageFor(route(['Pump.fun Amm']), DEFAULT_SETTINGS)).toBe(50);
    expect(slippageFor(route(['Whirlpool', 'Raydium CLMM']), DEFAULT_SETTINGS)).toBe(50);
  });

  it('a quote shows the minimum of the tolerance its route will be built at', () => {
    const q = (labels: string[], programs: string[] = []) => ({ ...route(labels, programs), outAmount: '1000000', otherAmountThreshold: '995000' });
    expect(quotedMinimum(q(['Pump.fun'], [PUMP_CURVE_PROGRAM]), DEFAULT_SETTINGS)).toBe(970_000n);
    expect(quotedMinimum(q(['Whirlpool']), DEFAULT_SETTINGS)).toBe(995_000n);
  });
});
