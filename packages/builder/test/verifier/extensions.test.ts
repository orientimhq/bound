/**
 * The Token-2022 matrix: not each extension on its own, but any set of them,
 * in any order, with the layouts a hostile mint could use. R7 must refuse a mint exactly when one of
 * its entries is refused, or when its extension area cannot be read the way the token program reads
 * it; and it must accept every combination of the entries a protected swap can live with.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isOffCurveAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { transferFeeOf, unsupportedExtension } from '@orientimhq/swap/verifier';

const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? ((import.meta as { env?: { MODE?: string } }).env?.MODE === 'fuzz' ? 200_000 : 3_000));
// At full size a property takes 20 to 40 s on CI, far past vitest's default 5 s (an earlier fuzz
// run timed out on all four, without a single counterexample).
const TIMEOUT = 60_000 + RUNS;
// The long fuzz runs are made separately from CI, in shards: one seed per shard (ORIENTIM_FUZZ_SEED),
// with ORIENTIM_FUZZ_RUNS cases. `npm run test:fuzz` runs one locally.
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };

const encoder = getAddressEncoder();
const onCurve: Uint8Array[] = await Promise.all(Array.from({ length: 6 }, async () => Uint8Array.from(encoder.encode((await generateKeyPairSigner()).address))));
const offCurve: Uint8Array[] = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
  const [pda] = await getProgramDerivedAddress({ programAddress: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address, seeds: [Uint8Array.of(i)] });
  return Uint8Array.from(encoder.encode(pda));
}));

/** One TLV entry, and what R7 must say about it on its own. */
type Entry = { type: number; value: Uint8Array; refused: boolean | 'unless-transfer-fee' };

const bytes = (n: number, fill?: number) => fc.uint8Array({ minLength: n, maxLength: n }).map(b => (fill === undefined ? b : b.fill(fill)));
const nonZero = (n: number) => bytes(n).filter(b => b.some(x => x !== 0));
const entry = (type: number, value: fc.Arbitrary<Uint8Array>, refused: Entry['refused']): fc.Arbitrary<Entry> => value.map(v => ({ type, value: v, refused }));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));

const allowed: fc.Arbitrary<Entry>[] = [
  entry(3, bytes(32), false), // mint close authority
  entry(4, fc.integer({ min: 0, max: 120 }).chain(n => bytes(n)), false), // confidential transfers
  entry(16, bytes(129), false), // their fee: only confidential transfers
  entry(14, bytes(32).map(a => cat(a, new Uint8Array(32))), false), // a hook with no program
  entry(18, bytes(64), false), entry(20, bytes(64), false), entry(22, bytes(64), false), // pointers
  entry(19, fc.integer({ min: 0, max: 300 }).chain(n => bytes(n)), false), // metadata, of any size
  entry(21, fc.integer({ min: 0, max: 120 }).chain(n => bytes(n)), false), // group
  entry(23, fc.integer({ min: 0, max: 120 }).chain(n => bytes(n)), false), // member
  entry(12, fc.constant(new Uint8Array(32)), false), // an empty permanent-delegate slot names nobody
  entry(12, fc.constantFrom(...onCurve), false), // an ordinary key acts only by signing
  entry(6, fc.constant(Uint8Array.of(1)), false), // new accounts start initialized
  entry(1, bytes(108), 'unless-transfer-fee'), // a transfer fee, allowed on the swap's own mints
];
const refused: fc.Arbitrary<Entry>[] = [
  entry(14, fc.tuple(bytes(32), nonZero(32)).map(([a, p]) => cat(a, p)), true), // a hook that runs code
  entry(12, fc.constantFrom(...offCurve), true), // a delegate a program can sign for
  entry(6, fc.constantFrom(Uint8Array.of(0), Uint8Array.of(2)), true), // uninitialized, or frozen, by default
  ...[8, 9, 10, 24, 25, 26, 27, 28].map(t => entry(t, fc.integer({ min: 0, max: 64 }).chain(n => bytes(n)), true)),
  entry(29, fc.integer({ min: 0, max: 64 }).chain(n => bytes(n)), true), // unknown to this verifier
  entry(250, fc.integer({ min: 0, max: 64 }).chain(n => bytes(n)), true),
  // A fixed-size extension declaring another size is not the layout the verifier reads.
  ...([[3, 32], [16, 129], [14, 64], [18, 64], [12, 32], [6, 1], [1, 108]] as const).map(([t, n]) =>
    entry(t, fc.integer({ min: 0, max: 140 }).filter(m => m !== n).chain(m => bytes(m)), true)),
];

const tlv = (e: Entry) => cat(Uint8Array.of(e.type & 0xff, e.type >> 8, e.value.length & 0xff, e.value.length >> 8), e.value);
/** A mint padded to an account's size, the account-type byte, then the entries. */
const mint = (area: Uint8Array) => cat(new Uint8Array(165), Uint8Array.of(1), area);
const verdictFor = (entries: Entry[], allowTransferFee: boolean) =>
  entries.some(e => e.refused === true || (e.refused === 'unless-transfer-fee' && !allowTransferFee));

describe('Token-2022: any combination of extensions', () => {
  it('a set of entries is accepted exactly when none of them is refused, in any order, with any trailing padding', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(...allowed, ...refused), { minLength: 1, maxLength: 8 }), fc.boolean(), fc.integer({ min: 0, max: 64 }),
        (entries, allowTransferFee, padding) => {
          const data = mint(cat(...entries.map(tlv), new Uint8Array(padding)));
          const bad = unsupportedExtension(data, { allowTransferFee });
          expect(bad !== null).toBe(verdictFor(entries, allowTransferFee));
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);

  it('every combination of the entries a swap can live with is accepted', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(...allowed), { minLength: 1, maxLength: 10 }), entries => {
        expect(unsupportedExtension(mint(cat(...entries.map(tlv))), { allowTransferFee: true })).toBeNull();
      }),
      PARAMS,
    );
  }, TIMEOUT);

  it('an entry hidden after an empty slot is refused: the token program reads past the gap, so the verifier must too', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(...allowed), { maxLength: 4 }), fc.integer({ min: 1, max: 8 }), fc.oneof(...allowed, ...refused),
        (before, gapPairs, hidden) => {
          const data = mint(cat(...before.map(tlv), new Uint8Array(gapPairs * 2), tlv(hidden)));
          expect(unsupportedExtension(data, { allowTransferFee: true })).not.toBeNull();
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);

  it('an area cut short is refused, wherever the cut falls', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(...allowed), { minLength: 1, maxLength: 6 }), fc.nat(), (entries, at) => {
        const area = cat(...entries.map(tlv));
        const last = tlv(entries[entries.length - 1]);
        // Cut inside the last entry (its header or its value), never at its exact end.
        const cut = area.length - 1 - (at % last.length);
        const data = mint(area.subarray(0, cut));
        const tail = area.subarray(area.length - last.length, cut);
        // Cut after a zero type byte pair of an entry of type 0 would read as padding; no entry here has type 0.
        expect(tail.length === 0 || unsupportedExtension(data, { allowTransferFee: true }) !== null).toBe(true);
      }),
      PARAMS,
    );
  }, TIMEOUT);

  it('the fixtures mean what they say: ordinary keys are on the curve, program addresses are not', () => {
    const decode = getAddressDecoder();
    expect(onCurve.every(k => !isOffCurveAddress(decode.decode(k)))).toBe(true);
    expect(offCurve.every(k => isOffCurveAddress(decode.decode(k)))).toBe(true);
  });
});

describe('a transfer fee changes at the epoch its issuer set', () => {
  /** A mint with a fee of `olderBps` until `from`, then `newerBps`. */
  const scheduled = (olderBps: number, from: bigint, newerBps: number) => {
    const data = new Uint8Array(166 + 4 + 108);
    data[165] = 1;
    const view = new DataView(data.buffer);
    view.setUint16(166, 1, true);
    view.setUint16(168, 108, true);
    const older = 170 + 72;
    const newer = 170 + 90;
    view.setBigUint64(older + 8, 1_000n, true);
    view.setUint16(older + 16, olderBps, true);
    view.setBigUint64(newer, from, true);
    view.setBigUint64(newer + 8, 2_000n, true);
    view.setUint16(newer + 16, newerBps, true);
    return data;
  };

  it('before the epoch the older fee applies, from it the newer one', () => {
    const data = scheduled(100, 800n, 500);
    expect(transferFeeOf(data, 799n)).toEqual({ bps: 100, maximum: 1_000n });
    expect(transferFeeOf(data, 800n)).toEqual({ bps: 500, maximum: 2_000n });
    expect(transferFeeOf(data, 801n)).toEqual({ bps: 500, maximum: 2_000n });
  });

  it('a fee raised to come is counted only once its epoch arrives, and a fee dropped to zero is none', () => {
    expect(transferFeeOf(scheduled(0, 900n, 300), 899n)).toBeNull();
    expect(transferFeeOf(scheduled(0, 900n, 300), 900n)).toEqual({ bps: 300, maximum: 2_000n });
    expect(transferFeeOf(scheduled(250, 900n, 0), 900n)).toBeNull();
  });

  it('any schedule: the fee read is the one the token program charges at that epoch', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), fc.bigInt({ min: 0n, max: 2n ** 40n }), fc.bigInt({ min: 0n, max: 2n ** 40n }), (a, b, from, epoch) => {
        const bps = epoch >= from ? b : a;
        const fee = transferFeeOf(scheduled(a, from, b), epoch);
        expect(fee === null ? 0 : fee.bps).toBe(bps);
      }),
      PARAMS,
    );
  }, TIMEOUT);
});
