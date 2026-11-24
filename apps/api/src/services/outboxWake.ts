/**
 * Wakes the scale-to-zero worker after outbox rows are committed.
 *
 * enqueueOutbox() marks the process dirty; the API's onResponse hook (after the request's
 * transaction has committed) calls flush(), which publishes ONE Pub/Sub message per debounce window.
 * The worker's push subscription turns that into POST /drain. A 1-minute Cloud Scheduler call to
 * /drain is the safety net, so a lost wake only delays a notification — it never drops it.
 *
 * No-op unless OUTBOX_WAKE_TOPIC (projects/<p>/topics/<t>) is set — local dev polls instead.
 */
import { createServiceLogger } from "@localmeals/observability";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type WarnLogger = { warn: (obj: object, msg?: string) => void };

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export type OutboxWakerOptions = {
  topic?: string;
  fetchImpl?: FetchLike;
  debounceMs?: number;
  logger?: WarnLogger;
};

export function createOutboxWaker(opts: OutboxWakerOptions = {}) {
  const topic = opts.topic?.trim();
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const debounceMs = opts.debounceMs ?? 250;
  let dirty = false;
  let pending: Promise<void> | null = null;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const res = await doFetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) throw new Error(`metadata token ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return token.value;
  }

  async function publish() {
    const res = await doFetch(`https://pubsub.googleapis.com/v1/${topic}:publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: [{ data: Buffer.from("wake").toString("base64") }] }),
    });
    if (!res.ok) throw new Error(`pubsub publish ${res.status}`);
  }

  /** Coalesces bursts: every response in the debounce window shares one publish. */
  function flush(): Promise<void> {
    if (!topic || !dirty) return Promise.resolve();
    if (pending) return pending;
    pending = new Promise<void>((resolve) => setTimeout(resolve, debounceMs))
      .then(async () => {
        // Clear before publishing so rows enqueued meanwhile trigger another wake.
        dirty = false;
        await publish();
      })
      .catch((err) => {
        opts.logger?.warn({ err }, "outbox wake publish failed — scheduler fallback will drain");
      })
      .finally(() => {
        pending = null;
        if (dirty) void flush();
      });
    return pending;
  }

  return {
    enabled: Boolean(topic),
    markDirty() {
      if (topic) dirty = true;
    },
    flush,
  };
}

let shared: ReturnType<typeof createOutboxWaker> | null = null;

export function outboxWaker() {
  shared ??= createOutboxWaker({
    topic: process.env.OUTBOX_WAKE_TOPIC,
    logger: createServiceLogger("localmeals-api"),
  });
  return shared;
}

/** Test hook. */
export function setOutboxWaker(w: ReturnType<typeof createOutboxWaker> | null) {
  shared = w;
}
