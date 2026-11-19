import test from 'node:test';
import {execFileSync} from 'node:child_process';

test("command-time.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-command-time.mjs','--check']);
});
test("endgame-scenario.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-endgame.mjs','--check']);
});
test("fleet-movement.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-fleet-motion.mjs','--check']);
});
test("forecast-global-effects.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-specialist-economy.mjs','--check']);
});
test("forecast-knowledge.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-forecast.mjs','--check']);
});
test("forecast-notifications.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-forecast-notifications.mjs','--check']);
});
test("forecast-recruitment.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-recruitment.mjs','--check']);
});
test("inactivity.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-inactivity.mjs','--check']);
});
test("lobby-events.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-announcements.mjs','--check']);
});
test("map-generation.test.ts: locked source excerpts", () => {
execFileSync(process.execPath, ["scripts/extract-map.mjs", "--check"]);
});
test("martyr-scenario.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-martyr.mjs','--check']);
});
test("original-lobby.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-lobby.mjs','--check']);
});
test("original-recruitment.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-recruitment.mjs','--check']);
});
test("outpost-names.test.ts: locked source excerpts", () => {
execFileSync(process.execPath, [
    "scripts/extract-outpost-names.mjs",
    "--check",
  ]);
});
test("player-announcements.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-announcements.mjs','--check']);
});
test("player-forecast.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-scheduling.mjs','--check']);
});
test("player-notifications.test.ts: locked source excerpts", () => {
execFileSync(process.execPath, [
    "scripts/extract-notifications.mjs",
    "--check",
  ]);
execFileSync(process.execPath, [
    "scripts/extract-specialist-economy.mjs",
    "--check",
  ]);
});
test("public-intel.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-public-intel.mjs','--check']);
execFileSync(process.execPath,['scripts/extract-specialist-economy.mjs','--check']);
});
test("recruitment-preview.test.ts: locked source excerpts", () => {
execFileSync(process.execPath, [
    "scripts/extract-recruitment.mjs",
    "--check",
  ]);
});
test("royal-scenario.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-royal.mjs','--check']);
});
test("scheduled-orders.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-scheduling.mjs','--check']);
});
test("specialist-combat.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-global-combat.mjs','--check']);
});
test("specialist-economy.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-specialist-economy.mjs','--check']);
});
test("waiting-world.test.ts: locked source excerpts", () => {
execFileSync(process.execPath,['scripts/extract-recall.mjs','--check']);
});
