import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT = 'Orientim: protected swaps on Solana, for AI agents and bots. Give your agent a wallet, not a blank cheque.';

/** One block of the mark, in the image's own units. */
function Block({ x, y, s, color, opacity = 1 }: { x: number; y: number; s: number; color: string; opacity?: number }) {
  return <div style={{ position: 'absolute', left: x, top: y, width: s, height: s, borderRadius: s * 0.275, background: color, opacity }} />;
}

/** The logo mark (Brand.tsx), drawn at any size: the wallet as four blocks, the green one stepped out. */
export function Mark({ size }: { size: number }) {
  const u = size / 32;
  return (
    <div style={{ position: 'relative', display: 'flex', width: size, height: size, borderRadius: 9 * u, background: '#141e22', border: `${Math.max(1, u)}px solid #2a3b42` }}>
      <Block x={6 * u} y={8.5 * u} s={8 * u} color="#8a9c95" opacity={0.5} />
      <Block x={6 * u} y={18.5 * u} s={8 * u} color="#8a9c95" opacity={0.5} />
      <Block x={16 * u} y={18.5 * u} s={8 * u} color="#8a9c95" opacity={0.5} />
      <Block x={18.2 * u} y={4.3 * u} s={8 * u} color="#4cbd85" />
    </div>
  );
}

/** The card shown when a link to orientim.com is shared. */
export function ogCard() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          padding: '72px 80px', background: '#0c1117', color: '#f4faf6',
          backgroundImage: 'radial-gradient(60% 70% at 85% 30%, rgba(76, 189, 133, .22), transparent 70%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <Mark size={72} />
          <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: -1.5 }}>Orientim</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2.2, maxWidth: 960 }}>
            Protected swaps on Solana, for AI agents and bots.
          </div>
          <div style={{ fontSize: 32, color: '#98a8a2' }}>Give your agent a wallet, not a blank cheque.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 26, color: '#7ce3b0' }}>
          <div style={{ width: 14, height: 14, borderRadius: 4, background: '#4cbd85' }} />
          orientim.com
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
