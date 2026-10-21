import { isAddress } from '@solana/kit';
import type { Address } from '@solana/kit';

// The mints the lower fee is measured in, as @orientimhq/swap/core names them: next.config.ts loads this
// file where the package's ESM-only entry points do not resolve.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address;
const WSOL_MINT = 'So11111111111111111111111111111111111111112' as Address;

/**
 * The deployment settings the page is built with, read the same way by the page, the agent API and
 * the build itself (next.config.ts), which refuses a wrong one. A fee typed as a percentage ("0.3")
 * would otherwise stop the page from loading at all, an empty one would make every swap fail as
 * "too small", and a mistyped treasury would silently run a fee-free deployment.
 */

/** NEXT_PUBLIC_ORIENTIM_FEE_BPS: whole basis points, 0 to 30 (25 = 0.25%, the product's fee); 25 when unset or empty. */
export function feeBpsSetting(raw: string | undefined): bigint {
  const value = raw?.trim() ?? '';
  if (value === '') return 25n;
  if (!/^\d{1,2}$/.test(value) || BigInt(value) > 30n) {
    throw new Error(`NEXT_PUBLIC_ORIENTIM_FEE_BPS must be a whole number of basis points from 0 to 30 (30 means 0.3%), not "${raw}".`);
  }
  return BigInt(value);
}

/** NEXT_PUBLIC_ORIENTIM_TREASURY: a Solana address, or empty for test mode (no fee). */
export function treasurySetting(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  if (!isAddress(value)) throw new Error(`NEXT_PUBLIC_ORIENTIM_TREASURY must be a Solana address, or empty for test mode: "${raw}" is not one.`);
  return value;
}

/** Where the lower fee starts in USDC or USDT: $10,000, in base units (6 decimals). */
export const FEE_TIER_STABLE_UNITS = 10_000_000_000n;

/**
 * NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: the fee from $10,000 of USDC or USDT up, below the fee (15 for
 * 0.15%); with NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL, whole SOL, also for a fee in SOL from that value.
 * Empty: one fee at every size. Compiled in, like the fee, so the server cannot change it.
 */
export function feeTiersSetting(env: Record<string, string | undefined>): { mint: Address; from: bigint; bps: bigint }[] {
  const bps = env.NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS?.trim() ?? '';
  const sol = env.NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL?.trim() ?? '';
  if (bps === '') {
    if (sol !== '') throw new Error('NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL is set without NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: set the lower fee too, or empty both.');
    return [];
  }
  const fee = feeBpsSetting(env.NEXT_PUBLIC_ORIENTIM_FEE_BPS);
  if (!/^\d{1,2}$/.test(bps) || BigInt(bps) >= fee) {
    throw new Error(`NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS must be whole basis points below the fee of ${fee}, not "${bps}".`);
  }
  if (sol !== '' && (!/^\d{1,7}$/.test(sol) || BigInt(sol) === 0n)) {
    throw new Error(`NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL must be a whole number of SOL above 0, not "${sol}".`);
  }
  const rate = BigInt(bps);
  return [
    { mint: USDC_MINT, from: FEE_TIER_STABLE_UNITS, bps: rate },
    { mint: USDT_MINT, from: FEE_TIER_STABLE_UNITS, bps: rate },
    ...(sol !== '' ? [{ mint: WSOL_MINT, from: BigInt(sol) * 1_000_000_000n, bps: rate }] : []),
  ];
}

/**
 * The lower fee as the pages state it after the fee ("0.15% from $10,000 of USDC or USDT or 85 SOL"),
 * or empty when every size pays the fee.
 */
export function feeTierText(env: Record<string, string | undefined>): string {
  const tiers = feeTiersSetting(env);
  if (!tiers.length) return '';
  const sol = tiers.find(t => t.mint === WSOL_MINT);
  const percent = `${(Number(tiers[0]!.bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  return `${percent} from $10,000 of USDC or USDT${sol ? ` or ${(sol.from / 1_000_000_000n).toLocaleString('en-US')} SOL` : ''}`;
}

/** Two signatures: a network fee limit below this refuses every swap. */
const LEAST_NETWORK_FEE_LAMPORTS = 10_000n;

/** ORIENTIM_MAX_NETWORK_FEE_LAMPORTS: lamports, at least two signatures' worth; 500,000 when unset or empty. */
export function maxNetworkFeeSetting(raw: string | undefined): bigint {
  const value = raw?.trim() ?? '';
  if (value === '') return 500_000n;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) < LEAST_NETWORK_FEE_LAMPORTS) {
    throw new Error(`ORIENTIM_MAX_NETWORK_FEE_LAMPORTS must be a whole number of lamports of at least ${LEAST_NETWORK_FEE_LAMPORTS}, not "${raw}".`);
  }
  return BigInt(value);
}

/**
 * Every setting at once, as the build checks them: the first wrong one is thrown, with what to fix.
 * A treasury with a fee of 0 is refused too: every swap it builds would carry no fee, which a
 * deployment with a treasury refuses to build.
 */
export function checkDeploymentSettings(env: Record<string, string | undefined>): void {
  const fee = feeBpsSetting(env.NEXT_PUBLIC_ORIENTIM_FEE_BPS);
  const treasury = treasurySetting(env.NEXT_PUBLIC_ORIENTIM_TREASURY);
  maxNetworkFeeSetting(env.ORIENTIM_MAX_NETWORK_FEE_LAMPORTS);
  feeTiersSetting(env);
  if (treasury && fee === 0n) {
    throw new Error('NEXT_PUBLIC_ORIENTIM_FEE_BPS is 0 while NEXT_PUBLIC_ORIENTIM_TREASURY is set: every swap would be refused. Set the fee (25 = 0.25%), or empty the treasury for test mode.');
  }
}
