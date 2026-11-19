import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ChatStore } from "../packages/server/src/chat.js";
import { createEightPlayerScenario } from "../packages/server/src/eight-player.js";
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
test("secret coalition membership is stable across senders, private to members, and idempotent across recipient ordering", async t => {
  const dir = await mkdtemp(join(tmpdir(), "subterfuge-group-chat-")),
    path = join(dir, "chat.json");
  let chat = new ChatStore(path);
  await chat.load();
  const room = { state: createEightPlayerScenario(), scheduled: [] },
    h=protocolHarness(t,{room}),server=await createOwnerPlayerApi(h,{chat:()=>chat});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const a = server.address();
  assert.ok(a && typeof a === "object");
  const url = `http://127.0.0.1:${a.port}`;
  const request = (seat: number, path: string, data?: unknown) =>
    fetch(url + path, {
      headers: {
        Authorization: `Bearer ${h.ownerCredentials.credentials[seat]!.token}`,
        "Content-Type":"application/json",
      },
      ...(data === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(data) }),
    });
  const threads = async (seat: number) =>
    (await (await request(seat, "/player/v2/owner/chat/conversations")).json())
      .conversations;
  try {
    const outside = await threads(3),
      world = JSON.stringify(h.store.load()!.room),
      revision = (await (await request(3, "/player/v2/owner/observation")).json()).revision;
    const first = await (
      await request(0, "/player/v2/owner/chat", {
        id: "offer",
        to: [2, 1],
        text: "Coalition offer",
      })
    ).json();
    assert.ok(first.message,JSON.stringify(first));assert.deepEqual(first.message.to, [1, 2]);
    assert.deepEqual(
      await (
        await request(0, "/player/v2/owner/chat", {
          id: "offer",
          to: [1, 2],
          text: "Coalition offer",
        })
      ).json(),
      first,
    );
    assert.equal(
      (
        await request(1, "/player/v2/owner/chat", {
          id: "reply",
          to: [2, 0],
          text: "Agreed",
        })
      ).status,
      200,
    );
    assert.deepEqual(
      (await threads(0)).find((t: { id: string }) => t.id === "0,1,2").members,
      [0, 1, 2],
    );
    assert.equal(
      (await threads(0)).find((t: { id: string }) => t.id === "0,1,2").unread,
      1,
    );
    assert.equal(
      (await threads(2)).find((t: { id: string }) => t.id === "0,1,2").unread,
      2,
    );
    assert.deepEqual(await threads(3), outside);
    assert.equal(
      (await (await request(3, "/player/v2/owner/chat")).json()).messages.length,
      0,
    );
    assert.equal(
      (await (await request(3, "/player/v2/owner/observation")).json()).revision,
      revision,
    );
    assert.equal(
      (await request(3, "/player/v2/owner/chat/seen", { conversation: "0,1,2", through: 2 }))
        .status,
      400,
    );
    for (const to of [[], [0, 1], [1, 1], [1, 8], [-1, 2], ["1", 2]])
      assert.equal(
        (await request(0, "/player/v2/owner/chat", { id: "bad", to, text: "bad" })).status,
        400,
      );
    assert.equal(
      (await request(0, "/player/v2/owner/chat/seen", { conversation: "0,1,2", through: 3 }))
        .status,
      400,
    );
    await request(0, "/player/v2/owner/chat/seen", { conversation: "0,1,2", through: 1 });
    assert.equal(
      (await threads(0)).find((t: { id: string }) => t.id === "0,1,2").unread,
      1,
    );
    await request(0, "/player/v2/owner/chat/seen", { conversation: "0,1,2", through: 2 });
    await request(0, "/player/v2/owner/chat/seen", { conversation: "0,1,2", through: 1 });
    assert.equal(
      (await threads(0)).find((t: { id: string }) => t.id === "0,1,2").unread,
      0,
    );
    await request(2, "/player/v2/owner/chat", {
      id: "later",
      to: [0, 1],
      text: "Later message",
    });
    const restored = new ChatStore(path);
    await restored.bindDurable(h.repository.domainDocument(()=>h.repository.currentEpoch(h.roomId),'chat','journal'));
    chat = restored;
    assert.equal(
      (await threads(0)).find((t: { id: string }) => t.id === "0,1,2").unread,
      1,
    );
    assert.equal(chat.listForSeat(3).length, 0);
    assert.equal(JSON.stringify(h.store.load()!.room), world);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("legacy message arrays migrate atomically, persisted reads are validated and write failure leaves unread state unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subterfuge-chat-read-")),
    path = join(dir, "chat.json");
  try {
    const original = [
      { id: "a", from: 0, to: 1, text: "one", tick: 100, sentAt: 1 },
      { id: "b", from: 1, to: 0, text: "two", tick: 101, sentAt: 2 },
    ];
    await writeFile(path, JSON.stringify(original));
    const chat = new ChatStore(path);
    await chat.load();
    assert.equal(
      chat.conversationsForSeat(0).find((t) => t.id === "0,1")!.unread,
      1,
    );
    await mkdir(path + ".tmp");
    await assert.rejects(() => chat.markSeenFromSeat(0, "0,1", 2));
    assert.equal(
      chat.conversationsForSeat(0).find((t) => t.id === "0,1")!.unread,
      1,
    );
    await rm(path + ".tmp", { recursive: true });
    await chat.markSeenFromSeat(0, "0,1", 2);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.format, "chat-store/2");
    assert.deepEqual(saved.messages, original);
    const restored = new ChatStore(path);
    await restored.load();
    assert.equal(
      restored.conversationsForSeat(0).find((t) => t.id === "0,1")!.unread,
      0,
    );
    for (const reads of [
      [{ player: 0, conversation: "0,1", through: 3 }],
      [{ player: 2, conversation: "0,1", through: 1 }],
      [{ player: 0, conversation: "__proto__", through: 0 }],
    ]) {
      await writeFile(path, JSON.stringify({ ...saved, reads }));
      await assert.rejects(() => new ChatStore(path).load(), /Invalid chat/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
