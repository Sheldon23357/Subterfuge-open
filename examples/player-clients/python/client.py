#!/usr/bin/env python3
"""Independent Player Protocol 2.0 client. Python 3.11+, standard library only.

No strategy, engine, official SDK, model, notebook, or private server database.
A single process owns each state file. All command intent is durable before send.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

REQUEST_BYTES = 65536
PAGE_BYTES = 262144
SNAPSHOT_BYTES = 8388608
COUNTER = re.compile(r"(?:0|[1-9][0-9]{0,77})\Z", re.ASCII)
IDENTIFIER = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z", re.ASCII)
SCOPE_KEYS = ("serverId", "roomId", "roomEpoch", "playerId")
ERROR_CODES = {"INVALID_REQUEST", "UNAUTHORIZED", "SCOPE_DENIED", "IDENTITY_MISMATCH", "PROTOCOL_INCOMPATIBLE", "UNSUPPORTED_OPERATION", "ROOM_EPOCH_CHANGED", "LEASE_LOST", "FENCE_STALE", "CONTROL_BUSY", "REVISION_CONFLICT", "INSTRUCTIONS_CHANGED", "IDEMPOTENCY_CONFLICT", "RESYNC_REQUIRED", "SNAPSHOT_EXPIRED", "RATE_LIMITED", "STORAGE_UNAVAILABLE", "SERVER_RESTARTED"}
EVENTS = {"observation.changed", "command.status.changed", "control.changed", "room.lifecycle.changed", "resync.required"}


class ProtocolError(Exception):
    pass


class RemoteError(ProtocolError):
    def __init__(self, status, body):
        self.status, self.body = status, body
        # Never include URL, token, raw bodies or transport exceptions in diagnostics.
        code = body.get("code")
        safe_code = code if isinstance(code, str) and code in ERROR_CODES else "INVALID_RESPONSE"
        super().__init__(f"HTTP {status}: {safe_code}")


def require(condition, message):
    if not condition:
        raise ProtocolError(message)


def counter(value):
    require(isinstance(value, str) and COUNTER.fullmatch(value), "Invalid decimal counter")
    return int(value)


def identifier(value):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value), "Invalid protocol identifier")
    return value


def integer(value, minimum=0, maximum=9007199254740991):
    require(not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
            and value == int(value) and minimum <= value <= maximum, "Invalid bounded integer")
    return int(value)


def valid_unicode(value):
    require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value), "Unpaired Unicode surrogate")
    return value


def strict_json(data, limit=PAGE_BYTES, max_depth=32):
    if isinstance(data, str):
        valid_unicode(data)
        data = data.encode("utf-8")
    require(len(data) <= limit, "JSON byte limit exceeded")
    try:
        text = data.decode("utf-8", "strict")
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ProtocolError("Duplicate JSON key")
                result[key] = value
            return result
        def number(text):
            value = float(text)
            require(math.isfinite(value), "Nonfinite number")
            return value
        def constant(_):
            raise ProtocolError("Non-JSON numeric constant")
        value = json.loads(text, object_pairs_hook=pairs, parse_int=number,
                           parse_float=number, parse_constant=constant)
        def validate(v, depth):
            require(depth <= max_depth, "JSON depth limit exceeded")
            if isinstance(v, str):
                valid_unicode(v)
            elif isinstance(v, dict):
                for k, x in v.items():
                    valid_unicode(k)
                    validate(x, depth + 1)
            elif isinstance(v, list):
                for x in v:
                    validate(x, depth + 1)
        validate(value, 0)
        return value
    except (UnicodeError, ValueError, RecursionError) as error:
        raise ProtocolError("Invalid strict JSON") from error


def number_text(value):
    """Binary64 shortest-roundtrip digits with ECMAScript's decimal thresholds."""
    value = float(value)
    require(math.isfinite(value), "Nonfinite number")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    text = repr(abs(value)).lower()
    mantissa, _, exponent = text.partition("e")
    exponent = int(exponent or 0)
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).lstrip("0")
    decimal = len(whole) + exponent
    # repr uses leading 0 for fractional fixed notation.
    leading = len(whole + fraction) - len((whole + fraction).lstrip("0"))
    decimal -= leading
    digits = digits.rstrip("0")
    if 0 < decimal <= 21:
        rendered = digits[:decimal] + ("0" * max(0, decimal - len(digits)))
        if decimal < len(digits):
            rendered += "." + digits[decimal:]
    elif -6 < decimal <= 0:
        rendered = "0." + "0" * -decimal + digits
    else:
        exp = decimal - 1
        rendered = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
        rendered += "e" + ("+" if exp >= 0 else "") + str(exp)
    return sign + rendered


def canonical(value, max_depth=32):
    def encode(v, depth=0):
        require(depth <= max_depth, "JSON depth limit exceeded")
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return number_text(v)
        if isinstance(v, str):
            return json.dumps(valid_unicode(v), ensure_ascii=False, separators=(",", ":"))
        if isinstance(v, list):
            return "[" + ",".join(encode(x, depth + 1) for x in v) + "]"
        if isinstance(v, dict):
            require(all(isinstance(k, str) for k in v), "Nonstring JSON key")
            keys = sorted(v, key=lambda k: valid_unicode(k).encode("utf-16-be"))
            return "{" + ",".join(encode(k) + ":" + encode(v[k], depth + 1) for k in keys) + "}"
        raise ProtocolError("Not a JSON value")
    return encode(value).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def scope(value):
    require(isinstance(value, dict) and set(value) == set(SCOPE_KEYS), "Invalid scope")
    for key in SCOPE_KEYS:
        if key == "roomId":
            require(isinstance(value[key], str) and 0 < len(valid_unicode(value[key]).encode("utf-16-le")) // 2 <= 128, "Invalid room ID")
        else:
            identifier(value[key])
    return value


def action_validate(action):
    require(isinstance(action, dict), "Action must be an object")
    kind = action.get("kind")
    specs = {
        "resign": (set(), set()), "check-in": (set(), set()),
        "cancel-inactivity-warning": (set(), set()),
        "cancel-launch": ({"fleetId"}, set()), "return-fleet": ({"fleetId"}, set()),
        "toggle-mine": ({"outpostId"}, set()),
        "set-shields": ({"outpostId", "enabled"}, set()), "toggle-funding": ({"recipient"}, set()),
        "launch": ({"source", "destination", "drillers"}, {"delaySeconds", "fleetId"}),
    }
    require(kind in specs, "Unknown action kind")
    required, optional = specs[kind]
    require(required | {"kind"} <= action.keys() and action.keys() <= required | optional | {"kind"}, "Unknown or missing action field")
    for key in ("fleetId", "outpostId", "source", "destination"):
        if key in action:
            value = action[key]
            require(isinstance(value, str) and 0 < len(valid_unicode(value).encode("utf-16-le")) // 2 <= 128, "Invalid action ID")
    for key, low, high in [("drillers", 1, 10**9), ("recipient", 0, 9), ("delaySeconds", 0, 86400)]:
        if key in action:
            integer(action[key], low, high)
    if "enabled" in action:
        require(isinstance(action["enabled"], bool), "Invalid enabled flag")


class Store:
    """One atomic state/outbox document inside SQLite, FULL synchronous commits."""
    def __init__(self, path):
        import fcntl  # Reference client targets Linux/macOS; no external dependency.
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = open(str(path) + ".lock", "a+b")
        os.chmod(str(path) + ".lock", 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock.close()
            raise ProtocolError("State file is already in use")
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)")
        row = self.db.execute("SELECT document FROM state WHERE id=1").fetchone()
        self.data = strict_json(row[0], 32 * SNAPSHOT_BYTES, 64) if row else {"format": "player-client/1", "outbox": {}, "events": [], "dirty": True}
        require(self.data.get("format") == "player-client/1", "Unsupported local state format")

    def save(self, value):
        encoded = canonical(value, 64).decode()
        with self.db:
            self.db.execute("INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document", (encoded,))
        self.data = value

    def close(self):
        self.db.close()
        self.lock.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProtocolError("Redirect refused; credential remains origin-bound")


class Transport:
    def __init__(self, origin, token, timeout=10):
        parsed = urllib.parse.urlsplit(origin)
        require(parsed.scheme in ("http", "https") and parsed.hostname and not parsed.username and not parsed.password and parsed.path in ("", "/") and not parsed.query and not parsed.fragment, "Expected a bare server origin")
        require(parsed.scheme == "https" or parsed.hostname in ("127.0.0.1", "::1", "localhost"), "Plain HTTP is allowed only on loopback")
        require(isinstance(token, str) and token and "\r" not in token and "\n" not in token, "Missing or invalid executor token")
        self.origin, self.token, self.timeout = origin.rstrip("/"), token, timeout
        # Do not forward credentials through ambient HTTP proxies.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(self, method, path, body=None):
        require(path.startswith("/") and not path.startswith("//"), "Invalid relative route")
        payload = canonical(body) if body is not None else None
        require(payload is None or len(payload) <= REQUEST_BYTES, "Request too large")
        request = urllib.request.Request(self.origin + "/player/v2" + path, data=payload, method=method,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json", "X-Request-Id": str(uuid.uuid4())})
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read(PAGE_BYTES + 1)
            parsed = strict_json(raw)
            require(isinstance(parsed, dict), "Invalid error envelope")
            raise RemoteError(error.code, parsed)
        except (OSError, urllib.error.URLError) as error:
            raise ProtocolError("Transport failed; a write may already have committed") from error
        with response:
            require(response.headers.get_content_type() == "application/json", "Unexpected response media type")
            return strict_json(response.read(PAGE_BYTES + 1))


class Client:
    def __init__(self, transport, store, expected_identity, allow_write=False, monotonic=time.monotonic):
        self.transport, self.store, self.expected = transport, store, expected_identity
        self.allow_write, self.clock = allow_write, monotonic
        self.hello_response = None
        self.discovery = None
        self.lease = None
        self.deadline = 0
        self.generation = 0
        required = {"serverId", "roomId", "playerId", "gamePlayer", "lobbySeat", "chatPlayer", "chatCount", "roster"}
        require(isinstance(expected_identity, dict) and required <= expected_identity.keys(), "Pin server, room, player and complete seat mapping before connecting")

    def pause(self):
        self.generation += 1
        self.lease, self.deadline = None, 0

    def _save(self, value):
        try:
            self.store.save(value)
        except Exception:
            self.pause()
            raise

    def call(self, method, path, body=None):
        try:
            return self.transport.call(method, path, body)
        except RemoteError as error:
            if error.body.get("category") in ("authorization", "ownership"):
                self.pause()
            raise

    @property
    def current_scope(self):
        require(self.hello_response is not None, "Handshake required")
        return self.hello_response["scope"]

    def check_scope(self, value):
        require(scope(value) == self.current_scope, "Response scope/epoch mismatch")

    def hello(self):
        self.pause()
        self.hello_response = None
        self.discovery = self.call("GET", "/protocol")
        require({"major": 2, "minor": 0} in self.discovery.get("versions", []), "No compatible advertised protocol")
        require("core/2" in self.discovery.get("capabilities", []), "Server does not implement core")
        require(isinstance(self.discovery.get("actionAvailability", {}).get("actions"), list), "Missing action availability")
        value = self.call("POST", "/sessions/hello", {"supportedVersions": [{"major": 2, "minor": 0}], "requiredCapabilities": ["core/2"], "optionalCapabilities": ["actions.order/1", "actions.schedule/1"], "executorInstanceId": "python-" + str(uuid.uuid4())})
        sc = scope(value["scope"])
        require(canonical(value.get("version")) == canonical({"major": 2, "minor": 0}), "Unsupported protocol version")
        caps = value.get("capabilities")
        require(isinstance(caps, list) and len(caps) == len(set(caps)) and "core/2" in caps, "Missing required core capability")
        identity = value.get("identity")
        require(isinstance(identity, dict) and all(identity.get(k) == sc[k] for k in SCOPE_KEYS), "Identity/scope mismatch")
        require(all(canonical(identity.get(k)) == canonical(v) for k, v in self.expected.items()), "Pinned identity or seat mapping mismatch")
        for field in ("gamePlayer", "lobbySeat", "chatPlayer"):
            integer(identity[field], 0, 9)
        roster = identity["roster"]
        require(isinstance(roster, list) and len(roster) == integer(identity["chatCount"], 2, 10), "Invalid roster")
        for entry in roster:
            integer(entry["gamePlayer"], 0, 9)
            integer(entry["chatPlayer"], 0, 9)
        require(len({x["gamePlayer"] for x in roster}) == len(roster) and len({x["chatPlayer"] for x in roster}) == len(roster), "Duplicate roster slot")
        require({"gamePlayer": identity["gamePlayer"], "chatPlayer": identity["chatPlayer"]} in roster, "Identity missing from roster")
        identifier(value["sessionId"])
        counter(value["authorizationVersion"])
        require(isinstance(value.get("rulesetId"), str) and value["rulesetId"] == self.discovery.get("rulesetId"), "Missing or changed ruleset")
        data = copy.deepcopy(self.store.data)
        if data.get("scope") != sc:
            data.update(scope=sc, snapshot=None, cursor=None, seq="0", streamEpoch=None, dirty=True, events=[])
            # Retain every old outbox record, but never migrate its scope or intent.
            for record in data["outbox"].values():
                if record["scope"] != sc:
                    record["blocked"] = "epoch-or-identity-changed"
        self._save(data)
        self.hello_response = value
        return value

    def snapshot(self):
        generation, started = self.generation, self.clock()
        first = self.call("GET", "/snapshot")
        self.check_scope(first["scope"])
        metadata = {k: v for k, v in first.items() if k != "page"}
        counter(first["highWatermark"])
        for key in ("snapshotId", "streamEpoch", "cursor", "decisionInputVersion"):
            identifier(first[key])
        count = integer(first["page"]["count"], 1, SNAPSHOT_BYTES)
        chunks, total, tokens = [], 0, set()
        page = first
        for index in range(count):
            require({k: v for k, v in page.items() if k != "page"} == metadata, "Snapshot metadata changed between pages")
            fragment = page["page"]
            require(integer(fragment["index"]) == index and integer(fragment["count"]) == count and fragment["encoding"] == "json-text/1", "Out-of-order or invalid snapshot page")
            require(isinstance(fragment["text"], str), "Invalid snapshot fragment")
            total += len(fragment["text"].encode("utf-8"))
            require(total <= SNAPSHOT_BYTES, "Snapshot byte budget exceeded")
            chunks.append(fragment["text"])
            token = fragment["nextPageToken"]
            if index + 1 == count:
                require(token is None, "Unexpected snapshot continuation")
            else:
                identifier(token)
                require(token not in tokens, "Repeated snapshot continuation")
                tokens.add(token)
                page = self.call("GET", "/snapshot?" + urllib.parse.urlencode({"snapshotId": first["snapshotId"], "pageToken": token}))
        raw = "".join(chunks).encode("utf-8")
        require(hashlib.sha256(raw).hexdigest() == first["snapshotDigest"], "Snapshot digest mismatch")
        document = strict_json(raw, SNAPSHOT_BYTES)
        require(canonical(document) == raw, "Snapshot is not canonical JCS")
        require(isinstance(document, dict) and isinstance(document.get("observation"), dict), "Invalid snapshot document")
        observation = document["observation"]
        require(re.fullmatch(r"[0-9a-f]{64}", observation.get("revision", "")), "Invalid observation revision")
        require(observation["view"]["player"] == self.hello_response["identity"]["gamePlayer"], "Snapshot player mapping mismatch")
        counter(document["instructionsVersion"])
        require(document.get("coverage", {}).get("observation") == "complete", "Incomplete observation")
        require(generation == self.generation and self.clock() - started < 60, "Stale or expired snapshot response")
        # Commit the entire validated document and H together; never install fragments.
        data = copy.deepcopy(self.store.data)
        data.update(snapshot=document, cursor=first["cursor"], seq=first["highWatermark"], streamEpoch=first["streamEpoch"], decisionInputVersion=first["decisionInputVersion"], dirty=False)
        self._save(data)
        completion = self.call("POST", "/snapshot/" + first["snapshotId"] + "/complete", {})
        self.check_scope(completion["scope"])
        require(completion.get("completed") is True, "Bootstrap completion was not acknowledged")
        return document

    def _receipt(self, data, receipt, record=None):
        require(isinstance(receipt, dict), "Invalid receipt")
        receipt_scope = scope(receipt["scope"])
        key = identifier(receipt["idempotencyKey"])
        version = counter(receipt["receiptVersion"])
        require(receipt["state"] in ("accepted", "applied", "scheduled", "rejected", "cancelled"), "Unknown receipt state")
        require(isinstance(receipt["effectCommitted"], bool), "Invalid effect flag")
        require(receipt["effectCommitted"] == (receipt["state"] in ("applied", "scheduled", "cancelled")), "Contradictory receipt effect")
        identifier(receipt["commandId"])
        record = record or data["outbox"].get(key)
        if not record:
            return  # Another executor's scoped receipt is not this client's intent.
        require(receipt_scope == record["scope"] and key == record["request"]["idempotencyKey"] and receipt["clientCommandId"] == record["request"]["clientCommandId"] and receipt["intentDigest"] == record["digest"], "Receipt does not identify durable intent")
        old = record.get("receipt")
        if old:
            require(old["commandId"] == receipt["commandId"], "Command ID changed")
            old_version = counter(old["receiptVersion"])
            if version < old_version:
                return
            if version == old_version:
                require(canonical(old) == canonical(receipt), "Conflicting same-version receipt")
                return
            require(not old["effectCommitted"] or receipt["effectCommitted"], "Committed effect regressed")
            require(old["state"] not in ("applied", "rejected", "cancelled") or receipt["state"] == old["state"], "Terminal receipt regressed")
        record["receipt"], record["outcome"] = receipt, receipt["state"]

    def events(self):
        data = copy.deepcopy(self.store.data)
        require(data.get("cursor"), "Install snapshot before events")
        cursor = data["cursor"]
        try:
            page = self.call("GET", "/events?" + urllib.parse.urlencode({"after": cursor, "limit": 200}))
        except RemoteError as error:
            if error.body.get("code") == "RESYNC_REQUIRED":
                self.pause()
                data["dirty"] = True
                self._save(data)
            raise
        try:
            self.check_scope(page["scope"])
            require(page["streamEpoch"] == data["streamEpoch"] and page["inputCursor"] == cursor, "Event stream/cursor mismatch")
            require(counter(page["coverage"]["fromExclusive"]) == counter(data["seq"]), "Event coverage gap")
            require(isinstance(page["events"], list) and len(page["events"]) <= 200 and isinstance(page["hasMore"], bool), "Invalid event page")
            seq = counter(data["seq"])
            control_changed = False
            for event in page["events"]:
                self.check_scope(event["scope"])
                require(event["streamEpoch"] == data["streamEpoch"] and counter(event["seq"]) == seq + 1, "Out-of-order or missing event")
                require(isinstance(event["required"], bool), "Invalid event required flag")
                if canonical(event["schemaVersion"]) != b"1" or event["type"] not in EVENTS:
                    require(event["required"] is False, "Unknown required event; stopped")
                elif event["type"] == "command.status.changed":
                    self._receipt(data, event["payload"]["receipt"])
                elif event["type"] == "control.changed":
                    control_changed = True
                else:
                    data["dirty"] = True
                seq += 1
                cursor = identifier(event["cursor"])
                data["events"].append(event)
            require(counter(page["coverage"]["toInclusive"]) == seq and page["nextCursor"] == cursor, "Event page skips unapplied data")
            require(page["events"] or not page["hasMore"], "Empty nonterminal event page")
            if control_changed:
                self._revalidate_control()
            # Retain bounded diagnostics, not a mandatory memory implementation.
            data["events"] = data["events"][-200:]
            data.update(cursor=cursor, seq=str(seq))
            self._save(data)
            return page
        except Exception:
            self.pause()
            raise

    def _revalidate_control(self):
        # A control invalidation may be our own acquire event. Read authority,
        # never automatically reacquire, and never extend a local deadline.
        if not self.writable():
            self.pause()
            return
        old, generation, started = self.lease, self.generation, self.clock()
        try:
            current = self.call("GET", "/control?" + urllib.parse.urlencode({"sessionId": self.hello_response["sessionId"]}))
            self.check_scope(current["scope"])
            counter(current["generation"])
            if generation != self.generation or current["mode"] != "agent" or current["sessionId"] != self.hello_response["sessionId"] or current["generation"] != old["generation"]:
                self.pause()
                return
            deadline = min(self.deadline, started + integer(current["remainingTtlMs"], 0, 120000) / 1000)
            if self.clock() >= deadline:
                self.pause()
                return
            self.lease, self.deadline = current, deadline
        except Exception:
            self.pause()
            raise

    def writable(self):
        return self.allow_write and self.lease is not None and self.clock() < self.deadline

    def control(self, operation, ttl_ms=30000):
        require(operation in ("acquire", "renew", "release"), "Unknown control operation")
        require(self.allow_write, "Read-only: explicitly enable writes")
        require(self.hello_response is not None, "Handshake required")
        if operation != "acquire":
            require(self.writable(), "No valid local lease")
        original = self.lease
        body = {"roomEpoch": self.current_scope["roomEpoch"], "sessionId": self.hello_response["sessionId"], "idempotencyKey": str(uuid.uuid4())}
        if operation != "acquire":
            body["fence"] = original["generation"]
        if operation != "release":
            body["ttlMs"] = integer(ttl_ms, 1000, 120000)
        if operation == "release":
            self.pause()  # A lost response cannot leave us writable.
        generation, started = self.generation, self.clock()
        try:
            value = self.call("POST", "/control/" + operation, body)
            require(generation == self.generation, "Late control response")
            for field in ("operationResult", "current"):
                self.check_scope(value[field]["scope"])
                counter(value[field]["generation"])
            if operation == "release":
                return value
            current, historical = value["current"], value["operationResult"]
            require(current["mode"] == "agent" and current["sessionId"] == body["sessionId"] == historical["sessionId"] and current["generation"] == historical["generation"], "Lease owner or generation mismatch")
            if operation == "renew":
                require(current["generation"] == original["generation"] and started < self.deadline, "Renewed a stale lease")
            remaining = integer(current["remainingTtlMs"], 0, 120000) / 1000
            deadline = started + remaining  # Subtract full RTT from server remainder.
            require(self.clock() < deadline and (operation != "renew" or self.clock() < self.deadline), "Late or expired lease response")
            self.lease, self.deadline = current, deadline
            return value
        except Exception:
            self.pause()
            raise

    def prepare(self, kind, payload):
        require(self.writable(), "No explicitly enabled, valid lease")
        data = copy.deepcopy(self.store.data)
        require(data.get("snapshot") and not data["dirty"], "Refresh invalidated observation before planning")
        require(not any(x["outcome"] in ("unknown", "accepted") for x in data["outbox"].values()), "Resolve pending/unknown commands before new intents")
        capability = "actions.schedule/1" if kind in ("schedule", "cancel-schedule") else "actions.order/1"
        require(kind in ("order", "schedule", "cancel-schedule") and capability in self.hello_response["capabilities"], "Unnegotiated action capability")
        if kind == "cancel-schedule":
            require(set(payload) == {"id"} and isinstance(payload["id"], str) and 0 < len(valid_unicode(payload["id"]).encode("utf-16-le")) // 2 <= 128, "Invalid cancel payload")
        else:
            require(set(payload) == ({"action", "issueTick"} if kind == "schedule" else {"action"}), "Unknown payload field")
            action_validate(payload["action"])
            require(payload["action"]["kind"] in self.discovery["actionAvailability"]["actions"], "Action unavailable in this room")
            if kind == "schedule":
                integer(payload["issueTick"])
        key = str(uuid.uuid4())
        request = {"roomEpoch": self.current_scope["roomEpoch"], "sessionId": self.hello_response["sessionId"], "fence": self.lease["generation"], "authorizationVersion": self.hello_response["authorizationVersion"], "idempotencyKey": key, "clientCommandId": str(uuid.uuid4()), "expectedRevision": data["snapshot"]["observation"]["revision"], "instructionsVersion": data["snapshot"]["instructionsVersion"], "kind": kind, "payload": copy.deepcopy(payload)}
        intent = {"scope": self.current_scope, **{k: v for k, v in request.items() if k != "idempotencyKey"}}
        data["outbox"][key] = {"scope": copy.deepcopy(self.current_scope), "request": request, "digest": digest(intent), "outcome": "unknown"}
        self._save(data)
        return key

    def submit(self, key):
        record = self.store.data["outbox"][key]
        require(self.writable() and record["scope"] == self.current_scope and not record.get("blocked") and record["request"]["sessionId"] == self.hello_response["sessionId"] and record["request"]["fence"] == self.lease["generation"], "Old intent cannot be submitted with a new epoch/session/fence")
        # This public operation is single-send. Retries go through reconcile only.
        require(not record.get("sent"), "Already attempted: reconcile the original key first")
        data = copy.deepcopy(self.store.data)
        data["outbox"][key]["sent"] = True
        self._save(data)
        return self._send_original(key)

    def _send_original(self, key):
        record = self.store.data["outbox"][key]
        try:
            receipt = self.call("POST", "/commands", record["request"])
            data = copy.deepcopy(self.store.data)
            self._receipt(data, receipt)
            data["dirty"] = True
            self._save(data)
            return receipt
        except Exception:
            # Even an HTTP error is not a durable receipt for an admitted command.
            self.pause()
            raise

    def reconcile(self, key, retry_absent=False):
        record = self.store.data["outbox"][key]
        expected_scope = record["scope"]
        result = self.call("POST", "/commands/lookup", {"roomEpoch": expected_scope["roomEpoch"], "idempotencyKeys": [key]})
        require(scope(result["scope"]) == expected_scope and len(result["results"]) == 1, "Lookup scope/count mismatch")
        item = result["results"][0]
        coverage = item["coverage"]
        require(coverage["roomEpoch"] == expected_scope["roomEpoch"] and isinstance(coverage["authoritative"], bool) and coverage["retained"] in ("complete", "unavailable"), "Invalid ledger coverage")
        data = copy.deepcopy(self.store.data)
        if item["status"] == "found":
            require(coverage["authoritative"] and coverage["retained"] == "complete", "Found without authoritative coverage")
            self._receipt(data, item["receipt"], data["outbox"][key])
        else:
            require(item["status"] in ("absent_within_retained_scope", "history_unavailable") and item["idempotencyKey"] == key, "Invalid lookup result")
            if item["status"] == "absent_within_retained_scope":
                require(coverage["authoritative"] and coverage["retained"] == "complete", "Absence without coverage")
            # Absence is NOT a failed operation. Preserve unknown until proven terminal.
        data["outbox"][key]["lookup"] = item
        self._save(data)
        if retry_absent and item["status"] == "absent_within_retained_scope":
            request = record["request"]
            require(self.writable() and self.current_scope == expected_scope and not record.get("blocked") and request["sessionId"] == self.hello_response["sessionId"] and request["fence"] == self.lease["generation"], "Cannot retry under changed authority")
            return self._send_original(key)  # Exact original bytes/intent/key, never patched.
        return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--identity", required=True, help="Pinned non-secret identity JSON file")
    parser.add_argument("--state", required=True, help="Private SQLite state/outbox path")
    parser.add_argument("--token-env", default="PLAYER_EXECUTOR_TOKEN")
    parser.add_argument("--allow-write", action="store_true", help="Explicitly acquire a lease for a supplied command")
    parser.add_argument("--command", help="JSON file containing {kind,payload}; requires --allow-write")
    parser.add_argument("--resume-only", action="store_true", help="Consume durable cursor and reconcile; never create an intent")
    args = parser.parse_args()
    require(not args.command or args.allow_write, "--command requires --allow-write")
    require(not (args.command and args.resume_only), "Resume-only cannot create a command")
    identity = strict_json(Path(args.identity).read_bytes())
    store = Store(args.state)
    client = Client(Transport(args.origin, os.environ.get(args.token_env, "")), store, identity, args.allow_write)
    try:
        client.hello()
        reconciled = []
        for key, record in list(store.data["outbox"].items()):
            if record["outcome"] in ("unknown", "accepted", "scheduled"):
                reconciled.append({"key": key, "result": client.reconcile(key)["status"]})
        if store.data.get("cursor"):
            try:
                while client.events()["hasMore"]:
                    pass
            except RemoteError as error:
                if error.body.get("code") != "RESYNC_REQUIRED":
                    raise
        if not store.data.get("snapshot") or store.data["dirty"]:
            client.snapshot()
        result = {"mode": "paused", "scope": client.current_scope, "cursor": store.data["cursor"], "reconciled": reconciled}
        if args.command:
            command = strict_json(Path(args.command).read_bytes(), REQUEST_BYTES)
            require(isinstance(command, dict) and set(command) == {"kind", "payload"}, "Invalid command file")
            client.control("acquire")
            key = client.prepare(command["kind"], command["payload"])
            try:
                result["receipt"] = client.submit(key)
            except ProtocolError:
                result["recovery"] = client.reconcile(key)
            if client.writable():
                client.control("release")
        print(canonical(result).decode())
    finally:
        client.pause()
        store.close()


if __name__ == "__main__":
    try:
        main()
    except (ProtocolError, KeyError, TypeError, ValueError) as error:
        print("Client stopped: " + (str(error) if isinstance(error, ProtocolError) else "invalid response or local configuration"), file=sys.stderr)
        sys.exit(1)
