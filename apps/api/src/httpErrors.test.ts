import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z, ZodError } from "zod";
import {
  httpStatusForError,
  publicErrorMessage,
  resolveRequestLocale,
} from "./httpErrors.js";
import { t } from "@localmeals/i18n";
import type { FastifyRequest } from "fastify";

describe("resolveRequestLocale", () => {
  it("prefers x-locale header", () => {
    const req = {
      headers: { "x-locale": "ta", "accept-language": "en" },
    } as unknown as FastifyRequest;
    assert.equal(resolveRequestLocale(req), "ta");
  });

  it("uses accept-language when x-locale missing", () => {
    const req = {
      headers: { "accept-language": "ta-IN,ta;q=0.9" },
    } as unknown as FastifyRequest;
    assert.equal(resolveRequestLocale(req), "ta");
  });

  it("falls back to default", () => {
    const req = { headers: {} } as unknown as FastifyRequest;
    assert.equal(resolveRequestLocale(req), "en");
  });
});

describe("publicErrorMessage", () => {
  it("formats Zod issues", () => {
    try {
      z.object({ mobile: z.string().min(8) }).parse({ mobile: "1" });
    } catch (e) {
      assert.match(publicErrorMessage(e, "en"), /String|mobile|8/i);
    }
  });

  it("formats Zod Required with path", () => {
    try {
      z.object({ qty: z.number() }).parse({});
    } catch (e) {
      const msg = publicErrorMessage(e, "en");
      assert.match(msg, /qty|Required|required/i);
    }
  });

  it("hides database internals and localizes", () => {
    assert.equal(
      publicErrorMessage(
        new Error('insert or update on table "addresses" violates foreign key constraint'),
        "en",
      ),
      t("en", "error.generic"),
    );
    assert.equal(
      publicErrorMessage(new Error("Choose a delivery address"), "ta"),
      t("ta", "error.chooseAddress"),
    );
  });

  it("softens signature failures", () => {
    assert.equal(
      publicErrorMessage(new Error("bad signature"), "en"),
      t("en", "error.verifyRequest"),
    );
  });

  it("stringifies non-Error values", () => {
    assert.ok(publicErrorMessage("plain", "en").length > 0);
    assert.ok(publicErrorMessage(null, "en").length > 0);
  });
});

describe("httpStatusForError", () => {
  it("maps Unauthorized to 401 and not found to 404", () => {
    assert.equal(httpStatusForError(new Error("Unauthorized")), 401);
    assert.equal(httpStatusForError(new Error("error.unauthorized")), 401);
    assert.equal(httpStatusForError(new Error("Please sign in to continue")), 401);
    assert.equal(httpStatusForError(new Error("Kitchen not found")), 404);
    assert.equal(httpStatusForError(new Error("error.orderNotFound")), 404);
  });

  it("maps forbidden, conflict, and DB failures", () => {
    assert.equal(httpStatusForError(new Error("Forbidden")), 403);
    assert.equal(httpStatusForError(new Error("not your kitchen")), 403);
    assert.equal(httpStatusForError(new Error("not your order")), 403);
    assert.equal(httpStatusForError(new Error("mock-confirm disabled")), 403);
    assert.equal(httpStatusForError(new Error("amount does not match")), 409);
    assert.equal(httpStatusForError(new Error("ECONNREFUSED postgres")), 500);
    assert.equal(httpStatusForError(new Error("duplicate key value")), 500);
  });

  it("honours statusCode on thrown objects", () => {
    assert.equal(httpStatusForError(Object.assign(new Error("x"), { statusCode: 418 })), 418);
    assert.equal(httpStatusForError(Object.assign(new Error("x"), { statusCode: 200 })), 400);
  });

  it("maps Zod to 400", () => {
    try {
      z.object({ qty: z.number() }).parse({});
    } catch (e) {
      assert.ok(e instanceof ZodError);
      assert.equal(httpStatusForError(e), 400);
    }
  });

  it("defaults unknown errors to 400", () => {
    assert.equal(httpStatusForError(new Error("something went sideways")), 400);
  });
});
