/**
 * Surface API request ids (X-Request-Id / body.requestId) in user-visible errors
 * and stash the last one for the Next.js error boundary.
 */
const LAST_REF_KEY = "lm_last_request_ref";

export function rememberRequestRef(ref: string | null | undefined) {
  if (typeof window === "undefined" || !ref) return;
  try {
    sessionStorage.setItem(LAST_REF_KEY, ref);
  } catch {
    /* private mode / quota */
  }
}

export function readLastRequestRef(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(LAST_REF_KEY);
  } catch {
    return null;
  }
}

export function requestIdFromResponse(
  res: Response,
  body?: { requestId?: unknown } | null,
): string | null {
  const header = res.headers.get("X-Request-Id")?.trim();
  if (header) return header;
  const fromBody = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  return fromBody || null;
}

/** Append "Reference: …" when a request id is present. */
export function withRequestRef(message: string, requestId: string | null | undefined): string {
  if (!requestId) return message;
  rememberRequestRef(requestId);
  if (message.includes(requestId)) return message;
  return `${message} (Reference: ${requestId})`;
}

/** Parse a failed API response into a user-facing Error with request ref. */
export async function apiErrorFromResponse(res: Response, fallback = `API ${res.status}`): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    requestId?: string;
  };
  const requestId = requestIdFromResponse(res, body);
  rememberRequestRef(requestId);
  return new Error(withRequestRef(body.error ?? fallback, requestId));
}
