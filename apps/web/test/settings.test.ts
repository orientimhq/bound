/**
 * The settings a deployment is built with. A wrong one stops the build with what to fix: a fee typed
 * as a percentage stopped the page from loading, an empty one made every swap fail as "too small",
 * and a mistyped treasury ran the page and the agent API without a fee.
 */
import { describe, expect, it } from 'vitest';
import { checkDeploymentSettings, feeBpsSetting, maxNetworkFeeSetting, treasurySetting } from '../lib/settings.ts';

const TREASURY = 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';

describe('deployment settings', () => {
  it('the fee is whole basis points, 25 when unset or empty', () => {
    expect(feeBpsSetting(undefined)).toBe(25n);
    expect(feeBpsSetting('')).toBe(25n);
    expect(feeBpsSetting(' 30 ')).toBe(30n);
    expect(feeBpsSetting('29')).toBe(29n);
    for (const wrong of ['0.3', '0,3', '0.3%', '30bps', '31', '100', '-5', 'abc']) expect(() => feeBpsSetting(wrong)).toThrow('NEXT_PUBLIC_ORIENTIM_FEE_BPS');
  });

  it('the treasury is an address, or empty for test mode', () => {
    expect(treasurySetting(undefined)).toBeNull();
    expect(treasurySetting('  ')).toBeNull();
    expect(treasurySetting(` ${TREASURY} `)).toBe(TREASURY);
    expect(() => treasurySetting(`${TREASURY}x`)).toThrow('NEXT_PUBLIC_ORIENTIM_TREASURY');
    expect(() => treasurySetting('0x1234')).toThrow('not one');
  });

  it('the network fee limit is lamports, at least two signatures, 500,000 when unset', () => {
    expect(maxNetworkFeeSetting(undefined)).toBe(500_000n);
    expect(maxNetworkFeeSetting('200000')).toBe(200_000n);
    for (const wrong of ['0', '5000', '0.0005', 'lots']) expect(() => maxNetworkFeeSetting(wrong)).toThrow('ORIENTIM_MAX_NETWORK_FEE_LAMPORTS');
  });

  it('the build refuses the first wrong setting, and a treasury with no fee', () => {
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_ORIENTIM_TREASURY: TREASURY, NEXT_PUBLIC_ORIENTIM_FEE_BPS: '30' })).not.toThrow();
    expect(() => checkDeploymentSettings({})).not.toThrow();
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_ORIENTIM_TREASURY: TREASURY, NEXT_PUBLIC_ORIENTIM_FEE_BPS: '0.3' })).toThrow('basis points');
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_ORIENTIM_TREASURY: TREASURY, NEXT_PUBLIC_ORIENTIM_FEE_BPS: '0' })).toThrow('every swap would be refused');
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_ORIENTIM_FEE_BPS: '0' })).not.toThrow();
  });
});

describe('the lower fee for a large swap', () => {
  it('is off unless set; 15 bps from $10,000 of USDC or USDT, and from the SOL value given', async () => {
    const { feeTiersSetting } = await import('../lib/settings.ts');
    expect(feeTiersSetting({})).toEqual([]);
    expect(feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '15' }).map(t => [t.from, t.bps])).toEqual([[10_000_000_000n, 15n], [10_000_000_000n, 15n]]);
    const withSol = feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '15', NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL: '50' });
    expect(withSol).toHaveLength(3);
    expect(withSol[2].from).toBe(50_000_000_000n);
  });

  it('is stated on the pages after the fee, and not at all when off', async () => {
    const { feeTierText } = await import('../lib/settings.ts');
    expect(feeTierText({})).toBe('');
    expect(feeTierText({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '15' })).toBe('0.15% from $10,000 of USDC or USDT');
    expect(feeTierText({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '15', NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL: '85' })).toBe('0.15% from $10,000 of USDC or USDT or 85 SOL');
  });

  it('refuses a rate not below the fee, a bad SOL amount, or SOL without a rate', async () => {
    const { feeTiersSetting } = await import('../lib/settings.ts');
    expect(() => feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '25' })).toThrow('below the fee of 25');
    expect(() => feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '0.15' })).toThrow();
    expect(() => feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '15', NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL: '0' })).toThrow();
    expect(() => feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL: '50' })).toThrow('without NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS');
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '30' })).toThrow();
  });
});

describe('the mints the lower fee is measured in', () => {
  it('are the ones @orientimhq/swap/core names', async () => {
    const core = await import('@orientimhq/swap/core');
    const { feeTiersSetting } = await import('../lib/settings.ts');
    const mints = feeTiersSetting({ NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS: '15', NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL: '1' }).map(t => t.mint);
    expect(mints).toEqual([core.USDC_MINT, core.USDT_MINT, core.WSOL_MINT]);
  });
});
