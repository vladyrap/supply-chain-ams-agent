import { logger } from "./logger";

interface RetryOptions {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  retryOn?: (err: unknown) => boolean;
  label?: string;
}

const DEFAULT_RETRY_ON = (err: unknown): boolean => {
  const msg = (err as { message?: string } | null)?.message ?? "";
  return /5\d\d|429|UNAVAILABLE|INTERNAL|RESOURCE_EXHAUSTED|ETIMEDOUT|ECONN|fetch failed/i.test(msg);
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 12000,
    factor = 2,
    retryOn = DEFAULT_RETRY_ON,
    label = "operation",
  } = opts;

  let attempt = 0;
  let delay = initialDelayMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const shouldRetry = attempt <= retries && retryOn(err);
      if (!shouldRetry) throw err;
      const jitter = Math.floor(Math.random() * 400);
      const wait = Math.min(delay, maxDelayMs) + jitter;
      logger.warn(
        { attempt, retries, waitMs: wait, label, err: (err as Error)?.message },
        `${label}: reintentando`
      );
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * factor, maxDelayMs);
    }
  }
}
