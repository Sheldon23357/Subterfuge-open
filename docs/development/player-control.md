# Player ownership and control (v2)

Player control is part of the versioned protocol. The authenticated player page reads `GET /player/v2/owner/control`; an executor negotiates `POST /player/v2/sessions/hello` and uses the executor lease at `/player/v2/control/*`. Only these v2 routes are exposed.

## Owner view and manual commands

The owner control response identifies the authenticated room and player, reports `protocol: "player-control/2"`, `mode`, `controller`, `expiresAt` and `manualCommandsAllowed`, and returns the session ID only when the request supplies the matching `X-Subterfuge-Control-Session`. It never returns a player token or changes control state on GET.

The current server reports `manualCommandsAllowed: true` for authenticated owners, including during executor leases and after release or expiry. Lease history does not restrict owner gameplay; the command path still enforces identity, legality and manual-priority arbitration.

The player page uses the response as a capability check. If an executor owns the seat and `manualCommandsAllowed` is false, gameplay writes are blocked. When it is true, ordinary owner orders use `POST /player/v2/owner/commands` and participate in manual-priority arbitration without changing the executor lease. Chat remains blocked while an executor owns the seat. Successful gameplay orders renew activity on the server; the player page does not send separate automatic check-ins. The UI has no bot pause, takeover, resume, hand-back or protection-management controls.

Owner commands carry `kind`, `clientCommandId`, `expectedRevision`, and `payload`; scheduled commands also carry `issueTick`. Identity comes from the bearer credential, never the request body. Authentication, revision checks, game legality and manual-conflict checks run on the server. A stale revision is rejected for replanning; accepted commands are not rolled back by a later lease expiry.

## Executor lease

The official executor first negotiates v2, obtains its session scope, then acquires a lease through `/player/v2/control/acquire`. It renews and releases through the corresponding v2 routes. Control headers and bearer credentials serve different purposes: the grant authenticates the executor, while its session and fence identify the current lease. Expired, revoked, displaced or mismatched leases fail closed; an unknown write result is reconciled by its durable command receipt and is never blindly resubmitted.

The local hosted AI uses the owner control surface for its seat-scoped player projection. Owner credentials do not become executor grants, and executor grants do not authenticate as owner credentials. A player manually taking control uses the v2 owner control action; the server stops the hosted runner for that seat before reporting the takeover.

Leases are scoped to room epoch and seat. A room reset or supported restore invalidates old authority. Restart invalidates live sessions while preserving game state and durable command history; an executor must negotiate and acquire a fresh lease. The runner starts paused after its own restart and does not infer that an interrupted command was unapplied.

## Clock and UI behavior

The lab `/api/auto-advance` toggle changes only the clock's enabled state. It does not resume paused AI or acquire a player lease. Normal realtime progression and explicit manual progression remain separate from executor readiness; readiness is reported through the v2 protocol and does not itself advance the room.

The control label is informational. The UI polls the authenticated v2 owner status and blocks writes according to the returned capability rather than a client-side role flag. Only the current versioned protocol is supported.
