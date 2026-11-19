import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

/**
 * A document in the room's authoritative SQLite connection. Implementations
 * serialize each change, join outer transactions using savepoints, and commit
 * visible events in the same transaction. They must not cache payloads.
 */
export interface DurableDomainDocument {
  read(): string | null;
  /** Insert only if absent; return the authoritative payload even after a race. */
  initialize(payload: string, sourceDigest: string | null): string;
  transact<T>(change: (current: string) => { payload: string; result: T }): T;
}

export class DomainValidationError extends Error {}
export function domainValidation<T>(validate:()=>T):T{try{return validate();}catch(error){throw new DomainValidationError(error instanceof Error?error.message:'Invalid domain mutation');}}

export interface DomainChange<State, Result> {
  state: State;
  result: Result;
}

/**
 * Legacy file mode is retained for local callers. After binding, SQLite is the
 * sole authority: no cached state is published, including inside outer
 * transactions that may subsequently roll back, and no legacy file is written.
 * The owner serializes asynchronous file operations and binding.
 */
export class DomainDocument<State> {
  private durable: DurableDomainDocument | undefined;
  constructor(
    private file: string | undefined,
    private state: State,
    private decode: (payload: string) => State,
    private encode: (state: State) => string,
    private mode?: number,
  ) {}
  current(): State {
    if (!this.durable) return this.state;
    const payload = this.durable.read();
    if (payload === null) throw Error("Durable domain document is missing");
    return this.decode(payload);
  }
  async load() {
    if (this.durable) {
      this.current();
      return;
    }
    const source = await this.legacy();
    if (source !== null) this.state = this.decode(source.toString("utf8"));
  }
  async bindDurable(document: DurableDomainDocument) {
    if (this.durable) {
      if (this.durable !== document)
        throw Error("Domain document already bound");
      this.current();
      return;
    }
    // Consult SQL before touching the legacy path, even when that path is now
    // unreadable or corrupt. A leftover file must never resurrect old state.
    let payload = document.read();
    if (payload === null) {
      const source = await this.legacy();
      const state =
        source === null ? this.state : this.decode(source.toString("utf8"));
      const encoded = this.encode(state);
      this.decode(encoded);
      payload = document.initialize(
        encoded,
        source === null
          ? null
          : createHash("sha256").update(source).digest("hex"),
      );
    }
    this.decode(payload);
    // Binding and legacy in-memory state are unchanged on every failure above.
    this.durable = document;
  }
  private async legacy(): Promise<Buffer | null> {
    if (!this.file) return null;
    try {
      return await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async mutate<Result>(
    change: (state: State) => DomainChange<State, Result>,
  ): Promise<Result> {
    if (this.durable) return this.mutateSync(change);
    const next = change(this.state),
      payload = this.encode(next.state);
    this.decode(payload);
    if (this.file) {
      await writeFile(
        this.file + ".tmp",
        payload,
        this.mode === undefined ? undefined : { mode: this.mode },
      );
      await rename(this.file + ".tmp", this.file);
    }
    this.state = next.state;
    return next.result;
  }
  /** Only durable mode can safely participate in a synchronous room transaction. */
  mutateSync<Result>(
    change: (state: State) => DomainChange<State, Result>,
  ): Result {
    if (!this.durable)
      throw Error("Synchronous mutation requires a durable domain document");
    return this.durable.transact((payload) => {
      const current=this.decode(payload),next = domainValidation(()=>change(current)),
        encoded = domainValidation(()=>this.encode(next.state));
      this.decode(encoded);
      return { payload: encoded, result: next.result };
    });
  }
}
