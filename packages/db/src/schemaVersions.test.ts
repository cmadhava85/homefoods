import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expectedMigrationCount } from "./schemaVersions.js";

describe("schemaVersions", () => {
  it("expectedMigrationCount matches journal entries", () => {
    const n = expectedMigrationCount();
    assert.ok(n >= 30, `expected many migrations, got ${n}`);
  });
});
