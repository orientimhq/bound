/**
 * The agent API's route handlers, as Next.js calls them: each reaches its handler only when the
 * deployment's settings turn the API on, and answers `not-enabled` otherwise. The handlers
 * themselves are tested in agentApi.test.ts and agentKeys.test.ts.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { POST as prepare } from '../app/api/v1/prepare/route.ts';
import { POST as finalize } from '../app/api/v1/finalize/route.ts';
import { POST as keys } from '../app/api/v1/keys/route.ts';

const post = (path: string, body: unknown, key?: string) => new Request(`https://orientim.com/api/v1/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const SET = ['ORIENTIM_API_SECRET', 'ORIENTIM_API_KEYS', 'ORIENTIM_DISABLED'] as const;

describe('the agent API routes', () => {
  afterEach(() => {
    for (const name of SET) delete process.env[name];
  });

  it('answer not-enabled while the deployment leaves the API off', async () => {
    for (const res of [await prepare(post('prepare', {})), await finalize(post('finalize', {})), await keys(post('keys', {}))]) {
      expect(res.status).toBe(404);
      expect(await codeOf(res)).toBe('not-enabled');
    }
  });

  it('reach their handlers once it is on: a request without a key is refused there, and a pause is said', async () => {
    process.env.ORIENTIM_API_SECRET = Buffer.alloc(32, 9).toString('base64');
    process.env.ORIENTIM_API_KEYS = `routes:${createHash('sha256').update('ori_routes_test_key_0001').digest('hex')}`;
    expect((await prepare(post('prepare', {}))).status).toBe(401);
    expect((await finalize(post('finalize', {}))).status).toBe(401);
    // A known key with a body that is not a swap: the handler's own refusal.
    const res = await prepare(post('prepare', { owner: 'not-an-address' }, 'ori_routes_test_key_0001'));
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('bad-request');
    process.env.ORIENTIM_DISABLED = '1';
    const paused = await prepare(post('prepare', {}, 'ori_routes_test_key_0001'));
    expect(paused.status).toBe(503);
    expect(await codeOf(paused)).toBe('paused');
  });
});
