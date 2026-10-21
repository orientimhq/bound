import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { feeBpsSetting, feeTierText, treasurySetting } from '../settings';

/**
 * Fee settings fixed at build time. They are compiled into the bundle, so with a reproducible
 * build they are pinned, and the server has no live channel to change them.
 * The verifier additionally caps the fee at MAX_FEE_BPS whatever these say.
 */
// Read the way the build checked them (next.config.ts refuses a wrong one), so what reaches the page
// is either a valid setting or none.
const treasury = treasurySetting(process.env.NEXT_PUBLIC_ORIENTIM_TREASURY);
export const TREASURY: Address | null = treasury ? address(treasury) : null;
export const FEE_BPS: bigint = feeBpsSetting(process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS);
/** The lower fee for a large swap, as the pages state it; empty when every size pays FEE_BPS. */
export const FEE_TIER_TEXT: string = feeTierText({
  NEXT_PUBLIC_ORIENTIM_FEE_BPS: process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS,
  NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: process.env.NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS,
  NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL: process.env.NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL,
});
