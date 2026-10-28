import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One credential writer at a time across processes. Two commands run in
 * parallel after the access token expires would otherwise both redeem the
 * same refresh token, and the loser would wipe the winner's new session.
 * The lock is a file created exclusively; one older than STALE_MS is treated
 * as left behind by a crash.
 */
// Longer than any operation held under the lock (OAuth requests time out at 15 s).
const STALE_MS = 30_000;
const WAIT_MS = 25_000;

export async function withLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<T> {
  // First run on a machine: the config directory does not exist yet.
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const start = now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lockPath)
        .then((s) => now() - s.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (age > STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (now() - start > WAIT_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      await sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true });
  }
}
