import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installProcessLifecycle } from "./lifecycle.js";

function fakeProc() {
  const em = new EventEmitter();
  const exits: number[] = [];
  return {
    em,
    exits,
    proc: {
      on: (event: string, l: (...a: unknown[]) => void) => em.on(event, l),
      exit: (code: number) => void exits.push(code),
    },
  };
}
const silent = { info: () => {}, error: () => {} };

test("SIGTERM runs every step once in order and exits 0", async () => {
  const { em, exits, proc } = fakeProc();
  const calls: string[] = [];
  const lc = installProcessLifecycle({
    service: "t",
    logger: silent,
    proc,
    steps: [
      { name: "a", run: async () => void calls.push("a") },
      { name: "b", run: () => void calls.push("b") },
    ],
  });
  em.emit("SIGTERM");
  em.emit("SIGTERM");
  await lc.shutdown("again", 0);
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(exits, [0]);
});

test("a failing step does not block later steps", async () => {
  const { exits, proc } = fakeProc();
  const calls: string[] = [];
  const lc = installProcessLifecycle({
    service: "t",
    logger: silent,
    proc,
    steps: [
      { name: "boom", run: () => Promise.reject(new Error("x")) },
      { name: "db", run: () => void calls.push("db") },
    ],
  });
  await lc.shutdown("SIGTERM", 0);
  assert.deepEqual(calls, ["db"]);
  assert.deepEqual(exits, [0]);
});

test("uncaughtException exits 1 after cleanup", async () => {
  const { em, exits, proc } = fakeProc();
  let closed = false;
  const lc = installProcessLifecycle({
    service: "t",
    logger: silent,
    proc,
    steps: [{ name: "db", run: () => void (closed = true) }],
  });
  em.emit("uncaughtException", new Error("bug"));
  await lc.shutdown("ignored", 0);
  assert.equal(closed, true);
  assert.deepEqual(exits, [1]);
});

test("a hung step is cut off by the timeout", async () => {
  const { exits, proc } = fakeProc();
  const lc = installProcessLifecycle({
    service: "t",
    logger: silent,
    proc,
    timeoutMs: 20,
    steps: [{ name: "hang", run: () => new Promise(() => {}) }],
  });
  await lc.shutdown("SIGTERM", 0);
  assert.deepEqual(exits, [0]);
});

test("unhandledRejection is logged but not fatal", () => {
  const { em, exits, proc } = fakeProc();
  const errors: unknown[] = [];
  installProcessLifecycle({
    service: "t",
    logger: { info: () => {}, error: (o) => void errors.push(o) },
    proc,
    steps: [],
  });
  em.emit("unhandledRejection", new Error("late"));
  assert.equal(errors.length, 1);
  assert.deepEqual(exits, []);
});
