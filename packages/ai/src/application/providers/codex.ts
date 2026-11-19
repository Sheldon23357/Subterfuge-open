import {providerCallTimeout} from '../../controller/contracts/provider-timeout.js';
export {providerCallTimeout} from '../../controller/contracts/provider-timeout.js';
import {parseModelJson,EMPTY_MODEL_SCHEMA} from '../../controller/contracts/model-json.js';
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createHash} from 'node:crypto';
import {codexInput} from './codex-input.js';
import {codexGenerationSchema,restoreCodexOptionals} from './codex-schema.js';
import {codexIsolationArguments} from './codex-config.js';
import {CodexSessionPool} from './codex-session.js';
import {ProviderError,classifyProviderFailure} from '../../controller/contracts/provider-error.js';
import {ProviderEvidence} from '../../controller/contracts/provider-evidence.js';
import type {ProviderDiagnostic} from '../../controller/contracts/provider-error.js';
import {errorDiagnostic} from '../../../../contracts/src/index.js';
import type {
  AgentProvider,
  AgentRequest,
  ModelResult,
} from "../../controller/contracts/types.js";

export function codexArguments(directory: string, model: string,effort:'low'|'medium'|'high'='low',serviceTier=process.env.AI_CODEX_SERVICE_TIER,input?:{schemaPath:string;instructions:string}) {
  if(serviceTier!==undefined&&serviceTier!=='fast'&&serviceTier!=='default')throw Error('AI_CODEX_SERVICE_TIER must be default or fast when set');
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--cd",
    directory,
    "--output-schema",
    input?.schemaPath??join(directory, "response-schema.json"),
  ];
  args.push(...codexIsolationArguments(effort,serviceTier));
  if(input?.instructions)args.push('-c','developer_instructions='+JSON.stringify(input.instructions));
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}
export function parseCodexOutput(output: string,commanderMode?:AgentRequest['commanderMode'],responseSchema?:Record<string,unknown>): ModelResult {
  let usageDetails:ModelResult['usage'];
  let threadId:string|undefined;
  let last: string | undefined,
    tokens: number | undefined,
    failed = false;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if(event.type==='thread.started'&&typeof event.thread_id==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(event.thread_id))threadId=event.thread_id;
    if (event.type === "error" || event.type === "turn.failed") failed = true;
    if (event.type === "item.completed") {
      if (event.item?.type === "agent_message") last = event.item.text;
      else if (
        [
          "command_execution",
          "mcp_tool_call",
          "web_search",
          "file_change",
        ].includes(event.item?.type)
      )
        throw Error("Unexpected native agent tool");
    }
    if (event.type === "turn.completed") {
      const usage = event.usage;
      if (
        !usage ||
        !Number.isSafeInteger(usage.input_tokens) ||
        usage.input_tokens < 0 ||
        !Number.isSafeInteger(usage.output_tokens) ||
        usage.output_tokens < 0
      )
        throw Error("Missing Codex usage");
      tokens = usage.input_tokens + usage.output_tokens;
      usageDetails={inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,
        ...(Number.isSafeInteger(usage.cached_input_tokens)&&usage.cached_input_tokens>=0&&usage.cached_input_tokens<=usage.input_tokens?{cachedInputTokens:usage.cached_input_tokens}:{})};
    }
  }
  if (failed || last === undefined || tokens === undefined)
    throw Error("Codex turn incomplete");
  const sourceSchema=responseSchema??EMPTY_MODEL_SCHEMA;
  const parsed=parseModelJson(last);
  const restored=restoreCodexOptionals(parsed,sourceSchema);
  const reply=restored as Record<string,unknown>;
  return {reply,tokens,providerContext:{kind:'codex',sessionMode:'ephemeral',...(threadId?{threadId}:{})},...(usageDetails?{usage:usageDetails,usageKnown:{provenance:'reported' as const,input:true,output:true,cached:usageDetails.cachedInputTokens!==undefined}}:{})};
}

/** Codex produces protocol messages only; the host owns all real game side effects. */
export class CodexProvider implements AgentProvider {
  private sessions:CodexSessionPool|undefined;
  constructor(
    private executable = "codex",
    private timeoutMs?: number,
  ) {}
  async step(request: AgentRequest): Promise<ModelResult> {
    if(request.providerSessionKey){
      const native=await (this.sessions??=new CodexSessionPool(this.executable,this.timeoutMs)).run(request);
      try{const result=parseCodexOutput(native.output,request.commanderMode,request.responseSchema);result.providerContext=native.context;return result;}
      catch{throw new ProviderError('invalid-response',undefined,{stage:'parse-response',outcome:'completed',reason:'Protocol validation failed'});}
    }
    const timeoutMs=this.timeoutMs??providerCallTimeout(request.effort,request.timeoutMs);
    if (request.signal.aborted) throw new ProviderError('cancelled');
    const startedAt=Date.now();
    const evidence=new ProviderEvidence(startedAt);
    const processEvidence:NonNullable<ProviderDiagnostic['process']>={};
    // This empty workspace is shared; prompts and per-call schemas never live
    // inside it. A random cwd would change Codex's environment message each time.
    const workspace=join(tmpdir(),'subterfuge-codex-v1','workspace');
    const input=codexInput(request.prompt);
    const sourceSchema=request.responseSchema??EMPTY_MODEL_SCHEMA;
    const schema=JSON.stringify(codexGenerationSchema(sourceSchema));
    let directory:string;
    try{await mkdir(workspace,{recursive:true});directory=await mkdtemp(join(tmpdir(), "subterfuge-codex-"));}
    catch(error){throw new ProviderError('unavailable',undefined,{stage:'prepare-workspace',outcome:'not-sent',cause:errorDiagnostic(error),evidence:evidence.summary()});}
    try {
      try{await writeFile(
        join(directory, "response-schema.json"),
        schema,
        "utf8",
      );}catch(error){throw new ProviderError('unavailable',undefined,{stage:'prepare-schema',outcome:'not-sent',cause:errorDiagnostic(error),evidence:evidence.summary()});}
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          this.executable,
          codexArguments(workspace, request.model,request.effort,request.serviceTier,{schemaPath:join(directory,'response-schema.json'),instructions:input.instructions}),
          {
            cwd: workspace,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
          },
        );
        if(child.pid!==undefined)processEvidence.pid=child.pid;
        child.once('spawn',()=>{processEvidence.spawnMs=Date.now()-startedAt;});
        child.once('exit',()=>{processEvidence.exitMs=Date.now()-startedAt;});
        let stdout = "",
          diagnostics = '',
          size = 0,
          failure: string | null = null;
        const stop = (reason: string) => {
          if (failure) return;
          failure = reason;
          processEvidence.stopRequestedMs=Date.now()-startedAt;
          processEvidence.stopReason=reason==='Codex rate limited'?'rate-limit':reason==='Codex timed out'?'provider-timeout':reason==='Codex output limit'?'output-limit':request.signal.reason?.name==='TimeoutError'?'round-deadline':'cancelled';
          if (process.platform === "win32" && child.pid) {
            const killer = spawn(
              "taskkill",
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore" },
            );
            killer.on("error", error => {processEvidence.killError=errorDiagnostic(error);child.kill();});
          } else child.kill("SIGKILL");
        };
        const timeoutDueAt=Date.now()+timeoutMs;
        const timer = setTimeout(() => {processEvidence.timeoutLagMs=Math.max(0,Date.now()-timeoutDueAt);stop("Codex timed out");}, timeoutMs);
        // A host round deadline is a timeout, but not this provider's own timer.
        const abort = () => stop('AI stopped');
        request.signal.addEventListener("abort", abort, { once: true });
        const cleanup = () => {
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          evidence.chunk('stdout',chunk);
          size += Buffer.byteLength(chunk);
          if (size > 2_000_000) stop("Codex output limit");
          else stdout += chunk;
        });
        // Never persist stderr: provider diagnostics may contain account or local-path information.
        child.stderr.setEncoding('utf8');
        child.stderr.on("data", (chunk:string) => {
          evidence.chunk('stderr',chunk);diagnostics=(diagnostics+chunk).slice(-12000);
          // CLI retries can otherwise sit silently until our inference timeout.
          // Only an explicit Responses endpoint HTTP 429 triggers shared backoff;
          // metadata refresh warnings alone must not cancel a valid model turn.
          if(diagnostics.split(/\r?\n/).some(line=>/responses/i.test(line)&&/\b429\b/.test(line)))stop('Codex rate limited');
        });
        child.on("error", (error) => {
          cleanup();
          reject(
            new ProviderError('unavailable',undefined,{stage:'spawn',outcome:'not-sent',durationMs:Date.now()-startedAt,cause:errorDiagnostic(error),evidence:evidence.summary(),process:{...processEvidence}}),
          );
        });
        child.on("close", (code,signal) => {
          cleanup();
          processEvidence.closeMs=Date.now()-startedAt;
          if (failure || code !== 0){
            const classified=failure==='Codex rate limited'?new ProviderError('transient',undefined,{stage:'provider-output',reason:'rate-limit'}):failure==='AI stopped'?(processEvidence.stopReason==='round-deadline'?new ProviderError('timeout','round-deadline'):new ProviderError('cancelled')):failure==='Codex timed out'?new ProviderError('timeout','provider-call'):failure==='Codex output limit'?new ProviderError('invalid-response'):classifyProviderFailure(diagnostics+'\n'+stdout);
            reject(new ProviderError(classified.code,classified.timeoutSource,{stage:'process-exit',outcome:'unknown',reason:failure==='Codex rate limited'?'rate-limit':failure??classified.diagnostic?.reason??`classified-${classified.code}`,...(failure==='Codex rate limited'?{httpStatus:429}:{}),exitCode:code,exitSignal:signal,durationMs:Date.now()-startedAt,outputBytes:size,timeoutMs,evidence:evidence.summary(),process:{...processEvidence}}));
          }else resolve(stdout);
        });
        child.stdin.on("error", error => {processEvidence.stdinError=errorDiagnostic(error);});
        child.stdin.end(input.input);
        if (request.signal.aborted) abort();
      });
      try{
        const result=parseCodexOutput(output,request.commanderMode,request.responseSchema);
        result.providerContext={...result.providerContext!,schemaProjection:'openai-strict/2',instructionsSha256:createHash('sha256').update(input.instructions).digest('hex'),schemaSha256:createHash('sha256').update(schema).digest('hex')};
        return result;
      }catch(error){
        const classified=classifyProviderFailure(output);
        const knownReasons=new Set(['Unexpected native agent tool','Missing Codex usage','Codex turn incomplete','Invalid Codex reply']);
        const reason=error instanceof Error&&knownReasons.has(error.message)?error.message:error instanceof SyntaxError?'Invalid JSON':'Protocol validation failed';
        throw new ProviderError(reason==='Unexpected native agent tool'?'native-tool':classified.code==='unknown'?'invalid-response':classified.code,undefined,{stage:'parse-response',outcome:'completed',reason,durationMs:Date.now()-startedAt,outputBytes:Buffer.byteLength(output),evidence:evidence.summary(),process:{...processEvidence}});
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
