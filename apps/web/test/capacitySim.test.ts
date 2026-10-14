/**
 * How the capacity simulation (tools/sim/capacity.sim.ts) judges what it saw: a refusal counts as a
 * borrowed wallet's moved balance only when nothing else could explain it, and a phase that must
 * build passes only when it built most of its swaps.
 */
import { describe, expect, it } from 'vitest';
import { balanceMoved, buildVerdict } from '../../../tools/sim/common.ts';

const refusal = (...problems: string[]) => `Not signing: ${problems.join('; ')}`;
const minimum = (got: number, expected: number) => `R2: instruction 4: minimum-output check for ${got}, expected ${expected}`;

describe('a moved balance', () => {
  it('is the minimum-output check alone, off by exactly the change seen in the balance', () => {
    // The balance rose by 100 after Orientim read it: the agent expects 100 more than the check asks.
    expect(balanceMoved(refusal(minimum(1_000, 1_100)), 100n)).toBe(true);
    // It fell by 50: the check asks 50 more than the agent expects.
    expect(balanceMoved(refusal(minimum(1_000, 950)), -50n)).toBe(true);
  });

  it('is never a check lowered with no such change: that is a server weakening the floor', () => {
    expect(balanceMoved(refusal(minimum(900, 1_000)), null)).toBe(false);
    expect(balanceMoved(refusal(minimum(900, 1_000)), 0n)).toBe(false);
    expect(balanceMoved(refusal(minimum(900, 1_000)), -100n)).toBe(false);
    expect(balanceMoved(refusal(minimum(900, 1_000)), 40n)).toBe(false);
  });

  it('is never a refusal with any other problem besides', () => {
    for (const other of ['R5: the fee goes to 9xQe..., not the treasury', 'R6: an approval is left on the wallet']) {
      expect(balanceMoved(refusal(minimum(900, 1_000), other), 100n)).toBe(false);
      expect(balanceMoved(refusal(other, minimum(900, 1_000)), 100n)).toBe(false);
    }
    expect(balanceMoved(`${refusal(minimum(900, 1_000))} and more`, 100n)).toBe(false);
    expect(balanceMoved('R2: instruction 4: unexpected token transfer of 5', 5n)).toBe(false);
  });
});

describe('a phase that must build', () => {
  it('passes with most of its swaps built and nothing unclear', () => {
    expect(buildVerdict(4, 5, 0, 0.8)).toBe('PASS');
    expect(buildVerdict(3, 5, 0, 0.8)).toBe('LOOK');
    expect(buildVerdict(1, 5, 0, 0.8)).toBe('LOOK');
    expect(buildVerdict(3, 3, 0, 0.8)).toBe('PASS');
    expect(buildVerdict(2, 3, 0, 0.8)).toBe('LOOK');
    expect(buildVerdict(190, 200, 0, 0.95)).toBe('PASS');
    expect(buildVerdict(189, 200, 0, 0.95)).toBe('LOOK');
    expect(buildVerdict(1, 200, 0, 0.95)).toBe('LOOK');
    expect(buildVerdict(5, 5, 1, 0.8)).toBe('LOOK');
    expect(buildVerdict(0, 0, 0, 0.8)).toBe('LOOK');
  });
});
