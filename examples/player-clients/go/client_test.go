package playerclient

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

var testScope = Object{"serverId": "server", "roomId": "room", "roomEpoch": "epoch", "playerId": "player-73235ea6-3a6a-4420-8ecd-1a789fcf4556"}
var testIdentity = Object{"serverId": "server", "roomId": "room", "roomEpoch": "epoch", "playerId": "player-73235ea6-3a6a-4420-8ecd-1a789fcf4556", "gamePlayer": 0, "lobbySeat": 1, "chatPlayer": 1, "chatCount": 2, "roster": []any{Object{"gamePlayer": 0, "chatPlayer": 1}, Object{"gamePlayer": 1, "chatPlayer": 0}}}

func expected() Object { v := clone(testIdentity); delete(v, "roomEpoch"); return v }
func testHello() Object {
	return clone(Object{"scope": testScope, "identity": testIdentity, "sessionId": "session", "version": Object{"major": 2, "minor": 0}, "capabilities": []any{"core/2", "actions.order/1", "actions.schedule/1"}, "authorizationVersion": "9007199254740993", "rulesetId": "rule"})
}
func testDoc() Object {
	return Object{"observation": Object{"revision": strings.Repeat("a", 64), "view": Object{"player": 0, "unknown": nil}}, "instructionsVersion": "9007199254740993", "coverage": Object{"observation": "complete", "chat": "not-supported"}}
}
func pages(doc Object, split bool) []Object {
	raw, _ := Canonical(doc)
	parts := []string{string(raw)}
	if split {
		parts = []string{string(raw[:30]), string(raw[30:])}
	}
	hash := sha256.Sum256(raw)
	result := []Object{}
	for i, p := range parts {
		var next any
		if i+1 < len(parts) {
			next = "next"
		}
		result = append(result, clone(Object{"scope": testScope, "snapshotId": "snap", "bootstrapExpiresAt": "2099-01-01T00:00:00Z", "streamEpoch": "stream", "highWatermark": "9007199254740993", "cursor": "cursor", "decisionInputVersion": "input", "snapshotDigest": hex.EncodeToString(hash[:]), "page": Object{"index": i, "count": len(parts), "encoding": "json-text/1", "text": p, "nextPageToken": next}}))
	}
	return result
}

type callRecord struct {
	method, path string
	body         any
}
type fake struct {
	calls    []callRecord
	handlers map[string]func(any) (Object, error)
}

func (f *fake) Call(method, path string, body any) (Object, error) {
	f.calls = append(f.calls, callRecord{method, path, body})
	h := f.handlers[path]
	if h == nil {
		return nil, errors.New("unexpected fake route: " + path)
	}
	v, e := h(body)
	if e != nil {
		return nil, e
	}
	return clone(v), nil
}
func installPages(f *fake, pages []Object) {
	f.handlers["/snapshot"] = func(any) (Object, error) { return pages[0], nil }
	if len(pages) > 1 {
		f.handlers["/snapshot?pageToken=next&snapshotId=snap"] = func(any) (Object, error) { return pages[1], nil }
	}
	f.handlers["/snapshot/snap/complete"] = func(any) (Object, error) { return Object{"scope": testScope, "completed": true}, nil }
}
func fixture(t *testing.T) (*Client, *fake) {
	t.Helper()
	s, e := OpenStore(filepath.Join(t.TempDir(), "state.json"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	f := &fake{handlers: map[string]func(any) (Object, error){}}
	f.handlers["/protocol"] = func(any) (Object, error) {
		return Object{"versions": []any{Object{"major": 2, "minor": 0}}, "capabilities": []any{"core/2"}, "rulesetId": "rule", "actionAvailability": Object{"actions": []any{"set-shields", "check-in"}}}, nil
	}
	f.handlers["/sessions/hello"] = func(any) (Object, error) { return testHello(), nil }
	c, e := NewClient(f, s, expected(), true)
	if e != nil {
		t.Fatal(e)
	}
	c.Now = func() time.Time { return time.Unix(10, 0) }
	if _, e = c.Hello(); e != nil {
		t.Fatal(e)
	}
	installPages(f, pages(testDoc(), false))
	if _, e = c.Snapshot(); e != nil {
		t.Fatal(e)
	}
	return c, f
}
func acquire(t *testing.T, c *Client, f *fake) Object {
	t.Helper()
	lease := clone(Object{"scope": testScope, "generation": "9007199254740993", "sessionId": "session", "mode": "agent", "ttlMs": 30000, "remainingTtlMs": 10000})
	f.handlers["/control/acquire"] = func(any) (Object, error) { return Object{"operationResult": lease, "current": lease}, nil }
	if _, e := c.Control("acquire", 30000); e != nil {
		t.Fatal(e)
	}
	return lease
}
func intent(t *testing.T, c *Client, f *fake) string {
	t.Helper()
	acquire(t, c, f)
	key, e := c.Prepare("order", Object{"action": Object{"kind": "set-shields", "outpostId": "蓝方工厂", "enabled": false}})
	if e != nil {
		t.Fatal(e)
	}
	return key
}
func testReceipt(c *Client, key, state, version string) Object {
	rec, _ := c.record(key)
	req, _ := obj(rec["request"])
	return Object{"scope": testScope, "commandId": "command", "idempotencyKey": key, "clientCommandId": req["clientCommandId"], "intentDigest": rec["digest"], "receiptVersion": version, "state": state, "effectCommitted": state == "applied" || state == "scheduled" || state == "cancelled"}
}
func lookup(f *fake, key, status string, r Object) {
	item := Object{"status": status, "coverage": Object{"roomEpoch": "epoch", "authoritative": status != "history_unavailable", "retained": "complete", "queryUntil": nil}}
	if status == "history_unavailable" {
		item["coverage"].(Object)["retained"] = "unavailable"
	}
	if r != nil {
		item["receipt"] = r
	} else {
		item["idempotencyKey"] = key
	}
	f.handlers["/commands/lookup"] = func(any) (Object, error) { return Object{"scope": testScope, "results": []any{item}}, nil }
}
func event(c *Client, kind string) Object {
	n, _ := Counter(c.Store.Data["seq"])
	n.Add(n, big.NewInt(1))
	return Object{"scope": testScope, "streamEpoch": "stream", "seq": n.String(), "cursor": "next-cursor", "type": kind, "schemaVersion": 1, "required": true, "payload": Object{}}
}
func eventPage(c *Client, events []any) Object {
	cursor := c.Store.Data["cursor"]
	seq := c.Store.Data["seq"]
	if len(events) > 0 {
		e := events[len(events)-1].(Object)
		cursor = e["cursor"]
		seq = e["seq"]
	}
	return Object{"scope": testScope, "streamEpoch": "stream", "inputCursor": c.Store.Data["cursor"], "nextCursor": cursor, "hasMore": false, "coverage": Object{"fromExclusive": c.Store.Data["seq"], "toInclusive": seq}, "events": events}
}

func TestV01V03V04NormativeFixtures(t *testing.T) {
	root := "../../../protocol/player/v2/fixtures"
	raw, e := os.ReadFile(filepath.Join(root, "canonical.json"))
	if e != nil {
		t.Fatal(e)
	}
	var vectors []struct{ Name, Raw, Canonical, Sha256 string }
	if e = json.Unmarshal(raw, &vectors); e != nil {
		t.Fatal(e)
	}
	for _, v := range vectors {
		value, e := Parse([]byte(v.Raw), PageBytes)
		if e != nil {
			t.Fatal(e)
		}
		actual, e := Canonical(value)
		if e != nil || string(actual) != v.Canonical {
			t.Fatalf("%s: %s %v", v.Name, actual, e)
		}
		hash := sha256.Sum256(actual)
		if hex.EncodeToString(hash[:]) != v.Sha256 {
			t.Fatal("hash mismatch")
		}
	}
	raw, _ = os.ReadFile(filepath.Join(root, "invalid-json.json"))
	var invalid []string
	json.Unmarshal(raw, &invalid)
	invalid = append(invalid, string([]byte{'"', 0xff, '"'}), strings.Repeat("[", 33)+"0"+strings.Repeat("]", 33), "\ufeff{}")
	for _, s := range invalid {
		if _, e := Parse([]byte(s), PageBytes); e == nil {
			t.Fatalf("accepted invalid %q", s)
		}
	}
	raw, _ = os.ReadFile(filepath.Join(root, "counters.json"))
	var counters struct {
		Valid   []string
		Invalid []any
		Ordered []string
	}
	json.Unmarshal(raw, &counters)
	for _, s := range counters.Valid {
		n, e := Counter(s)
		if e != nil || n.String() != s {
			t.Fatal(s, e)
		}
	}
	for _, s := range counters.Invalid {
		if _, e := Counter(s); e == nil {
			t.Fatal("accepted invalid counter", s)
		}
	}
	for i := 1; i < len(counters.Ordered); i++ {
		a, _ := Counter(counters.Ordered[i-1])
		b, _ := Counter(counters.Ordered[i])
		if a.Cmp(b) >= 0 {
			t.Fatal("counter ordering")
		}
	}
}
func TestV02NullMissingZeroEmpty(t *testing.T) {
	v, e := Parse([]byte(`{"null":null,"zero":0,"empty":[],"unknown":{"known":false}}`), PageBytes)
	if e != nil {
		t.Fatal(e)
	}
	m := v.(Object)
	if _, exists := m["missing"]; exists {
		t.Fatal("invented missing")
	}
	if m["null"] != nil || m["zero"] != float64(0) || !equal(m["empty"], []any{}) || !equal(m["unknown"], Object{"known": false}) {
		t.Fatal("lost distinctions")
	}
}
func TestV05PinnedIdentityAndCapabilities(t *testing.T) {
	c, f := fixture(t)
	changes := []Object{{"version": Object{"major": 3, "minor": 0}}, {"capabilities": []any{}}, {"identity": Object{"gamePlayer": 1}}}
	for _, change := range changes {
		f.handlers["/sessions/hello"] = func(any) (Object, error) {
			h := testHello()
			for k, v := range change {
				h[k] = v
			}
			return h, nil
		}
		if _, e := c.Hello(); e == nil {
			t.Fatal("accepted incompatible hello")
		}
		if c.Writable() {
			t.Fatal("writable after failure")
		}
	}
}
func TestS04FixedPagesAtomicInstallation(t *testing.T) {
	c, f := fixture(t)
	installPages(f, pages(testDoc(), true))
	if _, e := c.Snapshot(); e != nil {
		t.Fatal(e)
	}
	old := clone(c.Store.Data)
	for _, mutation := range []func(Object){func(p Object) { p["highWatermark"] = "1" }, func(p Object) { p["page"].(Object)["index"] = 0 }, func(p Object) { p["page"].(Object)["text"] = "tampered" }} {
		p := pages(testDoc(), true)
		mutation(p[1])
		installPages(f, p)
		if _, e := c.Snapshot(); e == nil {
			t.Fatal("accepted corrupt pages")
		}
		if !equal(old, c.Store.Data) {
			t.Fatal("partial snapshot installed")
		}
	}
}
func TestS02ExpiredSnapshot(t *testing.T) {
	c, f := fixture(t)
	old := clone(c.Store.Data)
	installPages(f, pages(testDoc(), true))
	f.handlers["/snapshot?pageToken=next&snapshotId=snap"] = func(any) (Object, error) {
		return nil, &RemoteError{409, Object{"code": "SNAPSHOT_EXPIRED", "category": "resync"}}
	}
	if _, e := c.Snapshot(); e == nil {
		t.Fatal("accepted expired snapshot")
	}
	if !equal(old, c.Store.Data) {
		t.Fatal("installed incomplete snapshot")
	}
}
func TestS05CommitFailureReplays(t *testing.T) {
	c, f := fixture(t)
	page := eventPage(c, []any{event(c, "observation.changed")})
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) { return page, nil }
	oldPath := c.Store.Path
	c.Store.Path = filepath.Join(t.TempDir(), "absent", "file")
	if _, e := c.Events(); e == nil {
		t.Fatal("expected commit fault")
	}
	if c.Store.Data["cursor"] != "cursor" {
		t.Fatal("advanced before durable commit")
	}
	c.Store.Path = oldPath
	if _, e := c.Events(); e != nil {
		t.Fatal(e)
	}
	if c.Store.Data["cursor"] != "next-cursor" {
		t.Fatal("failed replay")
	}
}
func TestS06L06RestartCursorNotLease(t *testing.T) {
	c, f := fixture(t)
	acquire(t, c, f)
	page := eventPage(c, []any{event(c, "observation.changed")})
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) { return page, nil }
	if _, e := c.Events(); e != nil {
		t.Fatal(e)
	}
	path := c.Store.Path
	c.Store.Close()
	s, e := OpenStore(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	resumed, e := NewClient(f, s, expected(), true)
	if e != nil {
		t.Fatal(e)
	}
	if s.Data["cursor"] != "next-cursor" || resumed.Writable() {
		t.Fatal("unsafe restart")
	}
	events := s.Data["events"].([]any)
	if len(events) != 1 {
		t.Fatal("event duplicated")
	}
}
func TestS07GapCannotAdvance(t *testing.T) {
	c, f := fixture(t)
	ev := event(c, "observation.changed")
	ev["seq"] = "9007199254740995"
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) { return eventPage(c, []any{ev}), nil }
	if _, e := c.Events(); e == nil {
		t.Fatal("accepted gap")
	}
	if c.Store.Data["cursor"] != "cursor" {
		t.Fatal("advanced gap")
	}
}
func TestS11UnknownRequiredAndRedaction(t *testing.T) {
	c, f := fixture(t)
	acquire(t, c, f)
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) { return eventPage(c, []any{event(c, "future.required")}), nil }
	if _, e := c.Events(); e == nil || c.Writable() {
		t.Fatal("required event did not stop")
	}
	doc := testDoc()
	doc["observation"].(Object)["view"].(Object)["previouslyVisible"] = 3
	installPages(f, pages(doc, false))
	if _, e := c.Snapshot(); e != nil {
		t.Fatal(e)
	}
	installPages(f, pages(testDoc(), false))
	if _, e := c.Snapshot(); e != nil {
		t.Fatal(e)
	}
	view := c.Store.Data["snapshot"].(Object)["observation"].(Object)["view"].(Object)
	if _, ok := view["previouslyVisible"]; ok {
		t.Fatal("stale redacted field retained")
	}
}
func TestOptionalUnknownCoverage(t *testing.T) {
	c, f := fixture(t)
	ev := event(c, "future.optional")
	ev["required"] = false
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) { return eventPage(c, []any{ev}), nil }
	if _, e := c.Events(); e != nil {
		t.Fatal(e)
	}
	if c.Store.Data["cursor"] != "next-cursor" {
		t.Fatal("did not consume optional event")
	}
}
func TestC04OutboxBeforeSendLostResponse(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	f.handlers["/commands"] = func(body any) (Object, error) {
		raw, e := os.ReadFile(c.Store.Path)
		if e != nil {
			t.Fatal(e)
		}
		v, e := Parse(raw, 32*SnapshotBytes)
		if e != nil {
			t.Fatal(e)
		}
		rec := v.(Object)["outbox"].(Object)[key].(Object)
		if !equal(rec["request"], body) || rec["sent"] != true {
			t.Fatal("intent not durable before send")
		}
		return nil, errors.New("dropped response")
	}
	if _, e := c.Submit(key); e == nil {
		t.Fatal("expected drop")
	}
	r, _ := c.record(key)
	if r["outcome"] != "unknown" {
		t.Fatal("invented failure")
	}
	lookup(f, key, "found", testReceipt(c, key, "applied", "3"))
	if _, e := c.Reconcile(key, false); e != nil {
		t.Fatal(e)
	}
	r, _ = c.record(key)
	if r["outcome"] != "applied" {
		t.Fatal("not reconciled")
	}
	posts := 0
	for _, call := range f.calls {
		if call.path == "/commands" {
			posts++
		}
	}
	if posts != 1 {
		t.Fatal("duplicate send")
	}
}
func TestC05AbsentRetryExactIntent(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	r, _ := c.record(key)
	original := clone(r["request"].(Object))
	lookup(f, key, "absent_within_retained_scope", nil)
	f.handlers["/commands"] = func(body any) (Object, error) {
		if !equal(body, original) {
			t.Fatal("mutated original intent")
		}
		return testReceipt(c, key, "applied", "3"), nil
	}
	if _, e := c.Reconcile(key, true); e != nil {
		t.Fatal(e)
	}
}
func TestC06UnavailableHistoryRemainsUnknown(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	lookup(f, key, "history_unavailable", nil)
	if _, e := c.Reconcile(key, true); e != nil {
		t.Fatal(e)
	}
	r, _ := c.record(key)
	if r["outcome"] != "unknown" {
		t.Fatal("unknown rewritten")
	}
	if _, e := c.Prepare("order", Object{"action": Object{"kind": "check-in"}}); e == nil {
		t.Fatal("allowed replacing unknown intent")
	}
}
func TestC09ReceiptVersionMonotonic(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	data := clone(c.Store.Data)
	if e := c.receipt(data, testReceipt(c, key, "applied", "3"), nil); e != nil {
		t.Fatal(e)
	}
	if e := c.receipt(data, testReceipt(c, key, "accepted", "1"), nil); e != nil {
		t.Fatal(e)
	}
	r := data["outbox"].(Object)[key].(Object)
	if r["outcome"] != "applied" {
		t.Fatal("late accepted regressed")
	}
	if e := c.receipt(data, testReceipt(c, key, "accepted", "3"), nil); e == nil {
		t.Fatal("same version conflict accepted")
	}
}
func TestE04C10EpochChangeStopsOldIntent(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	f.handlers["/sessions/hello"] = func(any) (Object, error) {
		v := testHello()
		v["scope"].(Object)["roomEpoch"] = "new-epoch"
		v["identity"].(Object)["roomEpoch"] = "new-epoch"
		return v, nil
	}
	if _, e := c.Hello(); e != nil {
		t.Fatal(e)
	}
	r, _ := c.record(key)
	if r["request"].(Object)["roomEpoch"] != "epoch" || r["blocked"] != "epoch-or-identity-changed" {
		t.Fatal("migrated old intent")
	}
	if _, e := c.Submit(key); e == nil {
		t.Fatal("old intent submitted")
	}
	if _, e := c.Snapshot(); e == nil {
		t.Fatal("accepted old epoch snapshot")
	}
	if c.Store.Data["snapshot"] != nil {
		t.Fatal("installed old epoch")
	}
}
func TestL04LateRenewCannotRevive(t *testing.T) {
	c, f := fixture(t)
	lease := acquire(t, c, f)
	f.handlers["/control/renew"] = func(any) (Object, error) { c.Pause(); return Object{"current": lease, "operationResult": lease}, nil }
	if _, e := c.Control("renew", 30000); e == nil || c.Writable() {
		t.Fatal("late renew revived lease")
	}
}
func TestL05LeaseRemainingMinusRoundtrip(t *testing.T) {
	c, f := fixture(t)
	i := 0
	c.Now = func() time.Time {
		i++
		if i == 1 {
			return time.Unix(10, 0)
		}
		return time.Unix(11, 0)
	}
	lease := Object{"scope": testScope, "generation": "1", "sessionId": "session", "mode": "agent", "ttlMs": 120000, "remainingTtlMs": 5000}
	f.handlers["/control/acquire"] = func(any) (Object, error) { return Object{"current": lease, "operationResult": lease}, nil }
	if _, e := c.Control("acquire", 30000); e != nil {
		t.Fatal(e)
	}
	if !c.deadline.Equal(time.Unix(15, 0)) {
		t.Fatal("used configured TTL or arrival time")
	}
}
func TestS09CursorExpiryPreservesPending(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) {
		return nil, &RemoteError{409, Object{"code": "RESYNC_REQUIRED", "category": "resync"}}
	}
	if _, e := c.Events(); e == nil {
		t.Fatal("expected expiry")
	}
	r, _ := c.record(key)
	if r["outcome"] != "unknown" {
		t.Fatal("pending lost")
	}
	lookup(f, key, "found", testReceipt(c, key, "applied", "3"))
	if _, e := c.Reconcile(key, false); e != nil {
		t.Fatal(e)
	}
	if _, e := c.Snapshot(); e != nil {
		t.Fatal(e)
	}
}
func TestReadOnlyAndSingleWriter(t *testing.T) {
	c, f := fixture(t)
	readonly, e := NewClient(f, c.Store, expected(), false)
	if e != nil {
		t.Fatal(e)
	}
	readonly.Hello()
	if _, e = readonly.Control("acquire", 30000); e == nil {
		t.Fatal("default client acquired")
	}
	if second, e := OpenStore(c.Store.Path); e == nil {
		second.Close()
		t.Fatal("concurrent local writer")
	}
}

func TestV04Binary64EdgesAndDeterministicVectors(t *testing.T) {
	raw, err := os.ReadFile("../interop/number-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Hex, Canonical string }
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		bits, err := strconv.ParseUint(v.Hex, 16, 64)
		if err != nil {
			t.Fatal(err)
		}
		actual, err := Canonical(math.Float64frombits(bits))
		if err != nil || string(actual) != v.Canonical {
			t.Fatalf("%s got %s want %s error %v", v.Hex, actual, v.Canonical, err)
		}
	}
}
func TestMaximumWireDepthDocumentPersists(t *testing.T) {
	c, f := fixture(t)
	doc := testDoc()
	var nested any = 0
	for i := 0; i < 29; i++ {
		nested = []any{nested}
	}
	doc["observation"].(Object)["view"].(Object)["nested"] = nested
	installPages(f, pages(doc, false))
	if _, err := c.Snapshot(); err != nil {
		t.Fatal(err)
	}
	path := c.Store.Path
	c.Store.Close()
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !equal(s.Data["snapshot"], doc) {
		t.Fatal("max-depth document did not survive restart")
	}
}

func TestControlInvalidationReadsCurrentWithoutExtending(t *testing.T) {
	c, f := fixture(t)
	lease := acquire(t, c, f)
	f.handlers["/control?sessionId=session"] = func(any) (Object, error) {
		current := clone(lease)
		current["remainingTtlMs"] = 30000
		return current, nil
	}
	f.handlers["/events?after=cursor&limit=200"] = func(any) (Object, error) { return eventPage(c, []any{event(c, "control.changed")}), nil }
	if _, err := c.Events(); err != nil {
		t.Fatal(err)
	}
	if !c.Writable() || !c.deadline.Equal(time.Unix(20, 0)) {
		t.Fatal("own control event stopped or extended lease")
	}
	f.handlers["/control?sessionId=session"] = func(any) (Object, error) {
		current := clone(lease)
		current["generation"] = "9007199254740994"
		return current, nil
	}
	if err := c.revalidateControl(); err != nil {
		t.Fatal(err)
	}
	if c.Writable() {
		t.Fatal("new generation revived old authority")
	}
}

func TestC05PausedAbsenceNeverRetiresUnknown(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	record, _ := c.record(key)
	original := clone(record["request"].(Object))
	c.Pause()
	lookup(f, key, "absent_within_retained_scope", nil)
	result, e := c.Reconcile(key, false)
	if e != nil || result["status"] != "absent_within_retained_scope" {
		t.Fatal("lookup failed", e)
	}
	if _, e = c.Reconcile(key, true); e == nil {
		t.Fatal("paused retry allowed")
	}
	record, _ = c.record(key)
	if record["outcome"] != "unknown" || !equal(record["request"], original) {
		t.Fatal("absence retired or changed intent")
	}
	for _, call := range f.calls {
		if call.path == "/commands" {
			t.Fatal("resent while paused")
		}
	}
	acquire(t, c, f)
	if _, e = c.Prepare("order", Object{"action": Object{"kind": "check-in"}}); e == nil {
		t.Fatal("new intent replaced unknown")
	}
}
func TestC06AuthorizationOrLeaseLossNeverErasesUnknown(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	record, _ := c.record(key)
	original := clone(record)
	for _, cause := range []struct{ code, category string }{{"UNAUTHORIZED", "authorization"}, {"SCOPE_DENIED", "authorization"}, {"LEASE_LOST", "ownership"}, {"FENCE_STALE", "ownership"}} {
		t.Run(cause.code, func(t *testing.T) {
			acquire(t, c, f)
			f.handlers["/commands/lookup"] = func(any) (Object, error) {
				return nil, &RemoteError{Status: 403, Body: Object{"code": cause.code, "category": cause.category, "outcome": "rejected"}}
			}
			if _, e := c.Reconcile(key, true); e == nil {
				t.Fatal("ignored denial")
			}
			record, _ := c.record(key)
			if c.Writable() || !equal(record, original) {
				t.Fatal("denial erased unknown or kept write lease")
			}
		})
	}
	for _, call := range f.calls {
		if call.path == "/commands" {
			t.Fatal("resent after rejection")
		}
	}
}
func TestC05ExpiredLocalLeaseDoesNotMakeAbsenceFinal(t *testing.T) {
	c, f := fixture(t)
	key := intent(t, c, f)
	c.Now = func() time.Time { return time.Unix(1000, 0) }
	lookup(f, key, "absent_within_retained_scope", nil)
	if _, e := c.Reconcile(key, true); e == nil {
		t.Fatal("retry with expired local lease")
	}
	record, _ := c.record(key)
	if c.Writable() || record["outcome"] != "unknown" {
		t.Fatal("expiry retired unknown")
	}
	for _, call := range f.calls {
		if call.path == "/commands" {
			t.Fatal("resent after expiry")
		}
	}
}
