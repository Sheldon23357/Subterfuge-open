import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatStore } from "../packages/server/src/chat.js";
import { CommanderStore } from "../packages/server/src/commander-store.js";
import type { DurableDomainDocument } from "../packages/server/src/durable-domain-store.js";
import { sqliteTransaction } from "../packages/server/src/sqlite-transaction.js";
import type {
  CommanderThread,
  ChatMessage,
} from "../packages/contracts/src/index.js";
import { createEightPlayerScenario } from "../packages/server/src/eight-player.js";
import { observation } from "../packages/server/src/player-api.js";
import { protocolHarness } from "./player-protocol-test-helpers.js";

/** Real temporary SQLite, using the same connection/savepoint contract as the repository. */
class SqliteDocuments {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT);
      CREATE TABLE IF NOT EXISTS changes (name TEXT NOT NULL, kind TEXT NOT NULL);
    `);
  }
  document(name: string): DurableDomainDocument {
    const read = () => {
      const row = this.db
        .prepare("SELECT payload FROM documents WHERE name=?")
        .get(name);
      return row ? String(row.payload) : null;
    };
    return {
      read,
      initialize: (payload, sourceDigest) =>
        sqliteTransaction(this.db, () => {
          const old = read();
          if (old !== null) return old;
          this.db
            .prepare("INSERT INTO documents VALUES (?, ?, ?)")
            .run(name, payload, sourceDigest);
          this.db.prepare("INSERT INTO changes VALUES (?, 'import')").run(name);
          return payload;
        }),
      transact: <T>(
        change: (current: string) => { payload: string; result: T },
      ): T =>
        sqliteTransaction(this.db, () => {
          const current = read();
          if (current === null) throw Error("Missing document");
          const next = change(current);
          if (next.payload !== current) {
            this.db
              .prepare("UPDATE documents SET payload=? WHERE name=?")
              .run(next.payload, name);
            this.db
              .prepare("INSERT INTO changes VALUES (?, 'change')")
              .run(name);
          }
          return next.result;
        }),
    };
  }
  changes(name: string, kind: string) {
    return Number(
      this.db
        .prepare("SELECT count(*) AS n FROM changes WHERE name=? AND kind=?")
        .get(name, kind)!.n,
    );
  }
  failWrites() {
    this.db.exec(
      "CREATE TRIGGER injected_failure BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END",
    );
  }
  allowWrites() {
    this.db.exec("DROP TRIGGER injected_failure");
  }
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "domain-migration-")),
    path = join(dir, "room.sqlite"),
    backend = new SqliteDocuments(path);
  const connections = [backend];
  t.after(() => {
    for (const connection of connections.reverse()) connection.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    backend,
    connect: () => {
      const connection = new SqliteDocuments(path);
      connections.push(connection);
      return connection;
    },
    file: (name: string) => join(dir, name + ".json"),
  };
}
const message = (id: string, tick = 10): ChatMessage => ({
  id,
  from: 0,
  to: 1,
  text: "Synthetic private message " + id,
  tick,
  sentAt: 1000 + tick,
});
const transcript = (messages: ChatMessage[], reads: unknown[] = []) =>
  JSON.stringify({ format: "chat-store/2", messages, reads });
const thread = (): CommanderThread => ({
  roomId: "synthetic-room",
  player: 0,
  directives: { version: 1, text: "Hold position", appliedVersion: 0 },
  messages: [
    {
      id: "synthetic-proposal-message",
      role: "assistant",
      text: "Synthetic proposal",
      references: [],
      tick: 10,
      sentAt: 1000,
      status: "completed",
      proposal: {
        id: "synthetic-proposal",
        baseVersion: 0,
        text: "Hold position",
        summary: "Defend",
        status: "confirmed",
      },
    },
  ],
});
const journal = (value = thread()) =>
  JSON.stringify({ format: "commander-store/1", threads: [value] });
const obs = () =>
  observation(
    { state: createEightPlayerScenario(), scheduled: [] },
    0,
    "synthetic-room",
  );

test("chat imports once, retains the source digest/file, and never reads or dual-writes legacy data again", async (t) => {
  const f = fixture(t),
    file = f.file("chat"),
    source = JSON.stringify([message("imported")], null, 2);
  writeFileSync(file, source);
  const chat = new ChatStore(file),
    doc = f.backend.document("chat");
  await chat.bindDurable(doc);
  assert.deepEqual(chat.listForSeat(1), [message("imported")]);
  assert.deepEqual(chat.listForSeat(2), []);
  assert.equal(
    f.backend.db
      .prepare("SELECT digest FROM documents WHERE name='chat'")
      .get()!.digest,
    createHash("sha256").update(source).digest("hex"),
  );
  chat.sendFromSeatSync(
    1,
    { id: "reply", to: 0, text: "Synthetic reply" },
    3,
    11,
  );
  chat.markSeenFromSeatSync(1, "0,1", 2);
  assert.equal(
    chat.conversationsForSeat(1).find((c) => c.id === "0,1")!.unread,
    0,
  );
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal(f.backend.changes("chat", "import"), 1);
  writeFileSync(file, "corrupt leftover, not authoritative");
  await chat.load();
  const restarted = new ChatStore(file);
  await restarted.bindDurable(f.backend.document("chat"));
  assert.deepEqual(restarted.listForSeat(0), chat.listForSeat(0));
  // Reading a directory as a file fails, so success proves SQL was consulted first.
  const unreadableLegacy = new ChatStore(f.dir);
  await unreadableLegacy.bindDurable(f.backend.document("chat"));
  await unreadableLegacy.sendFromSeat(
    0,
    { id: "later", to: null, text: "New SQL-only message" },
    3,
    12,
  );
  assert.equal(chat.cursorForSeat(0), 3);
  assert.equal(f.backend.changes("chat", "import"), 1);
  assert.equal(
    readFileSync(file, "utf8"),
    "corrupt leftover, not authoritative",
  );
});

test("commander imports full proposals/directives once and all async/sync updates remain SQL-only", async (t) => {
  const f = fixture(t),
    file = f.file("commander"),
    source = journal();
  writeFileSync(file, source);
  const commander = new CommanderStore(file);
  await commander.bindDurable(f.backend.document("commander"));
  assert.deepEqual(commander.read("synthetic-room", 0), thread());
  assert.equal(commander.read("synthetic-room", 1).messages.length, 0);
  assert.equal(commander.read("different-room", 0).messages.length, 0);
  commander.workerSync(
    "synthetic-room",
    0,
    { op: "ack", version: 1, reply: "Synthetic acknowledgement" },
    11,
  );
  await commander.send(
    "synthetic-room",
    0,
    { id: "discussion", text: "Change the plan?", references: [] },
    obs(),
  );
  const reply = commander.workerSync(
    "synthetic-room",
    0,
    {
      op: "reply",
      messageId: "discussion",
      reply: "Synthetic proposal",
      proposal: { baseVersion: 1, text: "", summary: "Clear directives" },
    },
    12,
  );
  const proposal = reply.messages.at(-1)!.proposal!;
  const confirmed = commander.confirmSync(
    "synthetic-room",
    0,
    { proposalId: proposal.id, version: 1 },
    12,
  );
  assert.equal(confirmed.directives.version, 2);
  assert.equal(confirmed.directives.text, "");
  assert.equal(confirmed.directives.appliedVersion, 1);
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal(
    f.backend.db
      .prepare("SELECT digest FROM documents WHERE name='commander'")
      .get()!.digest,
    createHash("sha256").update(source).digest("hex"),
  );
  writeFileSync(file, "invalid stale JSON");
  await commander.load();
  const restarted = new CommanderStore(f.dir);
  await restarted.bindDurable(f.backend.document("commander"));
  assert.deepEqual(restarted.read("synthetic-room", 0), confirmed);
  assert.equal(f.backend.changes("commander", "import"), 1);
  await restarted.worker(
    "synthetic-room",
    0,
    { op: "ack", version: 2, reply: "Synthetic completed acknowledgement" },
    13,
  );
  assert.equal(
    commander.read("synthetic-room", 0).directives.appliedVersion,
    2,
  );
  assert.equal(readFileSync(file, "utf8"), "invalid stale JSON");
});

test("migration validates the entire legacy chat document before any SQL or memory publication", async (t) => {
  const f = fixture(t),
    file = f.file("chat"),
    chat = new ChatStore(file),
    original = message("original");
  await chat.seed([original]);
  const valid = message("new");
  const invalid = [
    "{",
    "null",
    JSON.stringify({ format: "unknown", messages: [], reads: [] }),
    transcript([{ ...valid, to: [2, 1] }]),
    transcript([valid, valid]),
    JSON.stringify({
      format: "chat-store/2",
      messages: [valid],
      reads: [],
      extra: true,
    }),
    transcript([valid], [{ player: 1, conversation: "0,1", through: 2 }]),
    transcript([valid], [{ player: 2, conversation: "0,1", through: 0 }]),
    transcript(
      [valid],
      [
        { player: 1, conversation: "0,1", through: 0 },
        { player: 1, conversation: "0,1", through: 0 },
      ],
    ),
    transcript([{ ...valid, text: "" }]),
  ];
  for (const source of invalid) {
    writeFileSync(file, source);
    await assert.rejects(chat.bindDurable(f.backend.document("chat")));
    assert.equal(f.backend.document("chat").read(), null);
    assert.deepEqual(chat.listForSeat(0), [original]);
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("migration validates the entire legacy commander document without partially importing earlier threads", async (t) => {
  const f = fixture(t),
    file = f.file("commander"),
    commander = new CommanderStore(file);
  await commander.send(
    "synthetic-room",
    0,
    { id: "original", text: "Original memory", references: [] },
    obs(),
  );
  const original = commander.read("synthetic-room", 0),
    valid = thread();
  const invalid = [
    "{",
    "null",
    JSON.stringify({ format: "unknown", threads: [] }),
    journal({
      ...valid,
      directives: { ...valid.directives, appliedVersion: 2 },
    }),
    journal({ ...valid, messages: [...valid.messages, ...valid.messages] }),
    journal({ ...valid, player: 10 }),
    ...["role", "status"].map((field) =>
      JSON.stringify({
        format: "commander-store/1",
        threads: [
          {
            ...valid,
            messages: [
              {
                ...valid.messages[0],
                [field]: field === "role" ? ["assistant"] : ["completed"],
              },
            ],
          },
        ],
      }),
    ),
    JSON.stringify({
      format: "commander-store/1",
      threads: [
        {
          ...valid,
          messages: [
            {
              ...valid.messages[0],
              references: [{ kind: ["fleet"], id: "x" }],
            },
          ],
        },
      ],
    }),
    JSON.stringify({
      format: "commander-store/1",
      threads: [
        {
          ...valid,
          messages: [
            {
              ...valid.messages[0],
              proposal: {
                ...valid.messages[0]!.proposal,
                status: ["confirmed"],
              },
            },
          ],
        },
      ],
    }),
    JSON.stringify({
      format: "commander-store/1",
      threads: [
        valid,
        {
          ...valid,
          roomId: "second-room",
          directives: { version: -1, text: "", appliedVersion: 0 },
        },
      ],
    }),
    JSON.stringify({ format: "commander-store/1", threads: [valid, valid] }),
    JSON.stringify({
      format: "commander-store/1",
      threads: [
        {
          ...valid,
          messages: [
            {
              ...valid.messages[0],
              references: [{ kind: "unknown", id: "x" }],
            },
          ],
        },
      ],
    }),
    JSON.stringify({
      format: "commander-store/1",
      threads: [
        {
          ...valid,
          messages: [
            {
              ...valid.messages[0],
              proposal: { ...valid.messages[0]!.proposal, status: "invalid" },
            },
          ],
        },
      ],
    }),
  ];
  for (const source of invalid) {
    writeFileSync(file, source);
    await assert.rejects(
      commander.bindDurable(f.backend.document("commander")),
    );
    assert.equal(f.backend.document("commander").read(), null);
    assert.deepEqual(commander.read("synthetic-room", 0), original);
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("failed import rolls back SQL and leaves previous memory intact; a later permitted retry can import", async (t) => {
  const f = fixture(t),
    chatFile = f.file("chat"),
    commanderFile = f.file("commander");
  const chat = new ChatStore(chatFile),
    commander = new CommanderStore(commanderFile);
  await chat.seed([message("memory")]);
  await commander.send(
    "synthetic-room",
    0,
    { id: "memory", text: "Memory", references: [] },
    obs(),
  );
  const previous = commander.read("synthetic-room", 0),
    chatSource = transcript([message("disk")]),
    commanderSource = journal();
  writeFileSync(chatFile, chatSource);
  writeFileSync(commanderFile, commanderSource);
  f.backend.failWrites();
  await assert.rejects(
    chat.bindDurable(f.backend.document("chat")),
    /fixture transaction failure/,
  );
  await assert.rejects(
    commander.bindDurable(f.backend.document("commander")),
    /fixture transaction failure/,
  );
  assert.equal(f.backend.document("chat").read(), null);
  assert.equal(f.backend.document("commander").read(), null);
  assert.deepEqual(chat.listForSeat(0), [message("memory")]);
  assert.deepEqual(commander.read("synthetic-room", 0), previous);
  assert.equal(f.backend.changes("chat", "import"), 0);
  assert.equal(f.backend.changes("commander", "import"), 0);
  f.backend.allowWrites();
  await chat.bindDurable(f.backend.document("chat"));
  await commander.bindDurable(f.backend.document("commander"));
  assert.deepEqual(chat.listForSeat(0), [message("disk")]);
  assert.deepEqual(commander.read("synthetic-room", 0), thread());
  assert.equal(readFileSync(chatFile, "utf8"), chatSource);
  assert.equal(readFileSync(commanderFile, "utf8"), commanderSource);
});

test("failed SQL mutations roll back message/read marks and commander state without cached ghost results", async (t) => {
  const f = fixture(t),
    chat = new ChatStore(f.file("absent-chat")),
    commander = new CommanderStore();
  await chat.bindDurable(f.backend.document("chat"));
  await commander.bindDurable(f.backend.document("commander"));
  chat.sendFromSeatSync(0, { id: "existing", to: 1, text: "Existing" }, 3, 10);
  commander.sendSync(
    "synthetic-room",
    0,
    { id: "existing", text: "Existing", references: [] },
    obs(),
  );
  const beforeChat = f.backend.document("chat").read(),
    beforeCommander = f.backend.document("commander").read();
  f.backend.failWrites();
  assert.throws(
    () =>
      chat.sendFromSeatSync(0, { id: "failed", to: 1, text: "Failed" }, 3, 10),
    /fixture transaction failure/,
  );
  await assert.rejects(
    chat.markSeenFromSeat(1, "0,1", 1),
    /fixture transaction failure/,
  );
  assert.throws(
    () =>
      commander.workerSync(
        "synthetic-room",
        0,
        { op: "reply", messageId: "existing", reply: "Failed reply" },
        10,
      ),
    /fixture transaction failure/,
  );
  assert.equal(f.backend.document("chat").read(), beforeChat);
  assert.equal(f.backend.document("commander").read(), beforeCommander);
  assert.equal(chat.cursorForSeat(1), 1);
  assert.equal(
    chat.conversationsForSeat(1).find((c) => c.id === "0,1")!.unread,
    1,
  );
  assert.equal(
    commander.read("synthetic-room", 0).messages[0]!.status,
    "queued",
  );
  f.backend.allowWrites();
  await chat.sendFromSeat(0, { id: "failed", to: 1, text: "Failed" }, 3, 10);
  await commander.worker(
    "synthetic-room",
    0,
    { op: "reply", messageId: "existing", reply: "Failed reply" },
    10,
  );
  assert.equal(chat.cursorForSeat(1), 2);
  assert.equal(commander.read("synthetic-room", 0).messages.length, 2);
});

test("nested synchronous domain writes/read-your-writes share the outer rollback boundary", async (t) => {
  const f = fixture(t),
    chat = new ChatStore(f.file("chat")),
    commander = new CommanderStore();
  await chat.bindDurable(f.backend.document("chat"));
  await commander.bindDurable(f.backend.document("commander"));
  const chatSource = f.backend.document("chat").read(),
    commanderSource = f.backend.document("commander").read();
  assert.throws(
    () =>
      sqliteTransaction(f.backend.db, () => {
        chat.sendFromSeatSync(
          0,
          { id: "outer", to: 1, text: "Uncommitted" },
          3,
          10,
        );
        chat.markSeenFromSeatSync(1, "0,1", 1);
        commander.sendSync(
          "synthetic-room",
          0,
          { id: "outer", text: "Uncommitted", references: [] },
          obs(),
        );
        assert.equal(chat.cursorForSeat(0), 1);
        assert.equal(
          chat.conversationsForSeat(1).find((c) => c.id === "0,1")!.unread,
          0,
        );
        assert.equal(commander.read("synthetic-room", 0).messages.length, 1);
        throw Error("outer rollback");
      }),
    /outer rollback/,
  );
  assert.equal(f.backend.document("chat").read(), chatSource);
  assert.equal(f.backend.document("commander").read(), commanderSource);
  assert.equal(chat.cursorForSeat(0), 0);
  assert.equal(commander.read("synthetic-room", 0).messages.length, 0);
  assert.equal(f.backend.changes("chat", "change"), 0);
  assert.equal(f.backend.changes("commander", "change"), 0);
  sqliteTransaction(f.backend.db, () => {
    chat.sendFromSeatSync(0, { id: "outer", to: 1, text: "Committed" }, 3, 10);
    commander.sendSync(
      "synthetic-room",
      0,
      { id: "outer", text: "Committed", references: [] },
      obs(),
    );
  });
  assert.equal(chat.cursorForSeat(0), 1);
  assert.equal(commander.read("synthetic-room", 0).messages.length, 1);
});

test("separate instances and database connections always observe the latest authoritative SQL", async (t) => {
  const f = fixture(t),
    otherBackend = f.connect();
  const chat = new ChatStore(f.file("chat")),
    otherChat = new ChatStore(f.dir),
    commander = new CommanderStore(),
    otherCommander = new CommanderStore(f.dir);
  await chat.bindDurable(f.backend.document("chat"));
  await otherChat.bindDurable(otherBackend.document("chat"));
  await commander.bindDurable(f.backend.document("commander"));
  await otherCommander.bindDurable(otherBackend.document("commander"));
  otherChat.sendFromSeatSync(0, { id: "first", to: 1, text: "First" }, 3, 10);
  chat.sendFromSeatSync(1, { id: "second", to: 0, text: "Second" }, 3, 11);
  assert.equal(otherChat.cursorForSeat(0), 2);
  chat.markSeenFromSeatSync(0, "0,1", 2);
  assert.equal(
    otherChat.conversationsForSeat(0).find((c) => c.id === "0,1")!.unread,
    0,
  );
  otherCommander.sendSync(
    "synthetic-room",
    0,
    { id: "first", text: "First", references: [] },
    obs(),
  );
  const reply = commander.workerSync(
    "synthetic-room",
    0,
    {
      op: "reply",
      messageId: "first",
      reply: "Proposal",
      proposal: { baseVersion: 0, text: "New directive", summary: "New" },
    },
    10,
  );
  otherCommander.confirmSync(
    "synthetic-room",
    0,
    { proposalId: reply.messages.at(-1)!.proposal!.id, version: 0 },
    10,
  );
  assert.equal(commander.version("synthetic-room", 0), 1);
  commander.workerSync(
    "synthetic-room",
    0,
    { op: "ack", version: 1, reply: "Applied" },
    10,
  );
  assert.equal(
    otherCommander.read("synthetic-room", 0).directives.appliedVersion,
    1,
  );
  const copy = chat.listForSeat(0);
  copy[0]!.text = "Mutated output";
  assert.equal(otherChat.listForSeat(0)[0]!.text, "First");
  const privateCopy = commander.read("synthetic-room", 0);
  privateCopy.directives.version = 999;
  assert.equal(otherCommander.version("synthetic-room", 0), 1);
});

test("concurrent first binding imports exactly one winner rather than overwriting it with a late file read", async (t) => {
  const f = fixture(t),
    firstFile = f.file("first"),
    secondFile = f.file("second");
  writeFileSync(firstFile, transcript([message("first")]));
  writeFileSync(secondFile, transcript([message("second")]));
  const first = new ChatStore(firstFile),
    second = new ChatStore(secondFile);
  await Promise.all([
    first.bindDurable(f.backend.document("chat")),
    second.bindDurable(f.backend.document("chat")),
  ]);
  assert.deepEqual(first.listForSeat(0), second.listForSeat(0));
  assert.equal(first.cursorForSeat(0), 1);
  assert.equal(f.backend.changes("chat", "import"), 1);
  const winner =
    first.listForSeat(0)[0]!.id === "first" ? firstFile : secondFile;
  assert.equal(
    f.backend.db
      .prepare("SELECT digest FROM documents WHERE name='chat'")
      .get()!.digest,
    createHash("sha256").update(readFileSync(winner)).digest("hex"),
  );
});

test("SQL corruption or missing documents fail closed rather than restoring leftover JSON", async (t) => {
  const f = fixture(t),
    file = f.file("chat"),
    commanderFile = f.file("commander");
  writeFileSync(file, transcript([message("legacy")]));
  writeFileSync(commanderFile, journal());
  const chat = new ChatStore(file),
    commander = new CommanderStore(commanderFile);
  await chat.bindDurable(f.backend.document("chat"));
  await commander.bindDurable(f.backend.document("commander"));
  f.backend.db.exec("UPDATE documents SET payload='{}'");
  assert.throws(() => chat.listForSeat(0));
  assert.throws(() => commander.read("synthetic-room", 0));
  await assert.rejects(chat.load());
  await assert.rejects(commander.load());
  await assert.rejects(
    new ChatStore(file).bindDurable(f.backend.document("chat")),
  );
  f.backend.db.exec("DELETE FROM documents");
  assert.throws(() => chat.cursorForSeat(0), /missing/);
  assert.throws(() => commander.version("synthetic-room", 0), /missing/);
  assert.equal(readFileSync(file, "utf8"), transcript([message("legacy")]));
});

test("default file/memory stores reject synchronous mutation, while durable async and sync validation agree", async (t) => {
  const f = fixture(t),
    chat = new ChatStore(f.file("chat")),
    commander = new CommanderStore();
  assert.throws(
    () => chat.sendFromSeatSync(0, { id: "x", to: null, text: "Text" }, 3, 10),
    /requires a durable/,
  );
  assert.throws(
    () =>
      commander.sendSync(
        "synthetic-room",
        0,
        { id: "x", text: "Text", references: [] },
        obs(),
      ),
    /requires a durable/,
  );
  await chat.bindDurable(f.backend.document("chat"));
  await commander.bindDurable(f.backend.document("commander"));
  assert.throws(
    () => chat.sendFromSeatSync(0, { id: "x", to: 0, text: "Text" }, 3, 10),
    /其他席位/,
  );
  await assert.rejects(
    chat.sendFromSeat(0, { id: "x", to: 0, text: "Text" }, 3, 10),
    /其他席位/,
  );
  assert.throws(() => chat.markSeenFromSeatSync(0, "public", 1), /read mark/);
  await assert.rejects(chat.markSeenFromSeat(0, "public", 1), /read mark/);
  const invalidRef = {
    id: "x",
    text: "Text",
    references: [{ kind: "fleet", id: "hidden" }],
  };
  assert.throws(
    () => commander.sendSync("synthetic-room", 0, invalidRef, obs()),
    /不可见/,
  );
  await assert.rejects(
    commander.send("synthetic-room", 0, invalidRef, obs()),
    /不可见/,
  );
  assert.throws(
    () =>
      commander.confirmSync(
        "synthetic-room",
        0,
        { proposalId: "missing", version: 0 },
        10,
      ),
    /不存在/,
  );
  await assert.rejects(
    commander.confirm(
      "synthetic-room",
      0,
      { proposalId: "missing", version: 0 },
      10,
    ),
    /不存在/,
  );
  assert.equal(f.backend.changes("chat", "change"), 0);
  assert.equal(f.backend.changes("commander", "change"), 0);
  assert.equal(
    f.backend.db
      .prepare("SELECT digest FROM documents WHERE name='chat'")
      .get()!.digest,
    null,
  );
  assert.equal(
    f.backend.db
      .prepare("SELECT digest FROM documents WHERE name='commander'")
      .get()!.digest,
    null,
  );
});

test("repository domain mutations and player-visible events roll back together when event publication fails", async (t) => {
  const h = protocolHarness(t),
    db = new DatabaseSync(h.path);
  try {
    const chatFile = join(h.dir, "chat.json"),
      commanderFile = join(h.dir, "commander.json");
    writeFileSync(chatFile, transcript([message("imported")]));
    writeFileSync(commanderFile, journal());
    const chat = new ChatStore(chatFile),
      commander = new CommanderStore(commanderFile);
    const chatDoc = h.repository.domainDocument(
      h.authority.roomEpoch,
      "chat",
      "main",
      (_previous, next) => {
        // onChange re-enters the public reader before the outer commit.
        assert.deepEqual(chat.listForSeat(0), JSON.parse(next).messages);
        h.repository.domainEvent("fixture-room", 0, "chat.added", {}, true);
      },
    );
    const commanderDoc = h.repository.domainDocument(
      h.authority.roomEpoch,
      "commander",
      "main",
      (_previous, next) => {
        assert.deepEqual(
          commander.read("synthetic-room", 0),
          JSON.parse(next).threads[0],
        );
        h.repository.domainEvent(
          "fixture-room",
          0,
          "instructions.confirmed",
          {},
          true,
        );
      },
    );
    await chat.bindDurable(chatDoc);
    await commander.bindDurable(commanderDoc);
    const beforeChat = chatDoc.read(),
      beforeCommander = commanderDoc.read(),
      beforeEvents = h.repository.inspect().events;
    db.exec(
      "CREATE TRIGGER domain_event_failure BEFORE INSERT ON protocol_events BEGIN SELECT RAISE(ABORT,'fixture domain event failure'); END",
    );
    assert.throws(
      () =>
        chat.sendFromSeatSync(
          0,
          { id: "event-fail", to: 1, text: "Synthetic" },
          2,
          10,
        ),
      /fixture domain event failure/,
    );
    assert.throws(
      () =>
        commander.workerSync(
          "synthetic-room",
          0,
          { op: "ack", version: 1, reply: "Synthetic acknowledgement" },
          10,
        ),
      /fixture domain event failure/,
    );
    assert.equal(chatDoc.read(), beforeChat);
    assert.equal(commanderDoc.read(), beforeCommander);
    assert.deepEqual(h.repository.inspect().events, beforeEvents);
    assert.equal(chat.cursorForSeat(0), 1);
    assert.equal(
      commander.read("synthetic-room", 0).directives.appliedVersion,
      0,
    );
    db.exec("DROP TRIGGER domain_event_failure");
    await chat.sendFromSeat(
      0,
      { id: "event-fail", to: 1, text: "Synthetic" },
      2,
      10,
    );
    await commander.worker(
      "synthetic-room",
      0,
      { op: "ack", version: 1, reply: "Synthetic acknowledgement" },
      10,
    );
    assert.equal(h.repository.inspect().events.length, beforeEvents.length + 2);
    assert.equal(
      readFileSync(chatFile, "utf8"),
      transcript([message("imported")]),
    );
    assert.equal(readFileSync(commanderFile, "utf8"), journal());
  } finally {
    db.close();
  }
});

test("real repository shares one atomic world, command receipt, chat, commander and event boundary", async (t) => {
  const h = protocolHarness(t),
    db = new DatabaseSync(h.path);
  try {
    const chat = new ChatStore(join(h.dir, "absent-chat.json")),
      commander = new CommanderStore();
    const chatDoc = h.repository.domainDocument(
      h.authority.roomEpoch,
      "chat",
      "main",
      () => h.repository.domainEvent("fixture-room", 0, "chat.added", {}, true),
    );
    const commanderDoc = h.repository.domainDocument(
      h.authority.roomEpoch,
      "commander",
      "main",
      () =>
        h.repository.domainEvent(
          "fixture-room",
          0,
          "commander.message.added",
          {},
          true,
        ),
    );
    await chat.bindDurable(chatDoc);
    await commander.bindDurable(commanderDoc);
    const request = h.command("domain-and-world"),
      accepted = h.repository.acceptCommand(h.first.principal, request);
    const beforeWorld = h.store.load(),
      beforeChat = chatDoc.read(),
      beforeCommander = commanderDoc.read(),
      beforeEvents = h.repository.inspect().events;
    const apply = (command: typeof request) => {
      chat.sendFromSeatSync(
        0,
        {
          id: "transaction-message",
          to: 1,
          text: "Synthetic transaction message",
        },
        2,
        10,
      );
      commander.workerSync(
        "fixture-room",
        0,
        {
          op: "notice",
          id: "transaction",
          reply: "Synthetic transaction notice",
        },
        10,
      );
      assert.equal(chat.cursorForSeat(0), 1);
      assert.equal(commander.read("fixture-room", 0).messages.length, 1);
      return h.apply(command);
    };
    db.exec(
      "CREATE TRIGGER domain_receipt_failure BEFORE UPDATE ON protocol_operations BEGIN SELECT RAISE(ABORT,'fixture domain receipt failure'); END",
    );
    assert.throws(
      () =>
        h.repository.settleCommand(
          h.first.principal,
          accepted.commandId,
          apply,
        ),
      /fixture domain receipt failure/,
    );
    assert.deepEqual(h.store.load(), beforeWorld);
    assert.equal(chatDoc.read(), beforeChat);
    assert.equal(commanderDoc.read(), beforeCommander);
    assert.deepEqual(h.repository.inspect().events, beforeEvents);
    assert.equal(
      h.repository.receipt(h.first.principal, accepted.commandId).state,
      "accepted",
    );
    assert.equal(chat.cursorForSeat(0), 0);
    assert.equal(commander.read("fixture-room", 0).messages.length, 0);
    db.exec("DROP TRIGGER domain_receipt_failure");
    const applied = h.repository.settleCommand(
      h.first.principal,
      accepted.commandId,
      apply,
    );
    assert.equal(applied.state, "applied");
    assert.equal(applied.effectCommitted, true);
    assert.equal(h.store.load()!.room.state.commands.length, 1);
    assert.equal(chat.cursorForSeat(0), 1);
    assert.equal(commander.read("fixture-room", 0).messages.length, 1);
    assert.deepEqual(
      h.repository.settleCommand(h.first.principal, accepted.commandId, apply),
      applied,
    );
    assert.equal(chat.cursorForSeat(0), 1);
    assert.equal(commander.read("fixture-room", 0).messages.length, 1);
  } finally {
    db.close();
  }
});
