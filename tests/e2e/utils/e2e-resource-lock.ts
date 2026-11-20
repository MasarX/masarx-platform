import * as fs from "node:fs/promises";
import * as path from "node:path";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLockKey(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function resolveLockRoot(rootDir?: string) {
  return path.resolve(rootDir || path.join(process.cwd(), "tmp", "e2e-resource-locks"));
}

function resolveLockDir(rootDir: string, key: string) {
  return path.join(rootDir, normalizeLockKey(key));
}

async function ensureLockRoot(rootDir: string) {
  await fs.mkdir(rootDir, { recursive: true });
}

async function removeLockDir(lockDir: string) {
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
}

async function isLockStale(lockDir: string, staleAfterMs: number) {
  if (!(staleAfterMs > 0)) return false;
  try {
    const stats = await fs.stat(lockDir);
    return Date.now() - stats.mtimeMs >= staleAfterMs;
  } catch {
    return false;
  }
}

async function acquireSingleLock(params: {
  key: string;
  rootDir: string;
  timeoutMs: number;
  pollMs: number;
  staleAfterMs: number;
}) {
  const { key, rootDir, timeoutMs, pollMs, staleAfterMs } = params;
  const normalizedKey = normalizeLockKey(key);
  if (!normalizedKey) {
    throw new Error("E2E resource lock key must be non-empty.");
  }

  const lockDir = resolveLockDir(rootDir, normalizedKey);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify(
          {
            key,
            normalized_key: normalizedKey,
            pid: process.pid,
            acquired_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      return {
        key,
        normalizedKey,
        lockDir,
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code || "").trim()
          : "";
      if (code !== "EEXIST") {
        throw error;
      }

      if (await isLockStale(lockDir, staleAfterMs)) {
        await removeLockDir(lockDir);
        continue;
      }

      await sleep(pollMs);
    }
  }

  throw new Error(`Timed out waiting for E2E resource lock "${normalizedKey}".`);
}

export async function withExclusiveE2EResourceLocks<T>(params: {
  keys: string[];
  fn: () => Promise<T>;
  rootDir?: string;
  timeoutMs?: number;
  pollMs?: number;
  staleAfterMs?: number;
}) {
  const { fn } = params;
  const rootDir = resolveLockRoot(params.rootDir);
  const timeoutMs = params.timeoutMs ?? 180_000;
  const pollMs = params.pollMs ?? 250;
  const staleAfterMs = params.staleAfterMs ?? 900_000;
  const keys = Array.from(
    new Set(
      (params.keys || [])
        .map((value) => normalizeLockKey(value))
        .filter(Boolean),
    ),
  ).sort();

  if (keys.length === 0) {
    return await fn();
  }

  await ensureLockRoot(rootDir);

  const acquired: Array<{ key: string; normalizedKey: string; lockDir: string }> = [];
  try {
    for (const key of keys) {
      acquired.push(
        await acquireSingleLock({
          key,
          rootDir,
          timeoutMs,
          pollMs,
          staleAfterMs,
        }),
      );
    }

    return await fn();
  } finally {
    for (const lock of acquired.reverse()) {
      await removeLockDir(lock.lockDir);
    }
  }
}
