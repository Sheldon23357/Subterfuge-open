package main

import (
	"errors"
	pc "example.org/playerclient"
	"flag"
	"fmt"
	"os"
)

func load(path string) (pc.Object, error) {
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	v, e := pc.Parse(raw, pc.RequestBytes)
	if e != nil {
		return nil, e
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("expected object file")
	}
	return m, nil
}
func run() error {
	origin := flag.String("origin", "", "server origin")
	identityPath := flag.String("identity", "", "pinned non-secret identity JSON file")
	statePath := flag.String("state", "", "private durable state JSON path")
	tokenEnv := flag.String("token-env", "PLAYER_EXECUTOR_TOKEN", "environment variable containing executor token")
	allow := flag.Bool("allow-write", false, "explicitly enable a lease for a supplied command")
	commandPath := flag.String("command", "", "{kind,payload} JSON file; requires --allow-write")
	resume := flag.Bool("resume-only", false, "consume durable cursor and reconcile, never create an intent")
	flag.Parse()
	if *origin == "" || *identityPath == "" || *statePath == "" {
		return errors.New("origin, identity and state are required")
	}
	if *commandPath != "" && (!*allow || *resume) {
		return errors.New("command requires --allow-write and cannot use --resume-only")
	}
	identity, e := load(*identityPath)
	if e != nil {
		return e
	}
	store, e := pc.OpenStore(*statePath)
	if e != nil {
		return e
	}
	defer store.Close()
	transport, e := pc.NewHTTP(*origin, os.Getenv(*tokenEnv))
	if e != nil {
		return e
	}
	client, e := pc.NewClient(transport, store, identity, *allow)
	if e != nil {
		return e
	}
	defer client.Pause()
	if _, e = client.Hello(); e != nil {
		return e
	}
	reconciled := []any{}
	out, _ := store.Data["outbox"].(map[string]any)
	for key, v := range out {
		record := v.(map[string]any)
		state := record["outcome"]
		if state == "unknown" || state == "accepted" || state == "scheduled" {
			item, e := client.Reconcile(key, false)
			if e != nil {
				return e
			}
			reconciled = append(reconciled, pc.Object{"key": key, "result": item["status"]})
		}
	}
	if store.Data["cursor"] != nil {
		for {
			page, e := client.Events()
			if e != nil {
				var remote *pc.RemoteError
				if errors.As(e, &remote) && remote.Body["code"] == "RESYNC_REQUIRED" {
					break
				}
				return e
			}
			if page["hasMore"] != true {
				break
			}
		}
	}
	if store.Data["snapshot"] == nil || store.Data["dirty"] == true {
		if _, e = client.Snapshot(); e != nil {
			return e
		}
	}
	result := pc.Object{"mode": "paused", "scope": client.Scope(), "cursor": store.Data["cursor"], "reconciled": reconciled}
	if *commandPath != "" {
		command, e := load(*commandPath)
		if e != nil {
			return e
		}
		kind, ok := command["kind"].(string)
		payload, ok2 := command["payload"].(map[string]any)
		if !ok || !ok2 || len(command) != 2 {
			return errors.New("invalid command file")
		}
		if _, e = client.Control("acquire", 30000); e != nil {
			return e
		}
		key, e := client.Prepare(kind, payload)
		if e != nil {
			return e
		}
		receipt, e := client.Submit(key)
		if e != nil {
			item, e := client.Reconcile(key, false)
			if e != nil {
				return e
			}
			result["recovery"] = item
		} else {
			result["receipt"] = receipt
		}
		if client.Writable() {
			if _, e = client.Control("release", 30000); e != nil {
				return e
			}
		}
	}
	raw, e := pc.Canonical(result)
	if e != nil {
		return e
	}
	fmt.Println(string(raw))
	return nil
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "Client stopped:", e)
		os.Exit(1)
	}
}
