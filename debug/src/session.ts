// The DAP session: translates VS Code's debug protocol requests into GdbDriver/MI commands and
// GdbDriver events into DAP events. Deliberately honest about what a debugger for raw, DWARF-less
// assembly can offer:
//   - One stack frame (current PC mapped to source via listingMap), not a real unwound call
//     stack — there's no frame-pointer/CFI info to unwind with in general.
//   - "Registers" instead of "variables" — there's no type info, so raw register/memory
//     inspection (via gdb's own expression evaluator, e.g. "$eax" or "*(dword*)$esp") is the
//     asm-appropriate equivalent, and what the Watch/evaluate views expose.
//   - Step (next/stepIn/stepOut are all the same operation) means "single-step machine
//     instructions until the PC reaches a different source-mapped line", since there's no call
//     graph to distinguish stepping over vs. into vs. out of.
import { DebugSession, Handles, InitializedEvent, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import { readElfEntryPoint } from './elfEntry';
import { GdbDriver } from './gdbDriver';
import { AddressLineMap, buildAddressLineMap } from './listingMap';

const MAIN_THREAD_ID = 1;
const MAIN_FRAME_ID = 1;
const MAX_STEP_INSTRUCTIONS = 200_000;

const REGISTER_NAMES = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'rip', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'eflags'];

/**
 * Every x86-64 general-purpose register name/sub-register alias gdb exposes as a `$`-prefixed
 * convenience register, mapped to its bit width — covers whatever mnemonic a hover in real
 * assembly source might land on (not just the curated set the Registers scope displays).
 * `eip` is deliberately excluded: unlike `$rip`, this gdb/target combo evaluates it to "void"
 * rather than a usable value, so it's left to fall through to the generic evaluator below.
 */
const REGISTER_WIDTH_BITS: Record<string, 8 | 16 | 32 | 64> = {
  rax: 64, rbx: 64, rcx: 64, rdx: 64, rsi: 64, rdi: 64, rbp: 64, rsp: 64, rip: 64,
  r8: 64, r9: 64, r10: 64, r11: 64, r12: 64, r13: 64, r14: 64, r15: 64,
  eax: 32, ebx: 32, ecx: 32, edx: 32, esi: 32, edi: 32, ebp: 32, esp: 32, eflags: 32,
  r8d: 32, r9d: 32, r10d: 32, r11d: 32, r12d: 32, r13d: 32, r14d: 32, r15d: 32,
  ax: 16, bx: 16, cx: 16, dx: 16, si: 16, di: 16, bp: 16, sp: 16,
  r8w: 16, r9w: 16, r10w: 16, r11w: 16, r12w: 16, r13w: 16, r14w: 16, r15w: 16,
  al: 8, bl: 8, cl: 8, dl: 8, ah: 8, bh: 8, ch: 8, dh: 8, sil: 8, dil: 8, bpl: 8, spl: 8,
  r8b: 8, r9b: 8, r10b: 8, r11b: 8, r12b: 8, r13b: 8, r14b: 8, r15b: 8,
};

const UNSIGNED_CAST_TYPE: Record<8 | 16 | 32 | 64, string> = {
  8: 'unsigned char',
  16: 'unsigned short',
  32: 'unsigned int',
  64: 'unsigned long',
};

/** Renders one bit pattern in every base at once — hex and binary always agree with the decimal
 * value because all three come from the same parsed bigint, not three separate gdb round-trips
 * that could each format the same register differently (gdb defaults to *signed* decimal for
 * plain registers, e.g. -1 for 0xffffffff, which reads as a bug more than a feature here). */
function formatRegisterValue(name: string, bits: 8 | 16 | 32 | 64, value: bigint): string {
  const hex = value.toString(16).padStart(bits / 4, '0');
  const bin = value
    .toString(2)
    .padStart(bits, '0')
    .replace(/(.{4})(?=.)/g, '$1_');
  return `${name} = 0x${hex}  ${value.toString()}  0b${bin}`;
}

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  /** Path to the assembled, executable binary. */
  program: string;
  /** Path to the original .asm entry source file (for listing correlation). */
  asmFile: string;
  /** Path to the .lst listing produced alongside `program` (see the extension's debug build task). */
  listingFile: string;
  gdbPath?: string;
  cwd?: string;
  stopOnEntry?: boolean;
}

export class FasmDebugSession extends DebugSession {
  private gdb: GdbDriver | undefined;
  private addressMap: AddressLineMap | undefined;
  private readonly variableHandles = new Handles<string>();

  public constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    // VS Code stops this adapter process by signal (SIGTERM) as a normal part of ending a debug
    // session, not just via the disconnect/terminate DAP requests — without this, that path would
    // skip GdbDriver.dispose() and leave the gdb (and its debuggee) child process orphaned. This
    // can't cover a hard SIGKILL (unrecoverable by any process, by OS design), but it makes the
    // ordinary shutdown path clean rather than leaky.
    const shutdown = () => {
      void this.gdb?.dispose().finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse, _args: DebugProtocol.InitializeRequestArguments): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsSingleThreadExecutionRequests = false;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
    try {
      this.addressMap = buildAddressLineMap(args.listingFile, args.asmFile);

      this.gdb = new GdbDriver();
      this.gdb.on('console', (text) => this.sendEvent(new OutputEvent(text, 'console')));
      this.gdb.on('target-output', (text) => this.sendEvent(new OutputEvent(text, 'stdout')));
      this.gdb.on('stopped', (data) => this.onStopped(data));
      this.gdb.on('exit', () => this.sendEvent(new TerminatedEvent()));
      this.gdb.on('error', (err) => this.sendEvent(new OutputEvent(`gdb error: ${err.message}\n`, 'stderr')));

      this.gdb.start({
        gdbPath: args.gdbPath || 'gdb',
        programPath: path.resolve(args.program),
        cwd: args.cwd ?? path.dirname(args.program),
      });

      if (args.stopOnEntry) {
        // gdb's own `start` command needs a symbol table to resolve "main", which these binaries
        // don't have — read the entry point straight out of the ELF header instead (stable,
        // well-known layout, no symbols required). The "lowest address in the listing" isn't a
        // safe stand-in: format-directive lines (e.g. the ELF header bytes themselves) can sit at
        // address 0, which isn't a valid breakpoint location and made gdb reject the launch.
        const entryAddress = readElfEntryPoint(path.resolve(args.program));
        if (entryAddress !== undefined) {
          await this.gdb.sendCommand(`-break-insert -t *0x${entryAddress.toString(16)}`);
        } else {
          this.sendEvent(new OutputEvent('Could not determine the entry point (not a recognized ELF file) — stopOnEntry is disabled for this run.\n', 'stderr'));
        }
      }

      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1, `Failed to launch debug session: ${(err as Error).message}`);
    }
  }

  private onStopped(data: Record<string, unknown>): void {
    const reasonRaw = typeof data.reason === 'string' ? data.reason : '';
    if (reasonRaw === 'exited-normally' || reasonRaw.startsWith('exited')) {
      this.sendEvent(new TerminatedEvent());
      return;
    }

    const reason = reasonRaw === 'breakpoint-hit' ? 'breakpoint' : reasonRaw === 'signal-received' ? 'exception' : reasonRaw === 'end-stepping-range' ? 'step' : 'pause';
    this.sendEvent(new StoppedEvent(reason, MAIN_THREAD_ID));
  }

  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
    this.sendResponse(response);
    try {
      await this.gdb?.sendCommand('-exec-run');
    } catch (err) {
      this.sendEvent(new OutputEvent(`failed to start program: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    const sourcePath = args.source.path ? path.resolve(args.source.path) : undefined;
    const breakpoints: DebugProtocol.Breakpoint[] = [];

    if (!sourcePath || !this.addressMap || !this.gdb) {
      response.body = { breakpoints: (args.breakpoints ?? []).map((bp) => ({ verified: false, line: bp.line })) };
      this.sendResponse(response);
      return;
    }

    // gdb has no notion of "the breakpoints for this file" as a set — clear whatever we
    // previously placed on this file and re-add the client's current full set, matching DAP's
    // "setBreakpoints gives the complete desired set for this source" contract.
    await this.clearBreakpointsForFile(sourcePath);

    for (const bp of args.breakpoints ?? []) {
      const address = this.addressMap.locationToAddress.get(`${sourcePath}:${bp.line}`);
      if (address === undefined) {
        breakpoints.push({ verified: false, line: bp.line, message: 'No instruction maps to this line' });
        continue;
      }
      try {
        const result = await this.gdb.sendCommand(`-break-insert *0x${address.toString(16)}`);
        const bkpt = (result.data as Record<string, unknown> | undefined)?.bkpt as Record<string, unknown> | undefined;
        const number = bkpt?.number !== undefined ? String(bkpt.number) : undefined;
        if (number) this.rememberBreakpoint(sourcePath, number);
        breakpoints.push({ verified: true, line: bp.line });
      } catch (err) {
        breakpoints.push({ verified: false, line: bp.line, message: (err as Error).message });
      }
    }

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  private readonly breakpointsByFile = new Map<string, Set<string>>();

  private rememberBreakpoint(sourcePath: string, gdbNumber: string): void {
    let set = this.breakpointsByFile.get(sourcePath);
    if (!set) {
      set = new Set();
      this.breakpointsByFile.set(sourcePath, set);
    }
    set.add(gdbNumber);
  }

  private async clearBreakpointsForFile(sourcePath: string): Promise<void> {
    const set = this.breakpointsByFile.get(sourcePath);
    if (!set || set.size === 0 || !this.gdb) return;
    try {
      await this.gdb.sendCommand(`-break-delete ${[...set].join(' ')}`);
    } catch {
      // breakpoints may already be gone (e.g. process exited) — nothing to clean up either way
    }
    set.clear();
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(MAIN_THREAD_ID, 'main')] };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
    const loc = await this.currentLocation();
    const frame = loc
      ? new StackFrame(MAIN_FRAME_ID, path.basename(loc.fsPath), new Source(path.basename(loc.fsPath), loc.fsPath), loc.line)
      : new StackFrame(MAIN_FRAME_ID, '<unmapped address>');
    response.body = { stackFrames: [frame], totalFrames: 1 };
    this.sendResponse(response);
  }

  private async currentLocation(): Promise<{ fsPath: string; line: number } | undefined> {
    if (!this.gdb || !this.addressMap) return undefined;
    try {
      const pc = await this.evaluateToBigInt('$pc');
      if (pc === undefined) return undefined;
      return this.addressMap.addressToLocation.get(pc);
    } catch {
      return undefined;
    }
  }

  private async evaluateToBigInt(expr: string): Promise<bigint | undefined> {
    if (!this.gdb) return undefined;
    const result = await this.gdb.sendCommand(`-data-evaluate-expression ${expr}`);
    const value = (result.data as Record<string, unknown> | undefined)?.value;
    if (typeof value !== 'string') return undefined;
    const hexMatch = /0x[0-9a-fA-F]+/.exec(value);
    if (!hexMatch) return undefined;
    try {
      return BigInt(hexMatch[0]);
    } catch {
      return undefined;
    }
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse): void {
    const handle = this.variableHandles.create('registers');
    response.body = { scopes: [new Scope('Registers', handle, false)] };
    this.sendResponse(response);
  }

  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
    const kind = this.variableHandles.get(args.variablesReference);
    if (kind !== 'registers' || !this.gdb) {
      response.body = { variables: [] };
      this.sendResponse(response);
      return;
    }

    const variables: Variable[] = [];
    for (const name of REGISTER_NAMES) {
      const formatted = await this.formatRegister(name, REGISTER_WIDTH_BITS[name]);
      variables.push(new Variable(name, formatted ?? '<unavailable>'));
    }
    response.body = { variables };
    this.sendResponse(response);
  }

  /**
   * Evaluates register `name` (already known to be `bits` wide) and formats it as hex/decimal/
   * binary. Casts to the appropriately-sized `unsigned` type first — gdb's raw evaluation of a
   * plain register is *signed* decimal by default (confusing for a bit pattern: 0xffffffff reads
   * as -1) and, for `eflags` specifically, isn't numeric at all (`$eflags` alone evaluates to a
   * decoded flag-name string like "[ IF ]", not a value `-data-evaluate-expression` can parse as
   * a number). The cast sidesteps both: it's always plain unsigned decimal, one format regardless
   * of register. For `eflags`, that decoded string is still genuinely useful, so it's appended.
   */
  private async formatRegister(name: string, bits: 8 | 16 | 32 | 64 | undefined): Promise<string | undefined> {
    if (!this.gdb || bits === undefined) return undefined;
    try {
      const castType = UNSIGNED_CAST_TYPE[bits];
      const result = await this.gdb.sendCommand(`-data-evaluate-expression "(${castType})$${name}"`);
      const raw = (result.data as Record<string, unknown> | undefined)?.value;
      if (typeof raw !== 'string') return undefined;
      const match = /^\d+/.exec(raw);
      if (!match) return undefined;

      let text = formatRegisterValue(name, bits, BigInt(match[0]));
      if (name === 'eflags') {
        try {
          const flagsResult = await this.gdb.sendCommand('-data-evaluate-expression $eflags');
          const flagsValue = (flagsResult.data as Record<string, unknown> | undefined)?.value;
          if (typeof flagsValue === 'string') text += `  ${flagsValue}`;
        } catch {
          // cosmetic addition only — the numeric formatting above already stands on its own
        }
      }
      return text;
    } catch {
      return undefined;
    }
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
    this.sendResponse(response);
    try {
      await this.gdb?.sendCommand('-exec-continue');
    } catch (err) {
      this.sendEvent(new OutputEvent(`continue failed: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
    this.sendResponse(response);
    try {
      await this.gdb?.sendCommand('-exec-interrupt');
    } catch {
      // process may have already stopped or exited between the request and this call
    }
  }

  /** next/stepIn/stepOut all resolve to the same operation — see the module doc comment. */
  private async stepToNextLine(response: DebugProtocol.Response): Promise<void> {
    this.sendResponse(response);
    if (!this.gdb || !this.addressMap) return;

    const startLoc = await this.currentLocation();

    for (let i = 0; i < MAX_STEP_INSTRUCTIONS; i++) {
      let result;
      try {
        result = await this.gdb.sendCommand('-exec-step-instruction');
      } catch (err) {
        this.sendEvent(new OutputEvent(`step failed: ${(err as Error).message}\n`, 'stderr'));
        return;
      }
      if (result.klass !== 'running') return; // program likely exited or errored; a stop/exit event will follow separately

      const stoppedOnce = await this.waitForNextStop();
      if (!stoppedOnce) return; // process exited or errored mid-step

      const loc = await this.currentLocation();
      if (!loc) continue; // landed on an unmapped address (e.g. inside padding/data) — keep stepping
      if (!startLoc || loc.fsPath !== startLoc.fsPath || loc.line !== startLoc.line) {
        this.sendEvent(new StoppedEvent('step', MAIN_THREAD_ID));
        return;
      }
    }
    // Safety net: never got to a new mapped line (e.g. an unmapped infinite region) — still
    // report *something* rather than leaving the UI hung waiting for a stopped event forever.
    this.sendEvent(new StoppedEvent('step', MAIN_THREAD_ID));
  }

  private waitForNextStop(): Promise<boolean> {
    if (!this.gdb) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onStop = () => {
        this.gdb?.off('exit', onExit);
        resolve(true);
      };
      const onExit = () => {
        this.gdb?.off('stopped', onStop);
        resolve(false);
      };
      this.gdb!.once('stopped', onStop);
      this.gdb!.once('exit', onExit);
    });
  }

  protected nextRequest(response: DebugProtocol.NextResponse): void {
    void this.stepToNextLine(response);
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse): void {
    void this.stepToNextLine(response);
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
    void this.stepToNextLine(response);
  }

  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    if (!this.gdb) {
      this.sendErrorResponse(response, 2, 'Debug session is not running');
      return;
    }

    // A bare register name (hovering over "eax" in the source, or typing it into Watch/Debug
    // Console) gets the same hex/decimal/binary formatting as the Registers scope, instead of
    // whatever plain (often signed, or for eflags non-numeric) string gdb would print by default.
    // Anything else — a compound expression like "*(dword*)$esp" — is passed straight through.
    const registerName = args.expression.trim().replace(/^\$/, '').toLowerCase();
    const bits = REGISTER_WIDTH_BITS[registerName];
    if (bits !== undefined) {
      const formatted = await this.formatRegister(registerName, bits);
      if (formatted !== undefined) {
        response.body = { result: formatted, variablesReference: 0 };
        this.sendResponse(response);
        return;
      }
    }

    try {
      // Quoted: MI's argument parser splits on whitespace, so an unquoted expression containing
      // one (e.g. "$eax + 1", or any real C-like expression beyond a single token) would be seen
      // as several arguments instead of one and rejected with a "Usage: ..." error.
      const quoted = args.expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const result = await this.gdb.sendCommand(`-data-evaluate-expression "${quoted}"`);
      const value = (result.data as Record<string, unknown> | undefined)?.value;
      response.body = { result: typeof value === 'string' ? value : '<no value>', variablesReference: 0 };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 3, (err as Error).message);
    }
  }

  protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
    await this.gdb?.dispose();
    this.sendResponse(response);
  }

  protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    await this.gdb?.dispose();
    this.sendResponse(response);
  }
}
