import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMultiStopMapsUrl } from "./maps.js";

describe("buildMultiStopMapsUrl", () => {
  it("returns empty for no drops", () => {
    assert.equal(buildMultiStopMapsUrl([]), "");
  });

  it("builds single destination URL", () => {
    const url = buildMultiStopMapsUrl([{ label: "A", address: "Tower 3, OMR" }]);
    assert.match(url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
    assert.match(url, /Tower/);
  });

  it("builds multi-stop with origin destination waypoints", () => {
    const url = buildMultiStopMapsUrl([
      { label: "1", address: "Stop A" },
      { label: "2", address: "Stop B" },
      { label: "3", address: "Stop C" },
    ]);
    assert.match(url, /origin=/);
    assert.match(url, /destination=/);
    assert.match(url, /waypoints=/);
  });
});
