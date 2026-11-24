/**
 * Shared outbound HTTP with timeout, safe JSON parse, and optional idempotent retries.
 * Used by Razorpay / Meta so brownouts don't hang the API pool forever.
 */

export type FetchWithTimeoutOptions = {
  timeoutMs: number;
  retries?: number;
  /** Retry only on network error / 429 / 5xx when true (caller should require Idempotency-Key). */
  retryOnTransient?: boolean;
  provider?: string;
  path?: string;
  traceId?: string;
  /** Optional logger — keep adapters free of a hard observability dependency. */
  log?: (fields: Record<string, unknown>, msg: string) => void;
};

export class UpstreamHttpError extends Error {
  readonly statusCode: 502 | 503 | 504;
  readonly provider: string;
  readonly upstreamStatus?: number;

  constructor(
    message: string,
    statusCode: 502 | 503 | 504,
    provider: string,
    upstreamStatus?: number,
  ) {
    super(message);
    this.name = "UpstreamHttpError";
    this.statusCode = statusCode;
    this.provider = provider;
    this.upstreamStatus = upstreamStatus;
  }
}

async function parseBody(res: Response): Promise<{ json?: unknown; text: string }> {
  const text = await res.text();
  if (!text) return { text: "" };
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { text };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  opts: FetchWithTimeoutOptions,
): Promise<{ res: Response; json?: unknown; text: string; durationMs: number }> {
  const provider = opts.provider ?? "upstream";
  const path = opts.path ?? url;
  const maxAttempts = 1 + Math.max(0, opts.retries ?? 0);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const durationMs = Date.now() - started;
      const parsed = await parseBody(res);
      opts.log?.(
        {
          event: "third_party.request",
          provider,
          path,
          status: res.status,
          durationMs,
          attempt,
          traceId: opts.traceId,
        },
        "third_party.request",
      );

      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        if (transient && opts.retryOnTransient && attempt < maxAttempts) {
          await sleep(150 * attempt);
          continue;
        }
        const mapped: 502 | 503 | 504 =
          res.status === 429 || res.status === 503 ? 503 : res.status === 504 ? 504 : 502;
        throw new UpstreamHttpError(
          `Upstream ${provider} ${path} failed (${res.status})`,
          mapped,
          provider,
          res.status,
        );
      }
      return { res, ...parsed, durationMs };
    } catch (err) {
      lastErr = err;
      const durationMs = Date.now() - started;
      const timedOut =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError" || /aborted|timeout/i.test(err.message));
      opts.log?.(
        {
          event: "third_party.request",
          provider,
          path,
          status: timedOut ? 504 : 0,
          durationMs,
          attempt,
          err: err instanceof Error ? err.message : String(err),
          traceId: opts.traceId,
        },
        "third_party.request",
      );
      if (err instanceof UpstreamHttpError) throw err;
      if (timedOut) {
        if (opts.retryOnTransient && attempt < maxAttempts) {
          await sleep(150 * attempt);
          continue;
        }
        throw new UpstreamHttpError(`Upstream ${provider} timed out`, 504, provider);
      }
      if (opts.retryOnTransient && attempt < maxAttempts) {
        await sleep(150 * attempt);
        continue;
      }
      throw new UpstreamHttpError(
        err instanceof Error ? err.message : `Upstream ${provider} failed`,
        502,
        provider,
      );
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new UpstreamHttpError(`Upstream ${provider} failed`, 502, provider);
}
