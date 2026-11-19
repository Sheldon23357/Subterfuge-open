import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, renameSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "./room-store.js";
import { ChatStore } from "./chat.js";
import { CommanderStore } from "./commander-store.js";
import { recoverGameCheckpointCoordinator } from "./game-checkpoint-coordinator.js";

export interface CheckpointCoordinationManifest {
  checkpointId: string;
  mode: "game-only" | "coordinated";
  roomId: string;
  roomEpoch: string;
  tick: number;
  revision: number;
  frozenAtMs: number;
  unsettledCommands: number;
  participants: {
    playerId: string;
    supported: boolean;
    prepared: boolean;
    frozen?: { receiptId: string; sha256: string };
    missing?: "unsupported" | "prepare_timeout" | "freeze_timeout";
  }[];
}
export interface GameOnlyCheckpointManifest
  extends CheckpointCoordinationManifest {
  format: "game-only-checkpoint/1";
  intentSha256: string;
  files: [{ path: "authority.sqlite"; bytes: number; sha256: string }];
}
export interface GameOnlyRestoreMarker {
  format: "game-only-restored/1";
  checkpointId: string;
  roomId: string;
  sourceRoomEpoch: string;
  roomEpoch: string;
  restoredAtMs: number;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/;
const checkpointIdentifier = identifier;
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const integer = (n: unknown, min = 0): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    throw Error("Invalid game-only checkpoint fields");
}
function coordination(value: unknown): CheckpointCoordinationManifest {
  if (!object(value)) throw Error("Invalid game-only checkpoint metadata");
  fields(value, [
    "checkpointId",
    "mode",
    "roomId",
    "roomEpoch",
    "tick",
    "revision",
    "frozenAtMs",
    "unsettledCommands",
    "participants",
  ]);
  if (
    typeof value.checkpointId !== "string" ||
    !checkpointIdentifier.test(value.checkpointId) ||
    !["game-only", "coordinated"].includes(String(value.mode)) ||
    typeof value.roomId !== "string" ||
    !value.roomId.length ||
    value.roomId.length > 200 ||
    typeof value.roomEpoch !== "string" ||
    !identifier.test(value.roomEpoch) ||
    !integer(value.tick) ||
    !integer(value.revision, 1) ||
    !integer(value.frozenAtMs) ||
    !integer(value.unsettledCommands) ||
    !Array.isArray(value.participants) ||
    value.participants.length > 10
  )
    throw Error("Invalid game-only checkpoint metadata");
  const seen = new Set<string>();
  for (const p of value.participants) {
    if (!object(p)) throw Error("Invalid checkpoint participant");
    fields(p, ["playerId", "supported", "prepared"], ["frozen", "missing"]);
    if (
      typeof p.playerId !== "string" ||
      !identifier.test(p.playerId) ||
      seen.has(p.playerId) ||
      typeof p.supported !== "boolean" ||
      typeof p.prepared !== "boolean" ||
      (!p.supported && p.prepared) ||
      (p.missing !== undefined &&
        !["unsupported", "prepare_timeout", "freeze_timeout"].includes(
          String(p.missing),
        ))
    )
      throw Error("Invalid checkpoint participant");
    seen.add(p.playerId);
    if (p.frozen !== undefined) {
      if (!object(p.frozen)) throw Error("Invalid opaque participant receipt");
      fields(p.frozen, ["receiptId", "sha256"]);
      if (
        !p.supported ||
        !p.prepared ||
        p.missing !== undefined ||
        typeof p.frozen.receiptId !== "string" ||
        !identifier.test(p.frozen.receiptId) ||
        typeof p.frozen.sha256 !== "string" ||
        p.frozen.sha256.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(p.frozen.sha256)
      )
        throw Error("Invalid opaque participant receipt");
    }
    if (
      (p.missing === "unsupported" && p.supported) ||
      (!p.supported && p.missing !== "unsupported")
    )
      throw Error("Invalid participant missing status");
  }
  return structuredClone(value) as unknown as CheckpointCoordinationManifest;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function manifest(value: unknown): GameOnlyCheckpointManifest {
  if (!object(value)) throw Error("Invalid game-only checkpoint manifest");
  fields(value, [
    "format",
    "intentSha256",
    "files",
    "checkpointId",
    "mode",
    "roomId",
    "roomEpoch",
    "tick",
    "revision",
    "frozenAtMs",
    "unsettledCommands",
    "participants",
  ]);
  const { format, intentSha256, files, ...metadata } = value,
    checked = coordination(metadata);
  if (
    format !== "game-only-checkpoint/1" ||
    intentSha256 !== digest(canonical(checked)) ||
    !Array.isArray(files) ||
    files.length !== 1 ||
    !object(files[0])
  )
    throw Error("Invalid game-only checkpoint manifest");
  fields(files[0], ["path", "bytes", "sha256"]);
  if (
    files[0].path !== "authority.sqlite" ||
    !integer(files[0].bytes, 1) ||
    typeof files[0].sha256 !== "string" ||
    files[0].sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(files[0].sha256)
  )
    throw Error("Invalid checkpoint authority file");
  return value as unknown as GameOnlyCheckpointManifest;
}
async function regularFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Checkpoint files must be regular files");
  return stat;
}
async function fileDigest(path: string) {
  await regularFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const n = await handle.read(buffer, 0, buffer.length, null);
      if (!n.bytesRead) break;
      bytes += n.bytesRead;
      hash.update(buffer.subarray(0, n.bytesRead));
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
function checkedHead(path: string) {
  const store = new RoomStore(path, { readOnly: true });
  try {
    store.verify();
    const head = store.load();
    if (!head) throw Error("Checkpoint has no active room");
    const roomId = head.room.playerRoomId ?? store.predictionSource().roomId,
      db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT room_epoch FROM protocol_epochs WHERE room_id=? AND active=1",
        )
        .get(roomId);
      if (!row) throw Error("Checkpoint has no active protocol authority");
      return {
        roomId,
        roomEpoch: String(row.room_epoch),
        tick: head.room.state.economy.tick,
        revision: head.revision,
        unsettledCommands: Number(
          db
            .prepare(
              "SELECT count(*) AS count FROM protocol_operations WHERE room_epoch=? AND state='accepted'",
            )
            .get(String(row.room_epoch))!.count,
        ),
      };
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
}
async function safeDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Checkpoint directory must be a real directory");
}
export async function verifyGameOnlyCheckpoint(
  directory: string,
): Promise<GameOnlyCheckpointManifest> {
  const source = resolve(directory);
  await safeDirectory(source);
  const names = (await readdir(source)).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["authority.sqlite", "manifest.json"])
  )
    throw Error("Checkpoint contains missing or unexpected files");
  const info = await regularFile(join(source, "manifest.json"));
  if (info.size > 64 * 1024) throw Error("Checkpoint manifest is too large");
  const m = manifest(
      JSON.parse(await readFile(join(source, "manifest.json"), "utf8")),
    ),
    file = await fileDigest(join(source, "authority.sqlite"));
  if (file.bytes !== m.files[0].bytes || file.sha256 !== m.files[0].sha256)
    throw Error("Checkpoint authority checksum mismatch");
  const head = checkedHead(join(source, "authority.sqlite"));
  if (
    head.roomId !== m.roomId ||
    head.roomEpoch !== m.roomEpoch ||
    head.tick !== m.tick ||
    head.revision !== m.revision ||
    head.unsettledCommands !== m.unsettledCommands
  )
    throw Error("Checkpoint authority does not match manifest");
  const store = new RoomStore(join(source, "authority.sqlite"), {
    readOnly: true,
  });
  try {
    for (const [domain, reader] of [
      ["chat", new ChatStore()],
      ["commander", new CommanderStore()],
    ] as const) {
      const payload = store.readProtocolDocument(m.roomId, domain, "journal");
      if (payload === undefined || payload === null)
        throw Error(
          "Authoritative " +
            domain +
            " domain must be migrated before checkpoint export",
        );
      await reader.bindDurable({
        read: () => payload,
        initialize: () => {
          throw Error("Read-only checkpoint");
        },
        transact: () => {
          throw Error("Read-only checkpoint");
        },
      });
    }
  } finally {
    store.close();
  }
  return m;
}
function abort(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
/** Export one authoritative SQLite image only. Plaintext owner credentials and AI files never enter this format. */
export async function exportGameOnlyCheckpoint(
  store: RoomStore,
  directory: string,
  metadata: CheckpointCoordinationManifest,
  options: { signal?: AbortSignal; beforePublish?: () => void } = {},
): Promise<GameOnlyCheckpointManifest> {
  const checked = coordination(metadata),
    intentSha256 = digest(canonical(checked)),
    base = resolve(directory),
    target = join(base, checked.checkpointId);
  abort(options.signal);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await safeDirectory(base);
  if (existsSync(target)) {
    const existing = await verifyGameOnlyCheckpoint(target);
    if (existing.intentSha256 !== intentSha256)
      throw Error("Checkpoint identifier already has a different intent");
    return existing;
  }
  const lock = join(base, "." + checked.checkpointId + ".publishing"),
    reservation = await open(lock, "wx", 0o600),
    stage = join(
      base,
      "." + checked.checkpointId + "." + randomUUID() + ".tmp",
    );
  try {
    abort(options.signal);
    if (existsSync(target)) {
      const existing = await verifyGameOnlyCheckpoint(target);
      if (existing.intentSha256 !== intentSha256)
        throw Error("Checkpoint identifier already has a different intent");
      return existing;
    }
    await mkdir(stage, { mode: 0o700 });
    await store.backup(join(stage, "authority.sqlite"));
    abort(options.signal);
    const head = checkedHead(join(stage, "authority.sqlite"));
    if (
      head.roomId !== checked.roomId ||
      head.roomEpoch !== checked.roomEpoch ||
      head.tick !== checked.tick ||
      head.revision !== checked.revision ||
      head.unsettledCommands !== checked.unsettledCommands
    )
      throw Error("Checkpoint source changed before the authoritative backup");
    const m: GameOnlyCheckpointManifest = {
      format: "game-only-checkpoint/1",
      ...checked,
      intentSha256,
      files: [
        {
          path: "authority.sqlite",
          ...(await fileDigest(join(stage, "authority.sqlite"))),
        },
      ],
    };
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify(m, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await verifyGameOnlyCheckpoint(stage);
    // No await between the authority/deadline guard, cancellation check and the
    // final atomic rename. A timed-out or superseded publisher cannot publish late.
    options.beforePublish?.();
    abort(options.signal);
    if (existsSync(target))
      throw Error("Checkpoint destination already exists");
    renameSync(stage, target);
    return m;
  } finally {
    await reservation.close();
    await rm(lock, { force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
/** Offline clone, never in-place restore. The source is read-only and never deleted. */
export async function restoreGameOnlyCheckpoint(
  source: string,
  destination: string,
  options: { now?: () => number } = {},
) {
  const m = await verifyGameOnlyCheckpoint(source),
    sourceDirectory = await realpath(resolve(source)),
    requestedTarget = resolve(destination);
  await safeDirectory(dirname(requestedTarget));
  const target = join(
      await realpath(dirname(requestedTarget)),
      basename(requestedTarget),
    ),
    nested = relative(sourceDirectory, target);
  if (
    !nested ||
    (nested !== ".." && !nested.startsWith(".." + sep) && !isAbsolute(nested))
  )
    throw Error("Restore destination must not be inside the checkpoint");
  const now = (options.now ?? Date.now)();
  if (!integer(now) || now < m.frozenAtMs)
    throw Error("Invalid restore wall clock");
  const parent = dirname(target);
  await safeDirectory(parent);
  if (existsSync(target)) throw Error("Restore destination already exists");
  const lock = target + ".restoring",
    reservation = await open(lock, "wx", 0o600),
    stage = join(parent, ".game-only-restore-" + randomUUID());
  try {
    if (existsSync(target)) throw Error("Restore destination already exists");
    await mkdir(stage, { mode: 0o700 });
    const path = join(stage, "authority.sqlite");
    await copyFile(
      join(sourceDirectory, "authority.sqlite"),
      path,
      constants.COPYFILE_EXCL,
    );
    const copied = await fileDigest(path);
    if (
      copied.bytes !== m.files[0].bytes ||
      copied.sha256 !== m.files[0].sha256
    )
      throw Error("Checkpoint changed while cloning");
    const store = new RoomStore(path, { wallNow: () => now });
    let marker: GameOnlyRestoreMarker;
    try {
      const head = store.load()!;
      const authority = store.protocol!.startAuthority(
        m.roomId,
        head.room.state.economy.players.length,
        { fork: true },
      );
      if (authority.roomEpoch === m.roomEpoch)
        throw Error("Restore did not fork the room epoch");
      recoverGameCheckpointCoordinator(
        store.protocol!,
        m.roomId,
        () => now,
        "restored_clone",
      );
      store.protocol!.atomic(() => {
        if (head.room.clock)
          store.commit(
            {
              ...head.room,
              clock: {
                ...head.room.clock,
                anchorMs: head.room.clock.anchorMs + now - m.frozenAtMs,
              },
            },
            head.revision,
          );
        const activation = store.protocol!.domainDocument(
          authority.roomEpoch,
          "restore",
          "activation",
        );
        const payload = JSON.stringify({
          format: "game-only-activation/1",
          restoredAtMs: now,
          activated: false,
        });
        if (activation.read() === null) activation.initialize(payload, null);
        else activation.transact(() => ({ payload, result: undefined }));
      });
      store.verify();
      marker = {
        format: "game-only-restored/1",
        checkpointId: m.checkpointId,
        roomId: m.roomId,
        sourceRoomEpoch: m.roomEpoch,
        roomEpoch: authority.roomEpoch,
        restoredAtMs: now,
      };
    } finally {
      store.close();
    }
    await writeFile(
      join(stage, "game-only-restored.json"),
      JSON.stringify(marker, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    if (existsSync(target)) throw Error("Restore destination already exists");
    renameSync(stage, target);
    return {
      directory: target,
      database: join(target, "authority.sqlite"),
      marker: join(target, "game-only-restored.json"),
      checkpointId: m.checkpointId,
      roomId: m.roomId,
      roomEpoch: marker.roomEpoch,
      tick: m.tick,
    };
  } finally {
    await reservation.close();
    await rm(lock, { force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
