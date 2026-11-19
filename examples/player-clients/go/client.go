// Package playerclient is an independent Player Protocol 2.0 implementation.
// It imports only the Go standard library, never the official game SDK or AI.
package playerclient

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

type Object = map[string]any

const RequestBytes = 65536
const PageBytes = 262144
const SnapshotBytes = 8388608

var counterPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
var idPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var revisionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func fail(s string) error { return errors.New(s) }
func obj(v any) (Object, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fail("expected JSON object")
	}
	return m, nil
}
func str(v any) string { s, _ := v.(string); return s }
func Counter(v any) (*big.Int, error) {
	s, ok := v.(string)
	if !ok || !counterPattern.MatchString(s) {
		return nil, fail("invalid decimal counter")
	}
	n, _ := new(big.Int).SetString(s, 10)
	return n, nil
}
func integer(v any, min, max float64) (int, error) {
	n, ok := v.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < min || n > max {
		return 0, fail("invalid bounded integer")
	}
	return int(n), nil
}
func id(v any) error {
	if !idPattern.MatchString(str(v)) {
		return fail("invalid protocol identifier")
	}
	return nil
}
func equal(a, b any) bool {
	aa, e := canonicalDepth(a, 64)
	if e != nil {
		return false
	}
	bb, e := canonicalDepth(b, 64)
	return e == nil && bytes.Equal(aa, bb)
}
func clone(v Object) Object {
	b, _ := canonicalDepth(v, 64)
	r, _ := parseDepth(b, 32*SnapshotBytes, 64)
	return r.(Object)
}
func newID() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}

// Parse rejects duplicate decoded keys, invalid UTF-8, surrogate replacement,
// nonfinite binary64 numbers and depth >32. JSON decoder alone is insufficient.
func Parse(raw []byte, limit int) (any, error) { return parseDepth(raw, limit, 32) }
func parseDepth(raw []byte, limit, maxDepth int) (any, error) {
	if len(raw) > limit || !utf8.Valid(raw) {
		return nil, fail("JSON byte or UTF-8 limit")
	}
	// Go's JSON decoder otherwise silently replaces lone escaped surrogates.
	in := false
	for i := 0; i < len(raw); i++ {
		b := raw[i]
		if b == '"' {
			in = !in
			continue
		}
		if !in || b != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return nil, fail("truncated escape")
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return nil, fail("truncated Unicode escape")
		}
		u, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if e != nil {
			return nil, fail("invalid Unicode escape")
		}
		i += 4
		if u >= 0xd800 && u <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return nil, fail("unpaired high surrogate")
			}
			v, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if e != nil || v < 0xdc00 || v > 0xdfff {
				return nil, fail("unpaired high surrogate")
			}
			i += 6
		} else if u >= 0xdc00 && u <= 0xdfff {
			return nil, fail("unpaired low surrogate")
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > maxDepth {
			return nil, fail("JSON depth exceeded")
		}
		token, e := dec.Token()
		if e != nil {
			return nil, fail("invalid JSON")
		}
		switch x := token.(type) {
		case json.Delim:
			if x == '{' {
				m := Object{}
				for dec.More() {
					t, e := dec.Token()
					if e != nil {
						return nil, fail("invalid key")
					}
					k, ok := t.(string)
					if !ok {
						return nil, fail("nonstring key")
					}
					if _, exists := m[k]; exists {
						return nil, fail("duplicate JSON key")
					}
					v, e := read(depth + 1)
					if e != nil {
						return nil, e
					}
					m[k] = v
				}
				end, e := dec.Token()
				if e != nil || end != json.Delim('}') {
					return nil, fail("invalid object")
				}
				return m, nil
			}
			if x == '[' {
				a := []any{}
				for dec.More() {
					v, e := read(depth + 1)
					if e != nil {
						return nil, e
					}
					a = append(a, v)
				}
				end, e := dec.Token()
				if e != nil || end != json.Delim(']') {
					return nil, fail("invalid array")
				}
				return a, nil
			}
			return nil, fail("invalid delimiter")
		case json.Number:
			n, e := strconv.ParseFloat(string(x), 64)
			if e != nil || math.IsInf(n, 0) || math.IsNaN(n) {
				return nil, fail("nonfinite number")
			}
			return n, nil
		case nil, bool, string:
			return x, nil
		default:
			return nil, fail("non-JSON value")
		}
	}
	value, e := read(0)
	if e != nil {
		return nil, e
	}
	if _, e = dec.Token(); e != io.EOF {
		return nil, fail("trailing JSON content")
	}
	return value, nil
}

func quote(s string) (string, error) {
	if !utf8.ValidString(s) {
		return "", fail("invalid Unicode")
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String(), nil
}
func number(n float64) (string, error) {
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return "", fail("nonfinite JSON number")
	}
	if n == 0 {
		return "0", nil
	}
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	s := strconv.FormatFloat(n, 'e', -1, 64)
	parts := strings.Split(s, "e")
	exp, _ := strconv.Atoi(parts[1])
	digits := strings.ReplaceAll(parts[0], ".", "")
	decimal := exp + 1
	if decimal > 0 && decimal <= 21 {
		if decimal >= len(digits) {
			return sign + digits + strings.Repeat("0", decimal-len(digits)), nil
		}
		return sign + digits[:decimal] + "." + digits[decimal:], nil
	}
	if decimal <= 0 && decimal > -6 {
		return sign + "0." + strings.Repeat("0", -decimal) + digits, nil
	}
	tail := ""
	if len(digits) > 1 {
		tail = "." + digits[1:]
	}
	expsign := ""
	if exp >= 0 {
		expsign = "+"
	}
	return sign + digits[:1] + tail + "e" + expsign + strconv.Itoa(exp), nil
}
func utf16Less(a, b string) bool {
	aa, bb := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(aa) && i < len(bb); i++ {
		if aa[i] != bb[i] {
			return aa[i] < bb[i]
		}
	}
	return len(aa) < len(bb)
}

// Canonical implements UTF-16 property ordering and ECMAScript binary64 rendering.
func Canonical(v any) ([]byte, error) { return canonicalDepth(v, 32) }
func canonicalDepth(v any, maxDepth int) ([]byte, error) {
	var enc func(any, int) (string, error)
	enc = func(v any, d int) (string, error) {
		if d > maxDepth {
			return "", fail("JSON depth exceeded")
		}
		switch x := v.(type) {
		case nil:
			return "null", nil
		case bool:
			if x {
				return "true", nil
			}
			return "false", nil
		case string:
			return quote(x)
		case float64:
			return number(x)
		case int:
			return number(float64(x))
		case int64:
			return number(float64(x))
		case []any:
			a := []string{}
			for _, v := range x {
				s, e := enc(v, d+1)
				if e != nil {
					return "", e
				}
				a = append(a, s)
			}
			return "[" + strings.Join(a, ",") + "]", nil
		case Object:
			keys := []string{}
			for k := range x {
				keys = append(keys, k)
			}
			sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
			a := []string{}
			for _, k := range keys {
				q, e := quote(k)
				if e != nil {
					return "", e
				}
				s, e := enc(x[k], d+1)
				if e != nil {
					return "", e
				}
				a = append(a, q+":"+s)
			}
			return "{" + strings.Join(a, ",") + "}", nil
		default:
			return "", fail("not a JSON value")
		}
	}
	s, e := enc(v, 0)
	return []byte(s), e
}
func Digest(v any) (string, error) {
	b, e := Canonical(v)
	if e != nil {
		return "", e
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
func validScope(v any) error {
	m, e := obj(v)
	if e != nil || len(m) != 4 {
		return fail("invalid scope")
	}
	for _, k := range []string{"serverId", "roomEpoch", "playerId"} {
		if e = id(m[k]); e != nil {
			return e
		}
	}
	s, ok := m["roomId"].(string)
	if !ok || len(utf16.Encode([]rune(s))) < 1 || len(utf16.Encode([]rune(s))) > 128 {
		return fail("invalid room ID")
	}
	return nil
}

// Store uses fsync(temp), rename and fsync(directory). A flock prevents two local
// writers. The reference implementation targets Linux/macOS local filesystems.
type Store struct {
	Path string
	Data Object
	lock *os.File
}

func OpenStore(path string) (*Store, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, fail("state already in use")
	}
	s := &Store{Path: path, lock: f, Data: Object{"format": "player-client/1", "outbox": Object{}, "events": []any{}, "dirty": true}}
	raw, e := os.ReadFile(path)
	if e == nil {
		value, e := parseDepth(raw, 32*SnapshotBytes, 64)
		if e != nil {
			s.Close()
			return nil, e
		}
		s.Data, e = obj(value)
		if e != nil || s.Data["format"] != "player-client/1" {
			s.Close()
			return nil, fail("invalid local state")
		}
	} else if !os.IsNotExist(e) {
		s.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Save(data Object) error {
	raw, e := canonicalDepth(data, 64)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(s.Path), ".player-state-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(raw)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(name, s.Path); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(s.Path))
	if e != nil {
		return e
	}
	e = dir.Sync()
	dir.Close()
	if e != nil {
		return e
	}
	s.Data = data
	return nil
}
func (s *Store) Close() error {
	if s.lock == nil {
		return nil
	}
	return s.lock.Close()
}

type Transport interface {
	Call(string, string, any) (Object, error)
}
type HTTPTransport struct {
	origin, token string
	http          *http.Client
}
type RemoteError struct {
	Status int
	Body   Object
}

func (e *RemoteError) Error() string {
	code := str(e.Body["code"])
	switch code {
	case "INVALID_REQUEST", "UNAUTHORIZED", "SCOPE_DENIED", "IDENTITY_MISMATCH", "PROTOCOL_INCOMPATIBLE", "UNSUPPORTED_OPERATION", "ROOM_EPOCH_CHANGED", "LEASE_LOST", "FENCE_STALE", "CONTROL_BUSY", "REVISION_CONFLICT", "INSTRUCTIONS_CHANGED", "IDEMPOTENCY_CONFLICT", "RESYNC_REQUIRED", "SNAPSHOT_EXPIRED", "RATE_LIMITED", "STORAGE_UNAVAILABLE", "SERVER_RESTARTED":
	default:
		code = "INVALID_RESPONSE"
	}
	return fmt.Sprintf("HTTP %d: %s", e.Status, code)
}
func NewHTTP(origin, token string) (*HTTPTransport, error) {
	u, e := url.Parse(origin)
	if e != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fail("expected bare server origin")
	}
	if u.Scheme == "http" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && u.Hostname() != "localhost" {
		return nil, fail("plain HTTP only allowed on loopback")
	}
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, fail("missing/invalid executor token")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	return &HTTPTransport{strings.TrimRight(origin, "/"), token, &http.Client{Timeout: 10 * time.Second, Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return fail("redirect refused") }}}, nil
}
func (t *HTTPTransport) Call(method, path string, body any) (Object, error) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return nil, fail("invalid relative route")
	}
	var raw []byte
	var e error
	if body != nil {
		raw, e = Canonical(body)
		if e != nil {
			return nil, e
		}
		if len(raw) > RequestBytes {
			return nil, fail("request too large")
		}
	}
	req, e := http.NewRequest(method, t.origin+"/player/v2"+path, bytes.NewReader(raw))
	if e != nil {
		return nil, fail("invalid request")
	}
	req.Header.Set("Authorization", "Bearer "+t.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", newID())
	r, e := t.http.Do(req)
	if e != nil {
		return nil, fail("transport failed; a write may already have committed")
	}
	defer r.Body.Close()
	raw, e = io.ReadAll(io.LimitReader(r.Body, PageBytes+1))
	if e != nil {
		return nil, fail("response interrupted")
	}
	v, e := Parse(raw, PageBytes)
	if e != nil {
		return nil, e
	}
	m, e := obj(v)
	if e != nil {
		return nil, e
	}
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		return nil, &RemoteError{r.StatusCode, m}
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return nil, fail("unexpected response media type")
	}
	return m, nil
}

type Client struct {
	Transport     Transport
	Store         *Store
	Expected      Object
	AllowWrite    bool
	HelloResponse Object
	Discovery     Object
	lease         Object
	deadline      time.Time
	generation    uint64
	Now           func() time.Time
}

func NewClient(t Transport, s *Store, expected Object, allow bool) (*Client, error) {
	for _, k := range []string{"serverId", "roomId", "playerId", "gamePlayer", "lobbySeat", "chatPlayer", "chatCount", "roster"} {
		if _, ok := expected[k]; !ok {
			return nil, fail("pin server, room, player and complete seat mapping")
		}
	}
	return &Client{Transport: t, Store: s, Expected: expected, AllowWrite: allow, Now: time.Now}, nil
}
func (c *Client) Pause() { c.generation++; c.lease = nil; c.deadline = time.Time{} }
func (c *Client) save(data Object) error {
	if err := c.Store.Save(data); err != nil {
		c.Pause()
		return err
	}
	return nil
}
func (c *Client) call(method, path string, body any) (Object, error) {
	v, e := c.Transport.Call(method, path, body)
	var r *RemoteError
	if errors.As(e, &r) && (r.Body["category"] == "ownership" || r.Body["category"] == "authorization") {
		c.Pause()
	}
	return v, e
}
func (c *Client) Scope() Object {
	if c.HelloResponse == nil {
		return nil
	}
	s, _ := obj(c.HelloResponse["scope"])
	return s
}
func (c *Client) checkScope(s any) error {
	if validScope(s) != nil || !equal(s, c.Scope()) {
		return fail("response scope/epoch mismatch")
	}
	return nil
}
func (c *Client) Hello() (Object, error) {
	c.Pause()
	c.HelloResponse = nil
	discovery, err := c.call("GET", "/protocol", nil)
	if err != nil {
		return nil, err
	}
	versions, ok := discovery["versions"].([]any)
	compatible := false
	if ok {
		for _, v := range versions {
			if equal(v, Object{"major": 2, "minor": 0}) {
				compatible = true
			}
		}
	}
	advertised, ok := discovery["capabilities"].([]any)
	core := false
	if ok {
		for _, v := range advertised {
			if v == "core/2" {
				core = true
			}
		}
	}
	availability, _ := obj(discovery["actionAvailability"])
	_, actionsOK := availability["actions"].([]any)
	if !compatible || !core || !actionsOK {
		return nil, fail("incompatible discovery or missing action availability")
	}
	c.Discovery = discovery
	v, e := c.call("POST", "/sessions/hello", Object{"supportedVersions": []any{Object{"major": 2, "minor": 0}}, "requiredCapabilities": []any{"core/2"}, "optionalCapabilities": []any{"actions.order/1", "actions.schedule/1"}, "executorInstanceId": "go-" + newID()})
	if e != nil {
		return nil, e
	}
	if validScope(v["scope"]) != nil || !equal(v["version"], Object{"major": 2, "minor": 0}) {
		return nil, fail("unsupported version or scope")
	}
	caps, ok := v["capabilities"].([]any)
	if !ok {
		return nil, fail("invalid capabilities")
	}
	seen := map[string]bool{}
	for _, cap := range caps {
		s, ok := cap.(string)
		if !ok || seen[s] {
			return nil, fail("invalid/duplicate capability")
		}
		seen[s] = true
	}
	if !seen["core/2"] {
		return nil, fail("missing core capability")
	}
	identity, e := obj(v["identity"])
	if e != nil {
		return nil, e
	}
	sc := v["scope"].(Object)
	for k, x := range sc {
		if !equal(identity[k], x) {
			return nil, fail("identity/scope mismatch")
		}
	}
	for k, x := range c.Expected {
		if !equal(identity[k], x) {
			return nil, fail("pinned identity/mapping mismatch")
		}
	}
	roster, ok := identity["roster"].([]any)
	count, e := integer(identity["chatCount"], 2, 10)
	if !ok || e != nil || len(roster) != count {
		return nil, fail("invalid roster")
	}
	games, chats := map[int]bool{}, map[int]bool{}
	found := false
	for _, entry := range roster {
		r, e := obj(entry)
		if e != nil {
			return nil, e
		}
		game, e1 := integer(r["gamePlayer"], 0, 9)
		chat, e2 := integer(r["chatPlayer"], 0, 9)
		if e1 != nil || e2 != nil || games[game] || chats[chat] {
			return nil, fail("invalid roster mapping")
		}
		games[game] = true
		chats[chat] = true
		if equal(r["gamePlayer"], identity["gamePlayer"]) && equal(r["chatPlayer"], identity["chatPlayer"]) {
			found = true
		}
	}
	if !found {
		return nil, fail("identity absent from roster")
	}
	if id(v["sessionId"]) != nil {
		return nil, fail("invalid session")
	}
	if _, e = Counter(v["authorizationVersion"]); e != nil {
		return nil, e
	}
	if str(v["rulesetId"]) == "" || v["rulesetId"] != c.Discovery["rulesetId"] {
		return nil, fail("missing ruleset")
	}
	data := clone(c.Store.Data)
	if !equal(data["scope"], sc) {
		data["scope"] = sc
		data["snapshot"] = nil
		data["cursor"] = nil
		data["seq"] = "0"
		data["streamEpoch"] = nil
		data["dirty"] = true
		data["events"] = []any{}
		out, _ := obj(data["outbox"])
		for _, r := range out {
			rec, _ := obj(r)
			if !equal(rec["scope"], sc) {
				rec["blocked"] = "epoch-or-identity-changed"
			}
		}
	}
	if e = c.save(data); e != nil {
		return nil, e
	}
	c.HelloResponse = v
	return v, nil
}

func (c *Client) Snapshot() (Object, error) {
	gen, started := c.generation, c.Now()
	first, e := c.call("GET", "/snapshot", nil)
	if e != nil {
		return nil, e
	}
	if e = c.checkScope(first["scope"]); e != nil {
		return nil, e
	}
	metadata := clone(first)
	delete(metadata, "page")
	if _, e = Counter(first["highWatermark"]); e != nil {
		return nil, e
	}
	for _, k := range []string{"snapshotId", "streamEpoch", "cursor", "decisionInputVersion"} {
		if e = id(first[k]); e != nil {
			return nil, e
		}
	}
	p, e := obj(first["page"])
	if e != nil {
		return nil, e
	}
	count, e := integer(p["count"], 1, SnapshotBytes)
	if e != nil {
		return nil, e
	}
	page := first
	var raw strings.Builder
	tokens := map[string]bool{}
	for i := 0; i < count; i++ {
		meta := clone(page)
		delete(meta, "page")
		p, e = obj(page["page"])
		if e != nil {
			return nil, e
		}
		index, e1 := integer(p["index"], 0, SnapshotBytes)
		n, e2 := integer(p["count"], 1, SnapshotBytes)
		text, ok := p["text"].(string)
		if !equal(meta, metadata) || e1 != nil || e2 != nil || index != i || n != count || p["encoding"] != "json-text/1" || !ok {
			return nil, fail("snapshot metadata/order changed")
		}
		raw.WriteString(text)
		if raw.Len() > SnapshotBytes {
			return nil, fail("snapshot byte budget exceeded")
		}
		if i+1 == count {
			if p["nextPageToken"] != nil {
				return nil, fail("unexpected continuation")
			}
		} else {
			token := str(p["nextPageToken"])
			if id(token) != nil || tokens[token] {
				return nil, fail("invalid/repeated continuation")
			}
			tokens[token] = true
			page, e = c.call("GET", "/snapshot?"+url.Values{"snapshotId": {str(first["snapshotId"])}, "pageToken": {token}}.Encode(), nil)
			if e != nil {
				return nil, e
			}
		}
	}
	hash := sha256.Sum256([]byte(raw.String()))
	if hex.EncodeToString(hash[:]) != first["snapshotDigest"] {
		return nil, fail("snapshot digest mismatch")
	}
	parsed, e := Parse([]byte(raw.String()), SnapshotBytes)
	if e != nil {
		return nil, e
	}
	canonical, e := Canonical(parsed)
	if e != nil || string(canonical) != raw.String() {
		return nil, fail("snapshot not canonical JCS")
	}
	doc, e := obj(parsed)
	if e != nil {
		return nil, e
	}
	ob, e := obj(doc["observation"])
	if e != nil || !revisionPattern.MatchString(str(ob["revision"])) {
		return nil, fail("invalid observation")
	}
	view, e := obj(ob["view"])
	identity, _ := obj(c.HelloResponse["identity"])
	if e != nil || !equal(view["player"], identity["gamePlayer"]) {
		return nil, fail("snapshot player mismatch")
	}
	if _, e = Counter(doc["instructionsVersion"]); e != nil {
		return nil, e
	}
	coverage, _ := obj(doc["coverage"])
	if coverage["observation"] != "complete" || gen != c.generation || c.Now().Sub(started) >= 60*time.Second {
		return nil, fail("incomplete or stale snapshot")
	}
	data := clone(c.Store.Data)
	data["snapshot"] = doc
	data["cursor"] = first["cursor"]
	data["seq"] = first["highWatermark"]
	data["streamEpoch"] = first["streamEpoch"]
	data["decisionInputVersion"] = first["decisionInputVersion"]
	data["dirty"] = false
	if e = c.save(data); e != nil {
		return nil, e
	}
	done, e := c.call("POST", "/snapshot/"+str(first["snapshotId"])+"/complete", Object{})
	if e != nil {
		return nil, e
	}
	if e = c.checkScope(done["scope"]); e != nil || done["completed"] != true {
		return nil, fail("bootstrap completion not acknowledged")
	}
	return doc, nil
}

func (c *Client) receipt(data Object, receipt Object, record Object) error {
	if validScope(receipt["scope"]) != nil || id(receipt["idempotencyKey"]) != nil || id(receipt["commandId"]) != nil {
		return fail("invalid receipt identity")
	}
	version, e := Counter(receipt["receiptVersion"])
	if e != nil {
		return e
	}
	state := str(receipt["state"])
	if state != "accepted" && state != "applied" && state != "scheduled" && state != "rejected" && state != "cancelled" {
		return fail("unknown receipt state")
	}
	effect, ok := receipt["effectCommitted"].(bool)
	if !ok || effect != (state == "applied" || state == "scheduled" || state == "cancelled") {
		return fail("contradictory receipt effect")
	}
	if record == nil {
		out, _ := obj(data["outbox"])
		record, _ = obj(out[str(receipt["idempotencyKey"])])
	}
	if record == nil {
		return nil
	}
	request, _ := obj(record["request"])
	if !equal(receipt["scope"], record["scope"]) || receipt["idempotencyKey"] != request["idempotencyKey"] || receipt["clientCommandId"] != request["clientCommandId"] || receipt["intentDigest"] != record["digest"] {
		return fail("receipt does not identify durable intent")
	}
	if old, _ := obj(record["receipt"]); old != nil {
		ov, e := Counter(old["receiptVersion"])
		if e != nil {
			return e
		}
		if old["commandId"] != receipt["commandId"] {
			return fail("receipt command ID changed")
		}
		if version.Cmp(ov) < 0 {
			return nil
		}
		if version.Cmp(ov) == 0 {
			if !equal(old, receipt) {
				return fail("conflicting same-version receipt")
			}
			return nil
		}
		if old["effectCommitted"] == true && !effect {
			return fail("effect regressed")
		}
		s := old["state"]
		if (s == "applied" || s == "rejected" || s == "cancelled") && s != state {
			return fail("terminal receipt regressed")
		}
	}
	record["receipt"] = receipt
	record["outcome"] = state
	return nil
}

func (c *Client) Events() (Object, error) {
	data := clone(c.Store.Data)
	cursor := str(data["cursor"])
	if cursor == "" {
		return nil, fail("snapshot required")
	}
	page, e := c.call("GET", "/events?"+url.Values{"after": {cursor}, "limit": {"200"}}.Encode(), nil)
	if e != nil {
		var remote *RemoteError
		if errors.As(e, &remote) && remote.Body["code"] == "RESYNC_REQUIRED" {
			c.Pause()
			data["dirty"] = true
			if se := c.save(data); se != nil {
				return nil, se
			}
		}
		return nil, e
	}
	e = c.applyEvents(data, page)
	if e != nil {
		c.Pause()
		return nil, e
	}
	return page, nil
}
func (c *Client) applyEvents(data, page Object) error {
	if e := c.checkScope(page["scope"]); e != nil {
		return e
	}
	cursor := str(data["cursor"])
	if page["streamEpoch"] != data["streamEpoch"] || page["inputCursor"] != cursor {
		return fail("event stream/cursor mismatch")
	}
	coverage, e := obj(page["coverage"])
	if e != nil {
		return e
	}
	seq, e := Counter(data["seq"])
	if e != nil {
		return e
	}
	from, e := Counter(coverage["fromExclusive"])
	if e != nil || seq.Cmp(from) != 0 {
		return fail("event coverage gap")
	}
	events, ok := page["events"].([]any)
	hasMore, moreOK := page["hasMore"].(bool)
	if !ok || len(events) > 200 || !moreOK || len(events) == 0 && hasMore {
		return fail("invalid event page")
	}
	history, _ := data["events"].([]any)
	controlChanged := false
	for _, v := range events {
		event, e := obj(v)
		if e != nil {
			return e
		}
		if e = c.checkScope(event["scope"]); e != nil {
			return e
		}
		n, e := Counter(event["seq"])
		next := new(big.Int).Add(seq, big.NewInt(1))
		if e != nil || n.Cmp(next) != 0 || event["streamEpoch"] != data["streamEpoch"] {
			return fail("out-of-order/missing event")
		}
		required, ok := event["required"].(bool)
		if !ok {
			return fail("invalid required flag")
		}
		kind := str(event["type"])
		known := kind == "observation.changed" || kind == "command.status.changed" || kind == "control.changed" || kind == "room.lifecycle.changed" || kind == "resync.required"
		if !equal(event["schemaVersion"], 1) || !known {
			if required {
				return fail("unknown required event; stopped")
			}
		} else if kind == "command.status.changed" {
			payload, e := obj(event["payload"])
			if e != nil {
				return e
			}
			r, e := obj(payload["receipt"])
			if e != nil {
				return e
			}
			if e = c.receipt(data, r, nil); e != nil {
				return e
			}
		} else if kind == "control.changed" {
			controlChanged = true
		} else {
			data["dirty"] = true
		}
		if e = id(event["cursor"]); e != nil {
			return e
		}
		seq = next
		cursor = str(event["cursor"])
		history = append(history, event)
	}
	to, e := Counter(coverage["toInclusive"])
	if e != nil || seq.Cmp(to) != 0 || page["nextCursor"] != cursor {
		return fail("event page skips unapplied data")
	}
	if controlChanged {
		if e := c.revalidateControl(); e != nil {
			return e
		}
	}
	if len(history) > 200 {
		history = history[len(history)-200:]
	}
	data["events"] = history
	data["cursor"] = cursor
	data["seq"] = seq.String()
	return c.save(data)
}
func (c *Client) revalidateControl() error {
	if !c.Writable() {
		c.Pause()
		return nil
	}
	old, gen, started := c.lease, c.generation, c.Now()
	current, err := c.call("GET", "/control?"+url.Values{"sessionId": {str(c.HelloResponse["sessionId"])}}.Encode(), nil)
	if err != nil {
		c.Pause()
		return err
	}
	if err = c.checkScope(current["scope"]); err != nil {
		c.Pause()
		return err
	}
	if _, err = Counter(current["generation"]); err != nil {
		c.Pause()
		return err
	}
	if gen != c.generation || current["mode"] != "agent" || current["sessionId"] != c.HelloResponse["sessionId"] || current["generation"] != old["generation"] {
		c.Pause()
		return nil
	}
	remaining, err := integer(current["remainingTtlMs"], 0, 120000)
	if err != nil {
		c.Pause()
		return err
	}
	deadline := started.Add(time.Duration(remaining) * time.Millisecond)
	if c.deadline.Before(deadline) {
		deadline = c.deadline
	}
	if !c.Now().Before(deadline) {
		c.Pause()
		return nil
	}
	c.lease, c.deadline = current, deadline
	return nil
}

func (c *Client) Writable() bool { return c.AllowWrite && c.lease != nil && c.Now().Before(c.deadline) }
func (c *Client) Control(operation string, ttl int) (Object, error) {
	if !c.AllowWrite || c.HelloResponse == nil {
		return nil, fail("read-only or handshake required")
	}
	if operation != "acquire" && operation != "renew" && operation != "release" {
		return nil, fail("unknown control operation")
	}
	if operation != "acquire" && !c.Writable() {
		return nil, fail("no valid local lease")
	}
	old := c.lease
	body := Object{"roomEpoch": c.Scope()["roomEpoch"], "sessionId": c.HelloResponse["sessionId"], "idempotencyKey": newID()}
	if operation != "acquire" {
		body["fence"] = old["generation"]
	}
	if operation != "release" {
		if ttl < 1000 || ttl > 120000 {
			return nil, fail("invalid lease TTL")
		}
		body["ttlMs"] = ttl
	} else {
		c.Pause()
	}
	gen, start := c.generation, c.Now()
	value, e := c.call("POST", "/control/"+operation, body)
	if e == nil {
		e = c.acceptControl(operation, value, old, body, gen, start)
	}
	if e != nil {
		c.Pause()
		return nil, e
	}
	return value, nil
}
func (c *Client) acceptControl(operation string, value, old, body Object, gen uint64, start time.Time) error {
	if gen != c.generation {
		return fail("late control response")
	}
	current, e := obj(value["current"])
	if e != nil {
		return e
	}
	historical, e := obj(value["operationResult"])
	if e != nil {
		return e
	}
	for _, lease := range []Object{current, historical} {
		if e = c.checkScope(lease["scope"]); e != nil {
			return e
		}
		if _, e = Counter(lease["generation"]); e != nil {
			return e
		}
	}
	if operation == "release" {
		return nil
	}
	if current["mode"] != "agent" || current["sessionId"] != body["sessionId"] || historical["sessionId"] != body["sessionId"] || current["generation"] != historical["generation"] {
		return fail("lease owner/generation mismatch")
	}
	if operation == "renew" && (current["generation"] != old["generation"] || !start.Before(c.deadline)) {
		return fail("renewed stale lease")
	}
	remaining, e := integer(current["remainingTtlMs"], 0, 120000)
	if e != nil {
		return e
	}
	deadline := start.Add(time.Duration(remaining) * time.Millisecond)
	if !c.Now().Before(deadline) || (operation == "renew" && !c.Now().Before(c.deadline)) {
		return fail("late/expired lease response")
	}
	c.lease = current
	c.deadline = deadline
	return nil
}

func ValidateAction(action Object) error {
	kind := str(action["kind"])
	specs := map[string][2]string{
        "resign": {"", ""}, "check-in": {"", ""}, "cancel-inactivity-warning": {"", ""},
        "cancel-launch": {"fleetId", ""}, "return-fleet": {"fleetId", ""},
        "toggle-mine": {"outpostId", ""}, "set-shields": {"outpostId enabled", ""},
        "toggle-funding": {"recipient", ""}, "launch": {"source destination drillers", "delaySeconds fleetId"}}
	spec, ok := specs[kind]
	if !ok {
		return fail("unknown action")
	}
	allowed := map[string]bool{"kind": true}
	for _, k := range strings.Fields(spec[0]) {
		allowed[k] = true
		if _, ok := action[k]; !ok {
			return fail("missing action field")
		}
	}
	for _, k := range strings.Fields(spec[1]) {
		allowed[k] = true
	}
	for k := range action {
		if !allowed[k] {
			return fail("unknown action field")
		}
	}
	validID := func(v any) bool {
		s, ok := v.(string)
		n := len(utf16.Encode([]rune(s)))
		return ok && utf8.ValidString(s) && n > 0 && n <= 128
	}
	for _, k := range []string{"fleetId", "outpostId", "source", "destination"} {
		if v, ok := action[k]; ok && !validID(v) {
			return fail("invalid action ID")
		}
	}
	bounds := map[string][2]float64{"drillers": {1, 1e9}, "recipient": {0, 9}, "delaySeconds": {0, 86400}}
	for k, b := range bounds {
		if v, ok := action[k]; ok {
			if _, e := integer(v, b[0], b[1]); e != nil {
				return e
			}
		}
	}
	if v, ok := action["enabled"]; ok {
		if _, ok = v.(bool); !ok {
			return fail("invalid enabled flag")
		}
	}
	return nil
}
func (c *Client) Prepare(kind string, payload Object) (string, error) {
	if !c.Writable() {
		return "", fail("no explicitly enabled valid lease")
	}
	data := clone(c.Store.Data)
	snapshot, e := obj(data["snapshot"])
	if e != nil || data["dirty"] != false {
		return "", fail("refresh observation before planning")
	}
	out, e := obj(data["outbox"])
	if e != nil {
		return "", e
	}
	for _, v := range out {
		rec, _ := obj(v)
		if rec["outcome"] == "unknown" || rec["outcome"] == "accepted" {
			return "", fail("resolve unknown/pending commands before new intent")
		}
	}
	capability := "actions.order/1"
	if kind == "schedule" || kind == "cancel-schedule" {
		capability = "actions.schedule/1"
	}
	caps, _ := c.HelloResponse["capabilities"].([]any)
	has := false
	for _, v := range caps {
		if v == capability {
			has = true
		}
	}
	if !has || (kind != "order" && kind != "schedule" && kind != "cancel-schedule") {
		return "", fail("unnegotiated action capability")
	}
	if kind == "cancel-schedule" {
		s, ok := payload["id"].(string)
		if !ok || !utf8.ValidString(s) || len(payload) != 1 || len(utf16.Encode([]rune(s))) < 1 || len(utf16.Encode([]rune(s))) > 128 {
			return "", fail("invalid cancel payload")
		}
	} else {
		n := 1
		if kind == "schedule" {
			n = 2
			if _, e = integer(payload["issueTick"], 0, 9007199254740991); e != nil {
				return "", e
			}
		}
		if len(payload) != n {
			return "", fail("unknown payload field")
		}
		a, e := obj(payload["action"])
		if e != nil {
			return "", e
		}
		if e = ValidateAction(a); e != nil {
			return "", e
		}
		availability, _ := obj(c.Discovery["actionAvailability"])
		actions, _ := availability["actions"].([]any)
		available := false
		for _, action := range actions {
			if action == a["kind"] {
				available = true
			}
		}
		if !available {
			return "", fail("action unavailable in this room")
		}
	}
	ob, _ := obj(snapshot["observation"])
	key := newID()
	request := Object{"roomEpoch": c.Scope()["roomEpoch"], "sessionId": c.HelloResponse["sessionId"], "fence": c.lease["generation"], "authorizationVersion": c.HelloResponse["authorizationVersion"], "idempotencyKey": key, "clientCommandId": newID(), "expectedRevision": ob["revision"], "instructionsVersion": snapshot["instructionsVersion"], "kind": kind, "payload": payload}
	intent := clone(request)
	delete(intent, "idempotencyKey")
	intent["scope"] = c.Scope()
	hash, e := Digest(intent)
	if e != nil {
		return "", e
	}
	out[key] = Object{"scope": c.Scope(), "request": request, "digest": hash, "outcome": "unknown"}
	if e = c.save(data); e != nil {
		return "", e
	}
	return key, nil
}
func (c *Client) record(key string) (Object, error) {
	out, _ := obj(c.Store.Data["outbox"])
	r, e := obj(out[key])
	if e != nil {
		return nil, fail("unknown local key")
	}
	return r, nil
}
func (c *Client) originalAuthority(record Object) bool {
	request, _ := obj(record["request"])
	return c.Writable() && equal(record["scope"], c.Scope()) && record["blocked"] == nil && request["sessionId"] == c.HelloResponse["sessionId"] && request["fence"] == c.lease["generation"]
}
func (c *Client) Submit(key string) (Object, error) {
	record, e := c.record(key)
	if e != nil {
		return nil, e
	}
	if !c.originalAuthority(record) {
		return nil, fail("old intent cannot use new epoch/session/fence")
	}
	if record["sent"] == true {
		return nil, fail("already attempted; reconcile original key")
	}
	data := clone(c.Store.Data)
	out, _ := obj(data["outbox"])
	rec, _ := obj(out[key])
	rec["sent"] = true
	if e = c.save(data); e != nil {
		return nil, e
	}
	return c.sendOriginal(key)
}
func (c *Client) sendOriginal(key string) (Object, error) {
	record, e := c.record(key)
	if e != nil {
		return nil, e
	}
	receipt, e := c.call("POST", "/commands", record["request"])
	if e == nil {
		data := clone(c.Store.Data)
		e = c.receipt(data, receipt, nil)
		if e == nil {
			data["dirty"] = true
			e = c.save(data)
		}
	}
	if e != nil {
		c.Pause()
		return nil, e
	}
	return receipt, nil
}
func (c *Client) Reconcile(key string, retryAbsent bool) (Object, error) {
	record, e := c.record(key)
	if e != nil {
		return nil, e
	}
	sc, _ := obj(record["scope"])
	result, e := c.call("POST", "/commands/lookup", Object{"roomEpoch": sc["roomEpoch"], "idempotencyKeys": []any{key}})
	if e != nil {
		return nil, e
	}
	items, ok := result["results"].([]any)
	if !ok || len(items) != 1 || validScope(result["scope"]) != nil || !equal(result["scope"], sc) {
		return nil, fail("lookup scope/count mismatch")
	}
	item, e := obj(items[0])
	if e != nil {
		return nil, e
	}
	coverage, e := obj(item["coverage"])
	if e != nil {
		return nil, e
	}
	_, authOK := coverage["authoritative"].(bool)
	if !authOK || coverage["roomEpoch"] != sc["roomEpoch"] || (coverage["retained"] != "complete" && coverage["retained"] != "unavailable") {
		return nil, fail("invalid coverage")
	}
	data := clone(c.Store.Data)
	out, _ := obj(data["outbox"])
	rec, _ := obj(out[key])
	status := item["status"]
	switch status {
	case "found":
		if coverage["authoritative"] != true || coverage["retained"] != "complete" {
			return nil, fail("found without authoritative coverage")
		}
		receipt, e := obj(item["receipt"])
		if e != nil {
			return nil, e
		}
		if e = c.receipt(data, receipt, rec); e != nil {
			return nil, e
		}
	case "absent_within_retained_scope", "history_unavailable":
		if item["idempotencyKey"] != key {
			return nil, fail("lookup key mismatch")
		}
		if status == "absent_within_retained_scope" && (coverage["authoritative"] != true || coverage["retained"] != "complete") {
			return nil, fail("absence without coverage")
		}
	default:
		return nil, fail("unknown lookup status")
	}
	rec["lookup"] = item
	if e = c.save(data); e != nil {
		return nil, e
	}
	if retryAbsent && status == "absent_within_retained_scope" {
		if !c.originalAuthority(record) {
			return nil, fail("cannot retry under changed authority")
		}
		return c.sendOriginal(key)
	}
	return item, nil
}
