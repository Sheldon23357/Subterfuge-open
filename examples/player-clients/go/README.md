# Go independent player client

Go 1.22+ on Linux/macOS. Standard library only. `go.mod` has no required modules and there is no `go.sum`. Copy this directory into a clean directory; no repository, npm, TypeScript runtime, official SDK, model, or private game database is required.

```sh
go build -o player-client ./cmd/player-client
./player-client --origin https://YOUR-GAME-SERVER \
  --identity identity.json --state private-state.json
```

Default behavior is paused/read-only: verify identity/capabilities, reconcile the local durable outbox, resume the persisted exclusive cursor, install a verified snapshot when needed, print status and exit. It is not an autonomous planner or a background daemon.

The credential is read from an already provided `PLAYER_EXECUTOR_TOKEN` environment variable, never from the command line, URL or local state. This implementation does not provision credentials. Non-loopback HTTP, redirects and ambient proxies are disabled. Expected identity and seat mapping must be pinned independently of the untrusted response.

Only `--allow-write --command operation.json` requests a single explicit operation. A command file has exactly `kind` and `payload`, following the public v2 schema. `--allow-write` alone does nothing writable. `--resume-only` never creates an intent. Acquiring control is explicit; the client never takes over another executor. Unknown/accepted operations block new intents, and a restarted process never resumes an old lease deadline.

Library entry points: `NewHTTP`, `OpenStore`, `NewClient`, `Hello`, `Snapshot`, `Events`, `Control`, `Prepare`, `Submit`, `Reconcile`, `Pause`. The API is single-owner and serial, not safe for concurrent calls. State persistence is private-mode temporary file → fsync → atomic rename → parent directory fsync, with an exclusive flock against simultaneous writers. Use a local filesystem with these semantics, not a network share. The implementation is explicitly Unix-only rather than claiming Windows locking guarantees it does not implement.

JCS serialization sorts UTF-16 code units, not Go's UTF-8 byte ordering. Parsing rejects duplicate decoded keys, invalid UTF-8, lone escaped surrogates, nonfinite binary64 and excessive depth. Protocol counters stay decimal strings and use `math/big`, never `float64`.

```sh
go test -count=1 -v ./...
go vet ./...
```

Normative fixtures and extra number vectors are accessed by unit tests relative to the repository only. Production library/binary does not load fixtures. See the [developer guide](../../../docs/open-client/getting-started.md), [compatibility](../../../docs/open-client/compatibility.md) and [protocol](../../../protocol/player/v2/README.md).
