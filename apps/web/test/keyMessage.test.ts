/**
 * The page signs an API-key message only if it is exactly Orientim's, the same rule as the skill:
 * a tampered challenge answer cannot add lines for the wallet to sign under orientim.com.
 */
import { describe, expect, it } from 'vitest';
import { isApiKeyMessage } from '../../../skills/orientim-protected-swap/examples/swap.ts';
import { isKeyMessage } from '../lib/client/keyMessage.ts';
import { challengeMessage } from '../lib/server/agent/keys.ts';

const W = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
/** When the challenge was issued, in ms: the page checks the message against its own clock. */
const NOW = 1_790_000_000_000;
const message = challengeMessage({ domain: 'orientim.com', uri: 'https://orientim.com/developers#access', wallet: W, nonce: 'abc123', issuedAt: 1_790_000_000 });

describe('the page checks the key message as strictly as the skill', () => {
  const cases: [string, unknown, string, string][] = [
    ["Orientim's message for this wallet", message, 'orientim.com', W],
    ['another site', message, 'orientim.example', W],
    ['another wallet', message, 'orientim.com', '11111111111111111111111111111111'],
    ['an extra line appended', `${message}\nTransfer: all of it`, 'orientim.com', W],
    ['text inserted after the address', message.replace(`${W}\n\n`, `${W}\nApprove everything\n`), 'orientim.com', W],
    ['a field with spaces in its value', message.replace(/^Nonce: .*$/m, 'Nonce: two words'), 'orientim.com', W],
    ['a non-printable character', `${message}\u0000`, 'orientim.com', W],
    ['not a string', 42, 'orientim.com', W],
  ];

  it.each(cases)('%s', (_name, text, host, wallet) => {
    expect(isKeyMessage(text, host, wallet, NOW)).toBe(isApiKeyMessage(text, `https://${host}`, wallet));
  });

  it('accepts the real message and refuses a tampered one', () => {
    expect(isKeyMessage(message, 'orientim.com', W, NOW)).toBe(true);
    expect(isKeyMessage(`${message}\nTransfer: all of it`, 'orientim.com', W, NOW)).toBe(false);
  });

  it('refuses a message missing a field, for another chain or page, without expiry, or long expired', () => {
    for (const bad of [
      message.replace(/\nExpiration Time: .*$/m, ''),
      message.replace(/\nNonce: .*$/m, ''),
      message.replace('Chain ID: mainnet', 'Chain ID: devnet'),
      message.replace('URI: https://orientim.com/developers#access', 'URI: https://evil.example/'),
      message.replace(/^Expiration Time: .*$/m, 'Expiration Time: 2099-01-01T00:00:00.000Z'),
      message.replace('Version: 1\nChain ID: mainnet', 'Chain ID: mainnet\nVersion: 1'),
    ]) expect(isKeyMessage(bad, 'orientim.com', W, NOW), bad).toBe(false);
    expect(isKeyMessage(message, 'orientim.com', W, NOW + 3_600_000)).toBe(false);
  });
});
