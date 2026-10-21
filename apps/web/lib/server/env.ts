/**
 * Where this server runs, said by the operator rather than guessed from the platform: the checks
 * that keep production safe (a treasury and a fee, the site's own origin, state the instances share)
 * must hold on any host.
 *
 *   ORIENTIM_ENV=production        the public deployment (Vercel's own production counts too)
 *   ORIENTIM_SINGLE_INSTANCE=1     one process serves every request (one Fly machine): its memory is
 *                                  the state every request shares, and nothing it held survives a restart
 */
import { randomBytes } from 'node:crypto';

export const isProduction = () => process.env.ORIENTIM_ENV === 'production' || process.env.VERCEL_ENV === 'production';

export const singleInstance = () => process.env.ORIENTIM_SINGLE_INSTANCE === '1';

/**
 * This process's own id, new at every start. With one instance, a ticket or a session carries it,
 * and one from an earlier start is refused: what that process noted in memory (one message per
 * one-time key, the output accounts held) is gone, so a swap prepared then is prepared again.
 */
export const BOOT_ID = randomBytes(9).toString('base64url');
