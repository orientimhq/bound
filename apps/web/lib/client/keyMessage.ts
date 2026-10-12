/**
 * Is `message` Orientim's API-key message for `wallet`, from `host`, and nothing else? The same
 * rule as the skill's `isApiKeyMessage`: a wallet's signature over bytes a server chose could, for
 * bytes shaped like a transaction, be a signature for that transaction, so only this exact text is
 * ever signed (AGENT-API.md, "API access").
 */
export function isKeyMessage(message: unknown, host: string, wallet: string, now = Date.now()): message is string {
  if (typeof message !== 'string' || message.length > 1_000 || !/^[\x20-\x7e\n]+$/.test(message)) return false;
  const lines = message.split('\n');
  // Every field, in the order Orientim's server writes them: a message without an expiry, for
  // another chain or naming another page is not Orientim's, even with the right first lines.
  const field = (i: number, name: string, value: RegExp) => {
    const m = new RegExp(`^${name}: (.+)$`).exec(lines[i] ?? '');
    return m !== null && value.test(m[1]) ? m[1] : null;
  };
  const isoTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;
  const issued = Date.parse(field(9, 'Issued At', isoTime) ?? '');
  const expires = Date.parse(field(10, 'Expiration Time', isoTime) ?? '');
  return lines.length === 11
    && lines[0] === `${host} wants you to sign in with your Solana account:`
    && lines[1] === wallet && lines[2] === ''
    && lines[3] === 'Get an Orientim API key for this wallet. Signing costs nothing and gives no access to your funds.'
    && lines[4] === ''
    && (lines[5] === `URI: https://${host}/developers#access` || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && lines[5] === `URI: http://${host}/developers#access`))
    && lines[6] === 'Version: 1'
    && lines[7] === 'Chain ID: mainnet'
    && field(8, 'Nonce', /^[A-Za-z0-9_-]{6,64}$/) !== null
    // Issued now, give or take a slow clock, and valid for a quarter of an hour at most.
    && Math.abs(issued - now) <= 15 * 60_000
    && expires > issued && expires - issued <= 15 * 60_000;
}
