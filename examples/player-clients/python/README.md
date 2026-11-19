# Python independent player client

Python 3.11+ on Linux/macOS. Standard library only: urllib, hashlib, json, sqlite3, fcntl. No pip install, official SDK, game engine, model, or server private database. Copy `client.py` into any clean directory to use it.

The default is paused/read-only. The program handshakes, verifies a pinned identity and seat mapping, reconciles durable pending commands, resumes the saved event cursor, installs a complete verified snapshot when required, prints a compact result and exits. It does not run a strategy or automatically acquire control.

```sh
python3 client.py --origin https://YOUR-GAME-SERVER \
  --identity identity.json --state private-state.sqlite
```

`PLAYER_EXECUTOR_TOKEN` must already be supplied through your own protected environment. Do not put a credential in the origin, identity file, command file, command-line arguments, source code or logs. This example does not create or distribute grants. HTTP is accepted only for loopback fixtures; redirects and ambient HTTP proxies are disabled.

For an explicitly requested single operation, supply a file with `{ "kind": "order", "payload": { "action": ... } }`, or the public `schedule` / `cancel-schedule` payload, and add both `--allow-write --command operation.json`. `--allow-write` alone never issues a command. Do not use the test operation against a real game without deciding that action yourself. No takeover is attempted on `CONTROL_BUSY`.

`--resume-only` reconciles and observes without creating a new intent. Even with write permission, unknown/accepted operations block new intents. Transport failures stop the local lease; use lookup to establish what happened. An absent record is not renamed to failure and is never replaced automatically with a new key.

As a library, `Client` exposes `hello`, `snapshot`, `events`, `control`, `prepare`, `submit`, `reconcile`, and `pause`. `Store` makes SQLite FULL-synchronous transactions containing the local projection/cursor and outbox. `prepare` durably records the immutable scope, key, intent and digest before transport. Call methods serially from one process. Local state deliberately has no persisted lease deadline; reopening requires a fresh handshake and explicit control acquisition.

From the repository root:

```sh
python3 -m unittest discover -s examples/player-clients/python -v
```

For real HTTP interoperability, run the isolated [test runner](../interop/run.mjs). See the [developer guide](../../../docs/open-client/getting-started.md) and [capabilities](../../../docs/open-client/compatibility.md).
