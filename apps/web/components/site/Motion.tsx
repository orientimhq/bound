'use client';

import { useEffect, useRef, useState } from 'react';

/** Motion that explains the product; it stops for people who ask their system for less motion. */
function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(q.matches);
    const on = () => setReduce(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return reduce;
}

/**
 * The glass both diagrams are drawn in, under one prefix per drawing so their ids never meet:
 * frosted glass for the wallet and the route, green glass for what protects (the one-time key,
 * the minimum, the lock).
 */
function GlassDefs({ p }: { p: string }) {
  return (
    <defs>
      <linearGradient id={`${p}-glass`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".09" /><stop offset="1" stopColor="#fff" stopOpacity=".025" /></linearGradient>
      <linearGradient id={`${p}-edge`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".28" /><stop offset=".5" stopColor="#fff" stopOpacity=".08" /><stop offset="1" stopColor="#fff" stopOpacity=".05" /></linearGradient>
      <linearGradient id={`${p}-sheen`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".13" /><stop offset=".45" stopColor="#fff" stopOpacity=".015" /><stop offset=".46" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <linearGradient id={`${p}-green`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7ce3b0" stopOpacity=".30" /><stop offset=".55" stopColor="#4cbd85" stopOpacity=".14" /><stop offset="1" stopColor="#4cbd85" stopOpacity=".10" /></linearGradient>
      <linearGradient id={`${p}-green-strong`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7ce3b0" stopOpacity=".62" /><stop offset="1" stopColor="#2f8f5f" stopOpacity=".45" /></linearGradient>
      <linearGradient id={`${p}-green-edge`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c2ffe2" stopOpacity=".9" /><stop offset=".5" stopColor="#7ce3b0" stopOpacity=".38" /><stop offset="1" stopColor="#4cbd85" stopOpacity=".25" /></linearGradient>
      <radialGradient id={`${p}-bubble`} cx=".35" cy=".3" r=".85"><stop offset="0" stopColor="#fff" stopOpacity=".16" /><stop offset=".6" stopColor="#fff" stopOpacity=".04" /><stop offset="1" stopColor="#fff" stopOpacity=".02" /></radialGradient>
      <radialGradient id={`${p}-cyan`} cx=".35" cy=".3" r=".85"><stop offset="0" stopColor="#c8eeff" stopOpacity=".8" /><stop offset="1" stopColor="#5cc8ff" stopOpacity=".5" /></radialGradient>
      <filter id={`${p}-glow`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#4cbd85" floodOpacity=".45" /></filter>
      <filter id={`${p}-glow-cyan`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#5cc8ff" floodOpacity=".45" /></filter>
      <filter id={`${p}-line-glow`} x="-30%" y="-60%" width="160%" height="220%"><feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#7ce3b0" floodOpacity=".6" /></filter>
    </defs>
  );
}
const url = (p: string, name: string) => `url(#${p}-${name})`;

/** A small key, drawn inside the capsule: the one-time key that carries the amount. */
function KeyGlyph({ x, stroke }: { x: number; stroke: string }) {
  return (
    <g transform={`translate(${x - 6.6} -6.6) scale(.55)`} fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2M16 7l3 3M18.5 4.5l2 2" />
    </g>
  );
}

/** One run of the capsule, in seconds. */
const CYCLE_S = 8;
const DUR = `${CYCLE_S}s`;
/** It runs this many times once it is on screen, then rests: motion that explains, then stops. */
const CAPSULE_RUNS = 3;
/** Where it rests, and what people who ask for less motion see: the key carrying the amount along the route. */
const REST_AT = 0.3;

/**
 * The capsule: a one-time key is made for this swap and carries the approved amount across the
 * route; the minimum is checked on chain; the key brings the bought token back to the wallet and is
 * gone. The wallet's other assets never move.
 */
export function CapsuleFlow() {
  const svg = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const rest = CYCLE_S * (reduce ? REST_AT : CAPSULE_RUNS - 1 + REST_AT);
    el.pauseAnimations();
    el.setCurrentTime(reduce ? rest : 0);
    if (reduce) return;
    // It plays only while on screen, and once it reaches its rest it stays there.
    const seen = new IntersectionObserver(([entry]) => {
      if (el.getCurrentTime() >= rest) return;
      if (entry.isIntersecting) el.unpauseAnimations();
      else el.pauseAnimations();
    }, { threshold: 0.35 });
    seen.observe(el);
    const done = setInterval(() => {
      if (el.getCurrentTime() < rest) return;
      el.pauseAnimations();
      el.setCurrentTime(rest);
      clearInterval(done);
    }, 100);
    return () => {
      seen.disconnect();
      clearInterval(done);
    };
  }, [reduce]);

  return (
    <svg ref={svg} className="capsule" viewBox="0 0 960 300" role="img" aria-labelledby="capsule-title">
      <title id="capsule-title">
        Only what you approved leaves your wallet, and only the amount goes across the swap route. You get at least your minimum, or nothing
        happens. The rest of your wallet never moves.
      </title>
      <GlassDefs p="cf" />
      <rect x="20" y="40" width="210" height="220" rx="20" fill={url('cf', 'glass')} stroke={url('cf', 'edge')} />
      <rect x="20" y="40" width="210" height="220" rx="20" fill={url('cf', 'sheen')} />
      <text x="40" y="70" className="svg-label">Your wallet</text>
      <g className="svg-chip">
        <rect x="40" y="88" width="80" height="30" rx="15" /><text x="80" y="108">SOL</text>
        <rect x="130" y="88" width="80" height="30" rx="15" /><text x="170" y="108">USDC</text>
        <rect x="40" y="128" width="80" height="30" rx="15" /><text x="80" y="148">BONK</text>
        <rect x="130" y="128" width="80" height="30" rx="15" /><text x="170" y="148">NFTs</text>
      </g>
      <g transform="translate(112 180)">
        <path d="M5 12 v-5 a8 8 0 0 1 16 0 v5" fill="none" stroke="#7ce3b0" strokeWidth="3" />
        <rect x="0" y="12" width="26" height="20" rx="4" fill={url('cf', 'green-strong')} stroke={url('cf', 'green-edge')} filter={url('cf', 'glow')} />
        <rect x="0" y="12" width="26" height="20" rx="4" fill={url('cf', 'sheen')} />
      </g>
      <text x="125" y="238" textAnchor="middle" className="svg-text">never handed to the route</text>

      <path id="capsule-out" d="M230 150 C 300 150, 320 110, 390 110 L 560 110 C 620 110, 640 150, 690 150" fill="none" stroke="rgba(220,236,230,.16)" strokeWidth="2" strokeDasharray="4 6" />
      <path id="capsule-back" d="M790 200 C 780 250, 600 272, 420 272 C 300 272, 250 250, 232 212" fill="none" stroke="rgba(220,236,230,.16)" strokeWidth="2" strokeDasharray="4 6" />
      {[440, 520].map(cx => (
        <g key={cx}>
          <circle cx={cx} cy="110" r="22" fill={url('cf', 'bubble')} stroke={url('cf', 'edge')} />
          <ellipse cx={cx - 8} cy="99" rx="8" ry="3.5" fill="rgba(255,255,255,.22)" />
          <text x={cx} y="114" textAnchor="middle" className="svg-text">pool</text>
        </g>
      ))}
      <text x="480" y="66" textAnchor="middle" className="svg-label">The swap route</text>
      <text x="480" y="84" textAnchor="middle" className="svg-text">Solana’s markets</text>
      <text x="244" y="190" className="svg-text">only the approved amount</text>

      <g transform="translate(710 100)">
        <rect x="0" y="0" width="160" height="100" rx="16" fill={url('cf', 'green')} stroke={url('cf', 'green-edge')} filter={url('cf', 'glow')} />
        <rect x="0" y="0" width="160" height="100" rx="16" fill={url('cf', 'sheen')} />
        <text x="80" y="36" textAnchor="middle" className="svg-label">Minimum</text>
        <text x="80" y="56" textAnchor="middle" className="svg-text">or nothing happens</text>
        <path d="M64 74 l10 10 l22 -22" fill="none" stroke="#7ce3b0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.55;.62;.9;1" dur={DUR} repeatCount="indefinite" />
        </path>
      </g>

      {/* The key, made at the wallet's edge, carries the amount along the route to the minimum. */}
      <g opacity="0">
        <animateMotion dur={DUR} repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;.06;.5;1" calcMode="linear"><mpath href="#capsule-out" /></animateMotion>
        <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;.06;.5;.56;1" dur={DUR} repeatCount="indefinite" />
        <g>
          <animateTransform attributeName="transform" type="scale" values=".5;1;1" keyTimes="0;.06;1" dur={DUR} repeatCount="indefinite" />
          <rect x="-46" y="-14" width="92" height="28" rx="14" fill={url('cf', 'green-strong')} stroke={url('cf', 'green-edge')} filter={url('cf', 'glow')} />
          <rect x="-46" y="-14" width="92" height="28" rx="14" fill={url('cf', 'sheen')} />
          <KeyGlyph x={-30} stroke="#f0fff7" />
          <text x="8" y="4" textAnchor="middle" className="svg-capsule">1.5 SOL</text>
        </g>
      </g>
      {/* It comes back with what was bought, hands it to the wallet, and comes apart. */}
      <g opacity="0">
        <animateMotion dur={DUR} repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;.62;.9;1" calcMode="linear"><mpath href="#capsule-back" /></animateMotion>
        <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;.6;.63;.9;.96;1" dur={DUR} repeatCount="indefinite" />
        <g>
          <animateTransform attributeName="transform" type="scale" values="1;1;.4;.4" keyTimes="0;.9;.96;1" dur={DUR} repeatCount="indefinite" />
          <rect x="-44" y="-14" width="88" height="28" rx="14" fill={url('cf', 'cyan')} stroke="rgba(200,238,255,.6)" filter={url('cf', 'glow-cyan')} />
          <rect x="-44" y="-14" width="88" height="28" rx="14" fill={url('cf', 'sheen')} />
          <KeyGlyph x={-28} stroke="#04121c" />
          <text x="8" y="4" textAnchor="middle" className="svg-token">USDC</text>
        </g>
      </g>
      <g transform="translate(232 212)">
        {[[-18, -14], [16, -16], [-20, 10], [14, 14], [0, -22]].map(([dx, dy]) => (
          <rect key={`${dx},${dy}`} x="-2.5" y="-2.5" width="5" height="5" rx="1" fill="#7ce3b0" opacity="0">
            <animate attributeName="opacity" values="0;0;.9;0;0" keyTimes="0;.9;.93;.98;1" dur={DUR} repeatCount="indefinite" />
            <animateTransform attributeName="transform" type="translate" values={`0 0;0 0;${dx} ${dy};${dx} ${dy}`} keyTimes="0;.9;.98;1" dur={DUR} repeatCount="indefinite" />
          </rect>
        ))}
      </g>
      {/* The wallet's USDC takes what arrived. */}
      <rect x="130" y="88" width="80" height="30" rx="15" fill="none" stroke="#7ce3b0" strokeWidth="1.5" opacity="0">
        <animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;.9;.93;.99;1" dur={DUR} repeatCount="indefinite" />
      </rect>
      <text x="600" y="294" textAnchor="middle" className="svg-text">then the tokens you bought come back to your wallet</text>
      <text x="600" y="294" textAnchor="middle" className="svg-text svg-good" opacity="0">
        then the tokens you bought come back to your wallet
        <animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;.9;.94;.99;1" dur={DUR} repeatCount="indefinite" />
      </text>
    </svg>
  );
}

const TERMINAL: [string, string][] = [
  ['dim', '# example run'],
  ['dim', '$ swap 0.01 SOL → USDC   # protected'],
  ['ok', '✓ checked on the agent’s own RPC · only 0.01 SOL and the fees shown can move'],
  ['ok', '✓ signed by the agent · finished with a one-time key'],
  ['cy', '✓ confirmed on mainnet · received 1.222039 USDC'],
  ['', ''],
  ['dim', '# the same agent, behind a tampered server'],
  ['bad', '✗ refused · the fee was sent to an unknown wallet'],
  ['ok', '✓ nothing was signed'],
];

/** An example agent run on mainnet, then the same agent refusing a tampered swap. */
export function AgentTerminal() {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(TERMINAL.length);
  // Typed once, line by line, when it comes into view; then it stays whole to be read.
  useEffect(() => {
    const el = box.current;
    if (reduce || !el) {
      setShown(TERMINAL.length);
      return;
    }
    setShown(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      seen.disconnect();
      let n = 0;
      const tick = () => {
        n += 1;
        setShown(n);
        if (n < TERMINAL.length) timer = setTimeout(tick, 650);
      };
      timer = setTimeout(tick, 400);
    }, { threshold: 0.4 });
    seen.observe(el);
    return () => {
      seen.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [reduce]);

  return (
    <div ref={box} className="terminal" aria-label="An agent's protected swap, and a refused attack">
      <div className="terminal-bar"><span /><span /><span /><em>agent · mainnet</em></div>
      <pre aria-hidden={!reduce}>
        {TERMINAL.slice(0, shown).map(([kind, line], i) => <span key={i} className={kind}>{line}{'\n'}</span>)}
        {shown < TERMINAL.length && <span className="caret" />}
      </pre>
    </div>
  );
}

type Station = 'idle' | 'active' | 'done' | 'warned' | 'fail' | 'skipped';
type Checks = {
  st: [Station, Station, Station];
  /** Rules ticked at Orientim and at the agent. */
  r1: number;
  r2: number;
  /** The agent's R2 failed: the lying server's swap carries a transfer the rules do not allow. */
  refused: boolean;
  /** The link the transaction is crossing: 1 to the agent, 2 to the chain, 0 none. */
  link: 0 | 1 | 2;
  verdict: 'good' | 'bad' | null;
};
const RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const CHECKED: Checks = { st: ['done', 'done', 'done'], r1: 7, r2: 7, refused: false, link: 0, verdict: 'good' };

/** The frames of one run, each with the time it shows, in ms from the start. */
function checkFrames(lie: boolean): [number, Partial<Checks>][] {
  const f: [number, Partial<Checks>][] = [[0, { st: ['active', 'idle', 'idle'], r1: 0, r2: 0, refused: false, link: 0, verdict: null }]];
  let t = 150;
  if (lie) {
    f.push([t += 500, { st: ['warned', 'idle', 'idle'] }]);
  } else {
    for (let i = 1; i <= 7; i++) f.push([t += 110, { r1: i }]);
    f.push([t += 150, { st: ['done', 'idle', 'idle'] }]);
  }
  f.push([t += 200, { link: 1 }]);
  f.push([t += 750, { link: 0, st: [lie ? 'warned' : 'done', 'active', 'idle'] }]);
  if (lie) {
    f.push([t += 150, { r2: 1 }]);
    f.push([t += 200, { refused: true }]);
    f.push([t += 250, { st: ['warned', 'fail', 'skipped'] }]);
    f.push([t += 300, { verdict: 'bad' }]);
    return f;
  }
  for (let i = 1; i <= 7; i++) f.push([t += 110, { r2: i }]);
  f.push([t += 150, { st: ['done', 'done', 'idle'] }]);
  f.push([t += 200, { link: 2 }]);
  f.push([t += 750, { link: 0, st: ['done', 'done', 'active'] }]);
  f.push([t += 700, { st: ['done', 'done', 'done'] }]);
  f.push([t += 300, { verdict: 'good' }]);
  return f;
}

function StationBadge() {
  return (
    <span className="ct-badge" aria-hidden="true">
      <svg viewBox="0 0 20 20" className="ct-i-idle"><circle cx="10" cy="10" r="2.2" fill="currentColor" /></svg>
      <svg viewBox="0 0 20 20" className="ct-i-ok"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <svg viewBox="0 0 20 20" className="ct-i-no"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
    </span>
  );
}

/**
 * The skill flow verifies twice: by Orientim when it builds the swap, and again next to the
 * signer on the client's own RPC before the wallet signs; then the chain enforces the minimum. Plays once
 * when it comes into view; "What if the server lies?" shows a compromised server's swap refused by
 * the agent. At rest, and for people who ask for less motion, all three checks are shown passed.
 */
export function CheckedTwice() {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [view, setView] = useState<Checks>(CHECKED);
  const [run, setRun] = useState(0);

  const play = (lie: boolean) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRun(n => n + 1);
    const frames = checkFrames(lie);
    if (reduce) {
      setView(frames.reduce<Checks>((v, [, change]) => ({ ...v, ...change }), CHECKED));
      return;
    }
    for (const [at, change] of frames) timers.current.push(setTimeout(() => setView(v => ({ ...v, ...change })), at));
  };

  useEffect(() => {
    const el = box.current;
    if (reduce || !el) return;
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      seen.disconnect();
      play(false);
    }, { threshold: 0.35 });
    seen.observe(el);
    return () => {
      seen.disconnect();
      timers.current.forEach(clearTimeout);
    };
  }, [reduce]);

  const rules = (ticked: number, failR2 = false) => (
    <div className="ct-rules">
      {RULES.map((r, i) => <span key={r} className={`ct-rule${failR2 && i === 1 ? ' x' : i < ticked ? ' on' : ''}`}>{r}</span>)}
    </div>
  );
  const link = (n: 1 | 2) => (
    <div className={`ct-link${view.st[0] === 'warned' ? ' bad' : ''}`} aria-hidden="true">
      {view.link === n && <span key={run} className="ct-pkt" />}
    </div>
  );

  return (
    <div ref={box} className="ct">
      <div className="ct-stations">
        <div className={`ct-st ${view.st[0]}`}>
          <div className="ct-head"><span className="ct-who">Orientim</span><StationBadge /></div>
          <h4>Builds the swap and checks it</h4>
          <p>Every instruction against its rules, before anything is sent to your agent.</p>
          {rules(view.r1)}
          {view.st[0] === 'warned' && <p className="ct-tag warn">Compromised server: it says the swap is fine.</p>}
        </div>
        {link(1)}
        <div className={`ct-st ${view.st[1]}`}>
          <div className="ct-head"><span className="ct-who">Your skill or verifying bot</span><StationBadge /></div>
          <h4>Checks it again, on its own</h4>
          <p>The same transaction, the same rules, on its own connection to Solana. Only then does its wallet sign.</p>
          {rules(view.r2, view.refused)}
          {view.st[1] === 'fail' && <p className="ct-tag bad">An extra instruction sends your tokens elsewhere. Refused before signing.</p>}
        </div>
        {link(2)}
        <div className={`ct-st ${view.st[2]}`}>
          <div className="ct-head"><span className="ct-who">Solana</span><StationBadge /></div>
          <h4>Enforces the minimum</h4>
          <p>If less than the minimum would arrive, the whole swap cancels: nothing is traded, and only the network fee is paid.</p>
          <p className="ct-floor"><span>minimum</span><span>≥ 1.215929 USDC</span></p>
        </div>
      </div>
      <div className="ct-verdict">
        <p role="status" className={view.verdict ?? 'wait'}>
          {view.verdict === 'bad' ? 'The wallet never signed. Nothing moved.' : 'With the skill or verifier: checked twice before Solana enforces the minimum.'}
        </p>
        <div className="ct-controls">
          <button type="button" className="ct-btn" onClick={() => play(false)}>Replay</button>
          <button type="button" className="ct-btn lie" onClick={() => play(true)}>What if the server lies?</button>
        </div>
      </div>
    </div>
  );
}
