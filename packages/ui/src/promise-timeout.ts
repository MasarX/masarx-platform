export class TimeoutError extends Error {
  override name = "TimeoutError";
}

const resolveNumberEnv = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

export function resolveUiRpcTimeoutMs() {
  return resolveNumberEnv(process.env.MASARX_UI_RPC_TIMEOUT_MS, 15_000);
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out."
): Promise<T> {
  const timeoutMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new TimeoutError(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

