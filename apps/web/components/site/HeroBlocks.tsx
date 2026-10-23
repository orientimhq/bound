'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The wallet as a chain of blocks beside the headline, on the grid behind the home page. Once, when
 * the page opens, one block (the amount) lights, leaves the group and steps along the grid into the
 * agent's terminal, its links to the chain opening behind it; the rest of the wallet stays where it is. After that, one block of the grid lights
 * softly every 10 to 15 seconds, only in the hero's empty space and only while the hero is on
 * screen. Nothing moves for people who ask their system for less motion; phones get the grid alone.
 */

/** One cell of the grid, in CSS pixels: the same as `.page-grid`'s background-size. */
const CELL = 56;
const OPEN_DELAY_MS = 1000;
const LIGHT_MS = 500;
const STEP_MS = 450;
const RETURN_AFTER_MS = 1500;

type Wallet = { col0: number; row0: number; cols: number; rows: number; steps: number; moveCol: number; moveRow: number };

type Box = { left: number; top: number; right: number; bottom: number };

const relative = (r: DOMRect, to: DOMRect): Box => ({ left: r.left - to.left, top: r.top - to.top, right: r.right - to.left, bottom: r.bottom - to.top });

function lineBoxes(el: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  return [...range.getClientRects()];
}

/**
 * Where the wallet fits: beside the title and level with it, between the title and the terminal (or,
 * with the terminal below the title, between the title and the page's edge). Null when it does not fit,
 * or on a phone.
 */
function placeWallet(root: HTMLElement): Wallet | null {
  const box = root.getBoundingClientRect();
  const scope = root.parentElement;
  const title = scope?.querySelector('.hero-title');
  const app = scope?.querySelector('.hero-app');
  if (!title || !app || box.width <= 640) return null;
  const wide = box.width > 980;
  const lines = lineBoxes(title).map(r => relative(r, box));
  if (!lines.length) return null;
  const textRight = Math.max(...lines.map(r => r.right));
  const top = lines[0].top, bottom = lines[lines.length - 1].bottom;
  const endX = wide ? relative(app.getBoundingClientRect(), box).left : box.width;
  const col0 = Math.ceil((textRight + 18) / CELL);
  // Up to three columns, clear of the card by a few pixels: the block's path may be short.
  const cols = Math.min(3, Math.floor((endX - 8 - col0 * CELL) / CELL));
  // As many rows as the title is tall, up to three, centred on it.
  const rows = Math.min(3, Math.round((bottom - top) / CELL));
  const row0 = Math.round((top + bottom) / 2 / CELL - rows / 2);
  if (cols < 2 || rows < 2) return null;
  const moveCol = col0 + cols - 1;
  const steps = Math.max(2, Math.ceil((endX - (moveCol + 1) * CELL) / CELL) + 1);
  return { col0, row0, cols, rows, steps, moveCol, moveRow: row0 + Math.floor(rows / 2) };
}

/** The links of the chain: one to the right of each block and one below it, inside the wallet. */
function links(w: Wallet): [number, number, 'h' | 'v'][] {
  const out: [number, number, 'h' | 'v'][] = [];
  for (let row = w.row0; row < w.row0 + w.rows; row++) {
    for (let col = w.col0; col < w.col0 + w.cols; col++) {
      if (col + 1 < w.col0 + w.cols) out.push([col, row, 'h']);
      if (row + 1 < w.row0 + w.rows) out.push([col, row, 'v']);
    }
  }
  return out;
}

export function HeroBlocks() {
  const root = useRef<HTMLDivElement>(null);
  const runner = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLDivElement>(null);
  const lights = useRef<HTMLDivElement>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [away, setAway] = useState(false);

  // Where the wallet sits, again on every resize.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWallet(placeWallet(el)));
    };
    void document.fonts?.ready.then(place);
    place();
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
    };
  }, []);

  // The wallet as it is placed now, for a move that starts later; and whether the move has played.
  const latest = useRef<Wallet | null>(null);
  const played = useRef(false);
  useEffect(() => {
    latest.current = wallet;
  }, [wallet]);

  const placed = wallet !== null;
  // The amount leaves the wallet once per page, when it opens, from where the wallet is placed then.
  useEffect(() => {
    const el = root.current;
    if (!placed || !el || played.current) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const running: Animation[] = [];
    timers.push(setTimeout(() => {
      const wallet = latest.current;
      const hero = el.parentElement?.querySelector('.hero')?.getBoundingClientRect();
      if (!wallet || !hero || hero.bottom <= 0 || hero.top >= innerHeight) return;
      played.current = true;
      const moveMs = wallet.steps * STEP_MS;
      const total = LIGHT_MS + moveMs + 300;
      const frames = (peak: number, light: boolean): Keyframe[] => {
        const f: Keyframe[] = [{ offset: 0, opacity: 0, transform: 'translateX(0)' }];
        f.push({ offset: LIGHT_MS / total, opacity: light ? peak : 0, transform: 'translateX(0)', easing: 'ease-in-out' });
        for (let i = 1; i <= wallet.steps; i++) {
          f.push({ offset: (LIGHT_MS + i * STEP_MS) / total, opacity: peak, transform: `translateX(${i * CELL}px)`, easing: 'ease-in-out' });
        }
        f.push({ offset: 1, opacity: 0, transform: `translateX(${wallet.steps * CELL}px)` });
        return f;
      };
      if (runner.current) running.push(runner.current.animate(frames(1, true), { duration: total, fill: 'forwards' }));
      if (trail.current) running.push(trail.current.animate(frames(0.28, false), { duration: total, delay: 110, fill: 'forwards' }));
      timers.push(setTimeout(() => setAway(true), LIGHT_MS));
      timers.push(setTimeout(() => setAway(false), total + RETURN_AFTER_MS));
    }, OPEN_DELAY_MS));
    return () => {
      timers.forEach(clearTimeout);
      running.forEach(a => a.cancel());
      setAway(false);
    };
    // Once per page: a resize moves the wallet, and hiding and showing it again does not replay the swap.
  }, [placed]);

  // Then, now and then, one block of the hero's empty space lights softly.
  useEffect(() => {
    const el = root.current;
    const layer = lights.current;
    const hero = el?.parentElement?.querySelector('.hero');
    if (!el || !layer || !hero) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let visible = true;
    const seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    seen.observe(hero);
    let timer: ReturnType<typeof setTimeout>;
    const light = () => {
      const box = el.getBoundingClientRect();
      if (visible && document.visibilityState === 'visible' && box.width > 640) {
        const h = relative(hero.getBoundingClientRect(), box);
        const busy = [...(el.parentElement?.querySelectorAll('.hero-copy > *, .hero-app, .hb-wallet') ?? [])]
          .map(n => relative(n.getBoundingClientRect(), box));
        for (let tries = 0; tries < 24; tries++) {
          const col = Math.floor(Math.random() * Math.floor(box.width / CELL));
          const row = Math.ceil(h.top / CELL) + Math.floor(Math.random() * Math.max(1, Math.floor((h.bottom - h.top) / CELL) - 1));
          const x = col * CELL, y = row * CELL;
          if (y + CELL > h.bottom) continue;
          if (busy.some(b => x + CELL > b.left - 8 && x < b.right + 8 && y + CELL > b.top - 8 && y < b.bottom + 8)) continue;
          const lit = document.createElement('div');
          lit.className = 'hb-lit';
          lit.style.transform = `translate(${x}px, ${y}px)`;
          lit.addEventListener('animationend', () => lit.remove());
          layer.appendChild(lit);
          break;
        }
      }
      timer = setTimeout(light, 10_000 + Math.random() * 5_000);
    };
    timer = setTimeout(light, 10_000 + Math.random() * 5_000);
    return () => {
      clearTimeout(timer);
      seen.disconnect();
    };
  }, []);

  const at = (col: number, row: number) => ({ transform: `translate(${col * CELL}px, ${row * CELL}px)` });
  return (
    <div ref={root} className="hero-blocks" aria-hidden="true">
      {wallet && (
        <>
          <div
            className="hb-light"
            style={{ transform: `translate(${(wallet.col0 + wallet.cols / 2) * CELL - 320}px, ${(wallet.row0 + wallet.rows / 2) * CELL - 320}px)` }}
          />
          <div
            className="hb-wallet"
            style={{ ...at(wallet.col0, wallet.row0), width: wallet.cols * CELL, height: wallet.rows * CELL }}
          />
          {Array.from({ length: wallet.cols * wallet.rows }, (_, i) => {
            const col = wallet.col0 + (i % wallet.cols), row = wallet.row0 + Math.floor(i / wallet.cols);
            const moving = col === wallet.moveCol && row === wallet.moveRow;
            return <div key={`${col}:${row}`} className={`hb-tile${moving && away ? ' away' : ''}`} style={at(col, row)} />;
          })}
          {links(wallet).map(([col, row, dir]) => {
            const open = away && ((dir === 'h' && col + 1 === wallet.moveCol && row === wallet.moveRow)
              || (dir === 'v' && col === wallet.moveCol && (row === wallet.moveRow || row + 1 === wallet.moveRow)));
            const x = col * CELL + (dir === 'h' ? 40 : 23), y = row * CELL + (dir === 'h' ? 23 : 42);
            return <div key={`${dir}${col}:${row}`} className={`hb-link ${dir}${open ? ' open' : ''}`} style={{ transform: `translate(${x}px, ${y}px)` }} />;
          })}
          <div className={`hb-slot${away ? ' on' : ''}`} style={at(wallet.moveCol, wallet.moveRow)} />
          <div className="hb-move" style={at(wallet.moveCol, wallet.moveRow)}>
            <div ref={trail} className="hb-runner" />
            <div ref={runner} className="hb-runner" />
          </div>
        </>
      )}
      <div ref={lights} />
    </div>
  );
}
