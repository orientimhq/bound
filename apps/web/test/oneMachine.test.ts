import { describe, expect, it } from 'vitest';
import { machineGuard } from '../lib/server/oneMachine.ts';

describe('one machine', () => {
  it('is alone until Fly\'s DNS names a second machine, and again once it names one', async () => {
    let answer: string[] | Error = ['fdaa::1'];
    const said: string[] = [];
    const asked: string[] = [];
    const guard = machineGuard('orientim', async host => {
      asked.push(host);
      if (answer instanceof Error) throw answer;
      return answer;
    }, m => said.push(m));
    expect(guard.alone()).toBe(true);
    await guard.check();
    expect(asked).toEqual(['orientim.internal']);
    expect(guard.alone()).toBe(true);
    answer = ['fdaa::1', 'fdaa::2'];
    await guard.check();
    expect(guard.alone()).toBe(false);
    expect(said).toHaveLength(1);
    // A DNS that does not answer changes nothing: the last answer stands.
    answer = new Error('ESERVFAIL');
    await guard.check();
    expect(guard.alone()).toBe(false);
    answer = ['fdaa::2'];
    await guard.check();
    expect(guard.alone()).toBe(true);
  });
});
