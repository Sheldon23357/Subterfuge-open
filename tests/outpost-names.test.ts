import test from "node:test";
import assert from "node:assert/strict";
import { originalOutpostNames } from "../packages/engine/src/index.js";
import { eventDetails } from "../packages/client/src/copy.js";


test("seeded outpost names are unique and stable for all 2–10 player maps", () => {
  for (let players = 2; players <= 10; players++) {
    const count = players * 10,
      names = originalOutpostNames(4308, count);
    assert.equal(names.length, count);
    assert.equal(new Set(names).size, count);
    assert.ok(names.every((name) => /^[A-Z-]+$/.test(name)));
    assert.deepEqual(originalOutpostNames(4308, count), names);
    assert.deepEqual(originalOutpostNames(4308, 100).slice(0, count), names);
  }
  assert.notDeepEqual(
    originalOutpostNames(4308, 100),
    originalOutpostNames(4309, 100),
  );
});
test("historical naming epoch keeps positional names, current games shuffle without mutating the pool", () => {
  assert.deepEqual(originalOutpostNames(4308, 3, 0), [
    "KYBURZ",
    "CALHAMER",
    "VACCARINO",
  ]);
  assert.notDeepEqual(originalOutpostNames(4308, 3), [
    "KYBURZ",
    "CALHAMER",
    "VACCARINO",
  ]);
  const names = originalOutpostNames(4308, 100);
  names[0] = "changed";
  assert.notEqual(originalOutpostNames(4308, 100)[0], "changed");
  for (const count of [-1, 101, 1.5])
    assert.throws(() => originalOutpostNames(4308, count), RangeError);
  for (const seed of [-1, NaN, 0x100000000])
    assert.throws(() => originalOutpostNames(seed, 10), RangeError);
});
test("event descriptions resolve display names without modifying stored order ids", () => {
  const details = JSON.stringify({
    source: "据点 01",
    destination: "据点 02",
    drillers: 30,
  });
  const names: Record<string, string> = {
    "据点 01": "NEMO",
    "据点 02": "TRITON",
  };
  assert.equal(
    eventDetails(details, (id) => names[id] ?? id),
    "起点：NEMO · 目的地：TRITON · 舰数：30",
  );
  assert.equal(JSON.parse(details).source, "据点 01");
});
