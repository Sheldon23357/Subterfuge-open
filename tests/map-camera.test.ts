import test from "node:test";
import assert from "node:assert/strict";
import {
  homeCamera,
  zoomCameraAt,
  easeMapZoom,
} from "../packages/client/src/map-camera.js";
test("home camera centers and frames territory crossing both wrapped seams", () => {
  const size = { width: 100, height: 80 },
    viewport = { width: 1200, height: 700 };
  const points = [
    { x: 98, y: 77 },
    { x: 2, y: 3 },
    { x: 5, y: 79 },
  ];
  const camera = homeCamera(points, size, viewport),
    scale =
      Math.min(viewport.width / size.width, viewport.height / size.height) *
      0.88 *
      camera.zoom;
  const center = { x: -camera.x / scale, y: -camera.y / scale };
  assert.ok(center.x < 6 || center.x > 97);
  assert.ok(center.y < 4 || center.y > 76);
  for (const p of points) {
    const dx = p.x - center.x,
      dy = p.y - center.y;
    assert.ok(
      Math.abs((dx - Math.round(dx / 100) * 100) * scale) <
        viewport.width / 2 - 50,
    );
    assert.ok(
      Math.abs((dy - Math.round(dy / 80) * 80) * scale) <
        viewport.height / 2 - 50,
    );
  }
});
test("home camera handles one surviving outpost, no territory and compact viewports", () => {
  for (const viewport of [
    { width: 1200, height: 700 },
    { width: 390, height: 400 },
  ]) {
    const c = homeCamera(
        [{ x: -8, y: 12 }],
        { width: 100, height: 80 },
        viewport,
      ),
      scale =
        Math.min(viewport.width / 100, viewport.height / 80) * 0.88 * c.zoom;
    assert.ok(Math.abs(-c.x / scale - 92) < 1e-6);
    assert.ok(Math.abs(-c.y / scale - 12) < 1e-6);
    assert.ok(
      Object.values(homeCamera([], { width: 100, height: 80 }, viewport)).every(
        Number.isFinite,
      ),
    );
  }
});

test("zoom preserves the same world point under off-center cursor at all scales", () => {
  for (const zoom of [0.65, 1, 3.5, 8])
    for (const target of [0.65, 1.4, 8])
      for (const anchor of [
        { x: -500, y: -250 },
        { x: 320, y: 170 },
        { x: 0, y: 0 },
      ]) {
        const before = { x: 1300, y: -950, zoom },
          after = zoomCameraAt(before, target, anchor);
        assert.ok(
          Math.abs(
            (anchor.x - before.x) / before.zoom -
              (anchor.x - after.x) / after.zoom,
          ) < 1e-8,
        );
        assert.ok(
          Math.abs(
            (anchor.y - before.y) / before.zoom -
              (anchor.y - after.y) / after.zoom,
          ) < 1e-8,
        );
      }
});
test("zoom eases monotonically, respects reversal and is independent of refresh rate", () => {
  for (const target of [0.65, 8]) {
    let z = 3.5;
    for (let i = 0; i < 60; i++) {
      const next = easeMapZoom(z, target, 16);
      assert.ok(next >= Math.min(z, target) && next <= Math.max(z, target));
      z = next;
    }
    assert.ok(Math.abs(z - target) < 0.001);
  }
  const full = easeMapZoom(1, 8, 32),
    halves = easeMapZoom(easeMapZoom(1, 8, 16), 8, 16);
  assert.ok(Math.abs(full - halves) < 1e-10);
  const inward = easeMapZoom(1, 8, 16),
    outward = easeMapZoom(inward, 0.65, 16);
  assert.ok(inward > 1 && inward < 8);
  assert.ok(outward < inward && outward > 0.65);
});
