import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request audit actor. The store is created in an `onRequest` hook via `run()` (so it
 * propagates into later hooks and the route handler) and filled in once the session is known.
 * `enterWith()` inside an async preHandler does NOT reach the handler.
 */
const requestActorAls = new AsyncLocalStorage<{ actor?: string }>();

export function runWithRequestActorStore(done: () => void) {
  requestActorAls.run({}, done);
}

export function setRequestActor(actor: string | undefined) {
  const store = requestActorAls.getStore();
  if (store) store.actor = actor;
}

export function currentRequestActor(): string | undefined {
  return requestActorAls.getStore()?.actor;
}
