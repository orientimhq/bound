import { put } from '@vercel/blob';

/**
 * The record that a wallet accepted the Terms of Use: the message it signed for an API key, which
 * names the Terms, and its signature, so that anyone can check later that this wallet signed this
 * text. Nothing else about the person: no IP address, no balance.
 */
export type Acceptance = {
  wallet: string;
  /** The Terms the message names, and the date they took effect then (LEGAL.lastUpdated). */
  terms: string;
  termsUpdated: string;
  message: string;
  signature: string;
  acceptedAt: string;
  keyExpiresAt: string;
  /** The skill's version, when a copy of the skill asked (x-orientim-skill). */
  skill: string | null;
};

export type RecordAcceptance = (a: Acceptance) => Promise<void>;

/**
 * Each acceptance as its own private file in a Vercel Blob store (BLOB_READ_WRITE_TOKEN), by day:
 * terms-acceptances/2026-10-14/<wallet>-<time>-<random>.json. Never overwritten, never listed by
 * the site, readable only with the store's token.
 */
export function blobRecorder(token: string): RecordAcceptance {
  return async a => {
    const day = a.acceptedAt.slice(0, 10);
    const time = a.acceptedAt.slice(11, 19).replaceAll(':', '');
    await put(`terms-acceptances/${day}/${a.wallet}-${time}.json`, `${JSON.stringify(a, null, 2)}\n`, {
      access: 'private', addRandomSuffix: true, contentType: 'application/json', token,
    });
  };
}
