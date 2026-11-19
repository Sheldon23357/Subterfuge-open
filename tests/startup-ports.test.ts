import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("an occupied listener fails startup before creating storage or rotating player credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subterfuge-startup-")),
    probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  try {
    for (const kind of ["lab", "player"]) {
      const dataDir = join(dir, kind),
        free = createServer();
      free.listen(0, "127.0.0.1");
      await once(free, "listening");
      const open = free.address();
      assert.ok(open && typeof open === "object");
      await new Promise<void>((r) => free.close(() => r()));
      const child = spawn(
        process.execPath,
        [resolve("dist/packages/server/src/main.js")],
        {
          env: {
            ...process.env,
            LAB_DATA_DIR: dataDir,
            LAB_PORT: String(kind === "lab" ? address.port : open.port),
            PLAYER_PORT: String(kind === "player" ? address.port : open.port),
            GAME_CLOCK: "realtime",
          },
          stdio: "pipe",
        },
      );
      let errors = "";
      child.stderr!.on("data", (chunk) => {
        errors += chunk;
      });
      const [code] = await once(child, "exit");
      assert.notEqual(code, 0);
      assert.match(errors, /EADDRINUSE/);
      await assert.rejects(access(dataDir));
    }
  } finally {
    await new Promise<void>((r) => probe.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
