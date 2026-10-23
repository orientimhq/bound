import { resolve6 } from 'node:dns/promises';

/**
 * One instance (ORIENTIM_SINGLE_INSTANCE=1) holds only while it is the only one: a second machine has
 * a memory and a volume of its own, so each would sign a swap into the same output account, each
 * within its own limits. Nothing in `fly.toml` stops a second one (`fly scale count 2`, a clone,
 * another region), so the machine asks Fly's private DNS how many of the app's machines are started
 * (`<app>.internal`, one address each) and, while it sees more than one, signs nothing.
 *
 * An answer that cannot be had (DNS down) changes nothing: the last one stands.
 */
export type MachineGuard = {
  /** Is this the only started machine, as Fly's DNS last said? */
  alone(): boolean;
  /** Asks again now. */
  check(): Promise<void>;
};

const EVERY_MS = 15_000;

export function machineGuard(app: string, resolve: (host: string) => Promise<string[]> = resolve6, log: (m: string) => void = console.error): MachineGuard {
  let machines = 1;
  const check = async () => {
    let addresses: string[];
    try {
      addresses = await resolve(`${app}.internal`);
    } catch {
      return;
    }
    const seen = new Set(addresses).size;
    if (seen > 1 && machines <= 1) log(`${seen} machines of ${app} are started: finalize signs nothing until one is left (fly scale count 1).`);
    machines = seen;
  };
  return { alone: () => machines <= 1, check };
}

let shared: MachineGuard | null = null;

/** The guard for this machine, asking every 15 seconds; null when not one instance on Fly (FLY_APP_NAME). */
export function sharedMachineGuard(): MachineGuard | null {
  const app = process.env.FLY_APP_NAME?.trim();
  if (!app) return null;
  if (!shared) {
    const guard = machineGuard(app);
    void guard.check();
    setInterval(() => void guard.check(), EVERY_MS).unref();
    shared = guard;
  }
  return shared;
}
