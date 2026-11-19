# Optional TypeScript / Node.js player SDK

The public `/player/v2` HTTP protocol is the interoperability contract. This package is optional: Python, Go, deterministic programs, and other clients do not need to install it, use the official model queue, maintain AI memories, or call an AI `finish` tool.

## Build and use independently

From the source repository:

```sh
node scripts/build-player-sdk.mjs --out /tmp/subterfuge-player-sdk
npm pack /tmp/subterfuge-player-sdk --pack-destination /tmp
```

Install the resulting `.tgz` into an independent Node.js project with `npm install /path/to/subterfuge-player-sdk-0.1.0.tgz`. Node.js 22.13 or newer is required. The bundle has no runtime package dependencies. Its declaration files include the public wire types; they do not point outside the package or require this repository. This build does not publish anything to a registry.

```js
import {PlayerProtocolClient, FileProtocolClientStore} from '@subterfuge/player-sdk';

const client = new PlayerProtocolClient({
  serverUrl: 'https://your-game-server.example',
  token: process.env.SUBTERFUGE_EXECUTOR_TOKEN,
  expectedIdentity: {roomId: 'your-room', gamePlayer: 0},
  store: new FileProtocolClientStore('./private/player-transport.json'),
  requiredCapabilities: ['core/2', 'actions.order/1'],
  optionalCapabilities: ['chat.read/1'],
});

await client.connect();             // No game control is acquired.
const snapshot = await client.snapshot();
// Model/API credentials belong only in your own program, never in protocol data.
// Start only after the player has explicitly enabled the executor:
await client.acquire();
```

Create a command with one stable `idempotencyKey`, one `clientCommandId`, the original observation `expectedRevision`, confirmed `instructionsVersion`, and a typed kind/payload. The SDK adds the current authenticated epoch/session/fence. A retry cannot replace these inputs. For example, an order payload is `{action: {kind: 'check-in'}}`. Preserve the same logical key across retries. New decisions must use new keys.

After negotiating `actions.scoped-revision/1`, immediate launch/return-fleet orders can include an `actionBasis`: SHA-256 of the UTF-8 string returned by the protocol reference `actionBasisMaterial(originalObservation, action)` in `packages/contracts/src/action-basis.ts`. A null result requires ordinary strict revision handling. Keep the original `expectedRevision`, action digest and logical key unchanged on retries; never calculate a new digest from a later observation for an existing request. The server checks scoped dependencies at admission and settlement. Other action kinds retain strict observation revisions.

## Live local state

Negotiate `state.sync/1` to use `await client.sync(1000)` in an independent synchronization loop. It installs the server's complete authorized cut locally in one response, without snapshot pages or completion acknowledgements; unchanged cuts return a null document. Read `client.state.snapshot` for a detached local copy. `sync(0, true)` explicitly refreshes even an unchanged cursor, for example when current fractional world time is required. Synchronization does not acquire control, settle unknown writes or acknowledge model/application facts. Continue to reconcile commands under their original identities. Late live or pinned snapshot responses never replace a newer installed cut. See the [protocol](../../protocol/player/v2/README.md#live-state-synchronization) for authorization, bounds and transport freshness.

## Durability and recovery

Each HTTP exchange has a hard deadline (`timeoutMs`, default 15 seconds) covering headers and the complete response body. The caller settles at that deadline even if transport cancellation stalls. Late responses cannot update protocol state. Incomplete reads are `TRANSPORT_UNCONFIRMED`; writes retain an unknown outcome and require reconciliation under their original identity.

After negotiating `actions.batch/1`, use `commandBatch()` with one stable parent identity and 1–8 order intents. The SDK supplies the shared authenticated epoch/session/fence, saves the immutable parent with its ordered child intents before I/O, verifies every returned child receipt, and installs the single final snapshot with the usual pagination/digest/cursor checks. The result contains the parent receipt (whose `effects.batchReceipts` bind the independent child receipts) and assembled snapshot document. A lost response is reconciled under the original parent key; children remain independently queryable under their original keys. Snapshot installation failure does not discard persisted command receipts. The exact wire shapes are defined in the [protocol schema](../../protocol/player/v2/schema.json).

- Clients start paused, including after reconstruction. `connect`, `snapshot`, and `reconcile` never resume gameplay. `release` stops local writes before network I/O. Delayed acquire/renew responses cannot undo a pause, release, expired local lease, or newer control generation.
- The SDK writes its immutable intent and attempt counter before transmission. Unknown outcomes stay pending. Call `reconcile()` to query the durable ledger; do not resubmit with a new key. Authoritative absence is not proof that an in-flight packet cannot still commit. Closing it requires a strictly retired server fence followed by a second authoritative lookup.
- `reconcile({retryAbsent:true})` permits only the exact saved intent while its original session/fence is still authoritative. It does not enable new gameplay writes. A rejected retry never erases an earlier unknown attempt. Missing ledger history or revoked read access remains unresolved.
- Receipt versions use decimal strings and BigInt, not floating-point counters. Older receipts do not replace newer ones; conflicting receipts at the same version fail closed.
- Snapshot pages must share a cut, scope and digest. Events validate exclusive cursor coverage and consecutive decimal sequence numbers. An event reducer updates `state.application` inside the same storage transaction as its cursor. Reducers must be synchronous and must not perform external effects.
- The required `ProtocolClientStore` interface makes storage an application choice. `MemoryProtocolClientStore` is ephemeral and suitable only for tests. `FileProtocolClientStore` uses private permissions, fsync and atomic rename. A process killed during its brief lock-held transaction may leave an abandoned lock; it fails closed until the operator verifies ownership and recovers that lock. Never delete a live process's lock.
- The official runner uses a private SQLite implementation instead, in the same seat database as its own state. Atomic outbox/cursor transactions, crash recovery, and checkpoint backup do not require SQLite in this public SDK.
- Stores may implement the optional `outboxEntry` and `outboxEntries` indexed readers. The SDK uses them to inspect one command or unresolved/scheduled commands without materializing settled history. Returned entries remain detached; the atomic transaction contract is unchanged.
- Stores may also provide `readSafetyStop` for permission checks without loading an observation snapshot. It must reflect committed safety-state changes, including writes by other connections; it does not replace the unresolved-command or lease checks.
- A deadline or disconnect while reading a response body remains a transport failure even after HTTP headers arrive. Read-only failures can recover through the runtime's reconnect policy; writes keep an unknown outcome until the original receipt is reconciled. Malformed JSON, invalid UTF-8 and oversized bodies still fail strict response validation.
- Identity, server or room-epoch mismatch stops writes and retains the old outbox. A new room branch requires a separately verified store binding; do not silently repurpose old intents.

## Capabilities and official runner

`workerCommand()` uses negotiated `commander.worker/1` and the same durable receipt ledger without claiming gameplay control. `extensionRequest()` is read-only; gameplay, chat, readiness and discussion mutations must go through durable command APIs. No owner/admin endpoint is available through this client.

The official runner supports only v2 and accepts no protocol selector. Configure tokenEnv with its scoped executor grant, or explicitly use ownerCredential for durable grant bootstrap. Model configuration and private state stay local.

## Optional coordinated checkpoints

Checkpoint participation is independent of gameplay and is off by default. Standalone clients explicitly request `checkpoints.coordinated/1`, use `checkpointCurrent()` to discover work, and retain the checkpoint ID for `checkpointHistory(id)` even after current becomes empty. `checkpointAck({checkpointId, phase, ...})` persists the exact session/phase intent before sending; a lost response is reconciled from authenticated history. Frozen acknowledgements contain only a random opaque `receiptId` and lowercase 64-character `sha256`. They cannot carry a file path, a private database or model credentials. A new executor session may inspect history but cannot stand in for the session selected by the coordinator.

The official runner additionally requires `coordinatedCheckpoints: true` on an explicit v2 seat. Its independent polling timer continues while game ticks are stopped. It blocks new model handoffs, drains active decisions/discussions, releases the original gameplay fence and reconciles each command. Unknown commands or unresolved provider dispatches cannot be acknowledged as prepared. In the frozen phase it uses a consistent SQLite backup under the already-configured private `storeDirectory/protocol-checkpoints/<random-receipt>/` and writes a local checksum manifest. No server-supplied path is used.

During resuming it acknowledges readiness but does not acquire control or call a model. Only authenticated terminal history (`completed` or `aborted`) removes the checkpoint barrier; a locally elapsed timeout or disconnection is not completion. A previously running, healthy seat reacquires control if needed and refreshes its observation baseline without triggering a model call. Previously paused seats, restarted runtimes, user-paused seats and unresolved outcomes stay paused. Each poll has the SDK network timeout; a ten-minute local safety deadline also prevents automatic resumption of an abnormally long attempt.

Backups are local recovery artifacts, not automatic replay instructions. Inspect their manifest and SQLite integrity offline. Restoring a game creates a new room epoch, so old commands and transport bindings must not silently migrate to it; use separately verified bindings and preserve old receipts for reconciliation.

## Optional manual-command coordination

Request `manual-commands/1` in `optionalCapabilities` to read server-authored manual actions. The ordinary observation snapshot includes `observation.manualCommands`: a monotonic numeric `version`, bounded recent `receipts`, active `protections`, `receiptsFromVersion`, and `hasEarlierReceipts`. These are actual accepted effects, not model-inferred tactics or confirmed prose directives. `client.manualCommands` returns a defensive copy only after a validated, current snapshot; `null` means unnegotiated, missing, or stale, never proof that no protected orders exist.

Manual actions change the existing observation revision and produce the existing `observation.changed` event. Event polling mark the snapshot stale, so reload it before interpreting the new state. The SDK validates receipt versions, seat identity and protection shapes before persisting a snapshot, and refuses a regressing manual version. Reconstruction preserves these facts with the cursor but still starts paused. A revision/manual-priority rejection invalidates the local projection without rewriting or resubmitting an outbox intent.

Older immutable facts can be read with `extensionRequest('manual-commands/1', '/manual-commands?after=0&limit=100')`, following `nextCursor` while `hasMore` is true, or with `/manual-commands?id=<encoded-receipt-id>`. Pages are authenticated, read-only, and checked against the connected seat. Do not treat a bounded recent snapshot as full history.

The executor SDK cannot submit an owner/manual command, assert a human role, or override a manual protection. It continues to use the original `expectedRevision` and server arbitration; it does not require a particular model, private notebook format, or official AI policy. Custom clients can implement this optional HTTP capability directly without installing the SDK.

Historical protection receipts are read-only data. No release operation or support flag is exposed. Existing runner lease/pause/resume primitives remain separate from manual-priority gameplay.

## Diplomacy

Negotiate `diplomacy/2` to use the formal proposal/response actions through the same durable order-command API and inspect authorized `observation.diplomacy`. The protocol schema owns action shapes. Durations are fixed at 100/200 ticks; chat is not a signature, and an accepted command still requires checking the server agreement result. Complete receipt history is available with `extensionRequest("diplomacy/2", "/diplomacy/receipts?after=0&limit=100")`; preserve the returned through cursor while paging. Unknown writes are reconciled under their original key.
