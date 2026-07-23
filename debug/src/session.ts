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
import { ContinuedEvent, DebugSession, Handles, InitializedEvent, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as path from 'path';
import { readElfEntryPoint } from './elfEntry';
import { GdbDriver } from './gdbDriver';
import { AddressLineMap, buildCandidateSequence, correlateListing, parseListingFile } from './listingMap';
import {
  decodeEflags,
  formatRegisterValue,
  parseUserNumber,
  REGISTER_WIDTH_BITS,
  RegisterBits,
  RegisterGroups,
  resolveRegisterGroups,
  unsignedCastType,
} from './registers';
import { buildConstantMap, buildSymbolAddressMap, ConstantSymbol, DebugSymbol, formatConstantCompact, formatConstantDetailed } from './symbols';
import {
  decodeLittleEndianElements,
  formatStringPreview,
  MAX_ARRAY_PREVIEW_ELEMENTS,
  MAX_STRING_PREVIEW_BYTES,
  parseHexBytes,
  sizeName,
} from './valueFormat';

const MAIN_THREAD_ID = 1;
const MAIN_FRAME_ID = 1;
const MAX_STEP_INSTRUCTIONS = 200_000;
/** A raw console command (e.g. a typed "continue" or "run") doesn't return control to gdb's
 * command reader until the target stops again, unlike this adapter's own -exec-* commands, which
 * return immediately and report the eventual stop as a separate async event — see
 * runConsoleCommand's own doc comment. DEFAULT_COMMAND_TIMEOUT_MS (gdbDriver.ts, 10s) would fire
 * on any long-running program, so this path gets a much longer budget instead. */
const CONSOLE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Safety cap on the Data Labels scope's own top-level list — mirrors listingMap.ts's
 * MAX_LOOKAHEAD reasoning: bounds a pathological case (a program with thousands of data labels)
 * without affecting any realistic program. */
const MAX_DATA_LABELS_SHOWN = 300;

const EMPTY_REGISTER_GROUPS: RegisterGroups = { generalPurpose: [], pointers: [], segment: [], eflagsName: undefined };

/** Byte widths a single gdb-cast memory read can resolve to a plain scalar (matches
 * REGISTER_WIDTH_BITS' own domain) — a source label declared with a wider size (e.g. `dqword`,
 * `dt`) still resolves to an address, just not a single-number value (see formatSymbolValueDetailed). */
const READABLE_VALUE_BITS: Record<number, RegisterBits> = { 1: 8, 2: 16, 4: 32, 8: 64 };

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
  /** Which of the target's own registers (gdb-reported, so architecture-correct — see
   * registers.ts) fall into each display group. Populated once in launchRequest; empty until then,
   * which just means the Registers scope shows nothing yet rather than throwing. */
  private registerGroups: RegisterGroups = EMPTY_REGISTER_GROUPS;
  /** Source label name -> runtime address (+ size, when knowable), built from the listing file —
   * see symbols.ts for why this exists at all (fasmg emits no symbol table for gdb to consult). */
  private symbolMap: Map<string, DebugSymbol> = new Map();
  /** Symbolic constant name (e.g. "FD_STDERR" from "FD_STDERR = 2") -> its defined value — these
   * have no runtime address at all, so gdb can't answer "what's the value of FD_STDERR" either
   * (fails with "No symbol table is loaded"); resolved statically instead, same as symbolMap. */
  private constantMap: Map<string, ConstantSymbol> = new Map();

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
    response.body.supportsSetVariable = true;
    response.body.supportsSetExpression = true;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
    try {
      const listingEntries = parseListingFile(fs.readFileSync(args.listingFile, 'utf8'));
      const candidates = buildCandidateSequence(path.resolve(args.asmFile));
      this.addressMap = correlateListing(listingEntries, candidates);
      this.symbolMap = buildSymbolAddressMap(listingEntries);
      this.constantMap = buildConstantMap(listingEntries);

      this.gdb = new GdbDriver();
      this.gdb.on('console', (text) => this.sendEvent(new OutputEvent(text, 'console')));
      this.gdb.on('target-output', (text) => this.sendEvent(new OutputEvent(text, 'stdout')));
      this.gdb.on('stopped', (data) => this.onStopped(data));
      this.gdb.on('exit', () => this.sendEvent(new TerminatedEvent()));
      this.gdb.on('error', (err) => this.sendEvent(new OutputEvent(`gdb error: ${err.message}\n`, 'stderr')));

      // macOS ships no gdb at all (and Apple's lldb doesn't speak the MI protocol this adapter
      // uses) — the MI-capable debugger there is lldb-mi, so that's the default worth probing for
      // on darwin instead of a gdb that can't exist. See buildLaunchArgs for the invocation
      // differences between the two.
      this.gdb.start({
        gdbPath: args.gdbPath || (process.platform === 'darwin' ? 'lldb-mi' : 'gdb'),
        programPath: path.resolve(args.program),
        cwd: args.cwd ?? path.dirname(args.program),
      });

      // gdb already knows the *actual* register set of the loaded target the moment it's loaded
      // (i386 gets eax/ebx/.../eflags/cs/ss/..., x86-64 gets rax/rbx/.../r15/rip/...) — asking
      // once here and grouping whatever comes back (registers.ts) is what makes the Registers
      // view correct for both 32-bit and 64-bit programs, instead of a hardcoded 64-bit guess that
      // reads as "<unavailable>" across the board on a 32-bit target.
      //
      // Deliberately NOT awaited here: this used to block the 'launch' response on one extra gdb
      // round-trip, which — real regression, found via a client (VS Code) integration test that
      // drives 'continue' itself right after the first 'stopped' event — delayed 'launch' just
      // enough that the debuggee (running independently of when our own DAP response goes out)
      // could hit a stopOnEntry breakpoint and emit 'stopped' *before* the client had finished
      // processing 'launch' and was ready to react to it, silently dropping that first stop. The
      // Registers scope is only ever read after a stop, by which point this has long since
      // resolved in the background — nothing actually needs to wait for it here.
      void this.gdb.sendCommand('-data-list-register-names').then(
        (namesResult) => {
          const rawNames = (namesResult.data as Record<string, unknown> | undefined)?.['register-names'];
          if (Array.isArray(rawNames)) this.registerGroups = resolveRegisterGroups(rawNames as string[]);
        },
        () => {
          // Leave registerGroups empty — the Registers scope will just show nothing rather than
          // fail the whole launch over a view that's secondary to actually running the program.
        },
      );

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
    const registersHandle = this.variableHandles.create('registers');
    // "expensive: true" on Data Labels — unlike the fixed ~20-register Registers scope, this list
    // is one gdb round-trip *per data label* (see variablesRequest's 'labels' branch), so a
    // program with many of them shouldn't pay that cost on every single stop; VS Code only fetches
    // an expensive scope once the user actually expands it.
    const labelsHandle = this.variableHandles.create('labels');
    response.body = {
      scopes: [new Scope('Registers', registersHandle, false), new Scope('Data Labels', labelsHandle, true)],
    };
    this.sendResponse(response);
  }

  /**
   * The Registers scope is organized into four expandable groups (General Purpose / Pointers /
   * Flags / Segment) instead of one flat list — both so it reads clearly (a raw 20+-register list
   * is a wall of text) and so it's honest about which registers actually exist on *this* target:
   * a group with no members for the connected architecture (e.g. no r8-r15 group members on a
   * 32-bit target) just doesn't appear, rather than showing a row of "<unavailable>".
   */
  /**
   * @vscode/debugadapter's dispatchRequest calls this method without awaiting it (its own
   * try/catch only guards a *synchronous* throw before the first await, not a later rejection) —
   * so any error surfacing after that point would otherwise become an unhandled promise
   * rejection instead of a DAP error response, which on a real VS Code host observably wedges the
   * whole debug session (no further requests ever get a response) rather than just failing this
   * one variables fetch. This thin wrapper is the fix: real work stays in variablesRequestUnsafe,
   * this only guarantees *some* response always goes back.
   */
  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
    try {
      await this.variablesRequestUnsafe(response, args);
    } catch (err) {
      this.sendEvent(new OutputEvent(`variables request failed: ${(err as Error).message}\n`, 'stderr'));
      response.body = { variables: [] };
      this.sendResponse(response);
    }
  }

  private async variablesRequestUnsafe(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
    const kind = this.variableHandles.get(args.variablesReference);
    if (!kind || !this.gdb) {
      response.body = { variables: [] };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers') {
      const variables: Variable[] = [];
      if (this.registerGroups.generalPurpose.length > 0) variables.push(this.registerGroupVariable('General Purpose', 'registers:gp'));
      if (this.registerGroups.pointers.length > 0) variables.push(this.registerGroupVariable('Pointers', 'registers:pointers'));
      if (this.registerGroups.eflagsName) {
        const summary = await this.formatRegister(this.registerGroups.eflagsName, REGISTER_WIDTH_BITS[this.registerGroups.eflagsName]);
        const v = this.registerGroupVariable('Flags', 'registers:flags');
        v.value = summary ?? '<unavailable>';
        variables.push(v);
      }
      if (this.registerGroups.segment.length > 0) variables.push(this.registerGroupVariable('Segment', 'registers:segment'));
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:gp' || kind === 'registers:pointers' || kind === 'registers:segment') {
      const names =
        kind === 'registers:gp' ? this.registerGroups.generalPurpose : kind === 'registers:pointers' ? this.registerGroups.pointers : this.registerGroups.segment;
      const variables: DebugProtocol.Variable[] = [];
      for (const name of names) {
        const formatted = await this.formatRegister(name, REGISTER_WIDTH_BITS[name]);
        const v: DebugProtocol.Variable = new Variable(name, formatted ?? '<unavailable>');
        v.evaluateName = name;
        variables.push(v);
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:flags') {
      const eflagsName = this.registerGroups.eflagsName;
      const bits = eflagsName ? REGISTER_WIDTH_BITS[eflagsName] : undefined;
      const raw = eflagsName ? await this.readRegisterBigInt(eflagsName, bits) : undefined;
      const variables: DebugProtocol.Variable[] = [];
      if (raw !== undefined) {
        for (const flag of decodeEflags(raw)) {
          const v: DebugProtocol.Variable = new Variable(flag.name, String(flag.value));
          v.type = flag.description;
          v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
          variables.push(v);
        }
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    // The Data Labels scope itself: one row per resolved *data* symbol (a plain code label like
    // "start:" is deliberately excluded — this panel is specifically about inspectable values, and
    // hover/Watch already cover code labels perfectly well). An array shows a compact preview here
    // and expands into per-index children (the "labels:<name>" branch below) on request.
    if (kind === 'labels') {
      const dataSymbols = [...this.symbolMap.values()].filter((s) => s.elementSizeBytes !== undefined).slice(0, MAX_DATA_LABELS_SHOWN);
      // These are independent gdb round-trips (one -data-evaluate-expression/-data-read-memory-
      // bytes per label) — gdb's MI protocol correlates concurrent commands by their own token
      // (verified in gdbDriver.test.ts's "correlates concurrent commands to their own results"),
      // so firing them all at once instead of awaiting one at a time is a real, grounded speedup
      // for a program with more than a handful of data labels.
      const variables = await Promise.all(
        dataSymbols.map(async (sym) => {
          const value = await this.formatSymbolValueCompact(sym);
          const isExpandableArray = (sym.elementCount ?? 1) > 1 && sym.stringLengthBytes === undefined;
          const v: DebugProtocol.Variable = isExpandableArray
            ? new Variable(sym.name, value, this.variableHandles.create(`labels:${sym.name}`))
            : new Variable(sym.name, value);
          v.evaluateName = sym.name;
          return v;
        }),
      );
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind.startsWith('labels:')) {
      const sym = this.symbolMap.get(kind.slice('labels:'.length));
      const variables: DebugProtocol.Variable[] = [];
      if (sym?.elementSizeBytes !== undefined && sym.elementCount !== undefined) {
        const shown = Math.min(sym.elementCount, MAX_ARRAY_PREVIEW_ELEMENTS);
        const bytes = await this.readMemoryBytes(`0x${sym.address.toString(16)}`, shown * sym.elementSizeBytes);
        const bits = READABLE_VALUE_BITS[sym.elementSizeBytes];
        if (bytes && bits !== undefined) {
          decodeLittleEndianElements(bytes, sym.elementSizeBytes, shown).forEach((value, i) => {
            variables.push(new Variable(`[${i}]`, formatRegisterValue('value', bits, value)));
          });
        }
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    response.body = { variables: [] };
    this.sendResponse(response);
  }

  private registerGroupVariable(label: string, handleKey: string): Variable {
    return new Variable(label, '', this.variableHandles.create(handleKey));
  }

  /** Reads register `name` (already known to be `bits` wide) as a plain unsigned bigint — casts to
   * the appropriately-sized `unsigned` type first, since gdb's raw evaluation of a plain register
   * is *signed* decimal by default (confusing for a bit pattern: 0xffffffff reads as -1) and, for
   * `eflags` specifically, isn't numeric at all (`$eflags` alone evaluates to a decoded flag-name
   * string like "[ IF ]", not a value `-data-evaluate-expression` can parse as a number). */
  private async readRegisterBigInt(name: string, bits: RegisterBits | undefined): Promise<bigint | undefined> {
    if (!this.gdb || bits === undefined) return undefined;
    try {
      const castType = unsignedCastType(bits);
      const result = await this.gdb.sendCommand(`-data-evaluate-expression "(${castType})$${name}"`);
      const raw = (result.data as Record<string, unknown> | undefined)?.value;
      if (typeof raw !== 'string') return undefined;
      const match = /^\d+/.exec(raw);
      if (!match) return undefined;
      return BigInt(match[0]);
    } catch {
      return undefined;
    }
  }

  /** Formats register `name` as hex/decimal/binary (see readRegisterBigInt for how the value
   * itself is obtained). For `eflags`, gdb's own decoded flag-name string (e.g. "[ IF ]") is
   * appended too — the Flags group's own children (see variablesRequest) break it down bit by bit,
   * but this one-line summary is what shows next to the group header itself. */
  private async formatRegister(name: string, bits: RegisterBits | undefined): Promise<string | undefined> {
    const value = await this.readRegisterBigInt(name, bits);
    if (value === undefined || bits === undefined || !this.gdb) return undefined;

    let text = formatRegisterValue(name, bits, value);
    if (name === this.registerGroups.eflagsName) {
      try {
        const flagsResult = await this.gdb.sendCommand(`-data-evaluate-expression $${name}`);
        const flagsValue = (flagsResult.data as Record<string, unknown> | undefined)?.value;
        if (typeof flagsValue === 'string') text += `  ${flagsValue}`;
      } catch {
        // cosmetic addition only — the numeric formatting above already stands on its own
      }
    }
    return text;
  }

  /** Reads `count` raw bytes starting at `addressHex` via gdb's own "-data-read-memory-bytes" —
   * used for array elements and string previews, where a single scalar cast-read (readScalarAt)
   * isn't enough. Returns undefined on any failure (bad address, gdb error, process not running)
   * rather than throwing, so callers can fall back to an address-only display. */
  private async readMemoryBytes(addressHex: string, count: number): Promise<number[] | undefined> {
    if (!this.gdb || count <= 0) return undefined;
    try {
      const result = await this.gdb.sendCommand(`-data-read-memory-bytes ${addressHex} ${count}`);
      const memory = (result.data as Record<string, unknown> | undefined)?.memory;
      const first = Array.isArray(memory) ? (memory[0] as Record<string, unknown> | undefined) : undefined;
      const contents = first?.contents;
      return typeof contents === 'string' ? parseHexBytes(contents) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Reads a single scalar of `bits` width at `addressHex`, the same unsigned-cast trick
   * readRegisterBigInt uses for registers — shared by both formatSymbolValue* variants below. */
  private async readScalarAt(addressHex: string, bits: RegisterBits): Promise<bigint | undefined> {
    if (!this.gdb) return undefined;
    try {
      const castType = unsignedCastType(bits);
      const result = await this.gdb.sendCommand(`-data-evaluate-expression "*(${castType}*)${addressHex}"`);
      const raw = (result.data as Record<string, unknown> | undefined)?.value;
      const match = typeof raw === 'string' ? /^\d+/.exec(raw) : null;
      return match ? BigInt(match[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Formats a resolved source label (see symbols.ts) for hover — the one context with room for a
   * multi-line, fully-explained answer. Always shows the address, since that's unambiguous and
   * useful even for a plain code label; only *also* shows a value when the label's own definition
   * line made its shape unambiguous — a string preview for a "db 'text',0"-style buffer, every
   * element for an array, or a plain scalar for anything else with a size gdb can cast-read in one
   * shot (1/2/4/8 bytes). A wider declared size (e.g. `dqword`) still gets the address, just
   * honestly not a single-number value, rather than guessing at how to interpret it.
   */
  private async formatSymbolValueDetailed(sym: DebugSymbol): Promise<string> {
    const addressHex = `0x${sym.address.toString(16)}`;
    const header = `${sym.name}  (label, address ${addressHex})`;
    if (sym.elementSizeBytes === undefined) return header;

    if (sym.stringLengthBytes !== undefined) {
      const shown = Math.min(sym.stringLengthBytes, MAX_STRING_PREVIEW_BYTES);
      const bytes = await this.readMemoryBytes(addressHex, shown);
      if (!bytes) return `${header}\ncould not read memory at this address`;
      const { text, nullTerminated } = formatStringPreview(bytes);
      const truncated = sym.stringLengthBytes > MAX_STRING_PREVIEW_BYTES;
      return `${header}\nstring[${sym.stringLengthBytes}] = "${text}"${nullTerminated ? '  (null-terminated)' : ''}${truncated ? '  (truncated)' : ''}`;
    }

    if ((sym.elementCount ?? 1) > 1) {
      const shown = Math.min(sym.elementCount!, MAX_ARRAY_PREVIEW_ELEMENTS);
      const bytes = await this.readMemoryBytes(addressHex, shown * sym.elementSizeBytes);
      if (!bytes) return `${header}\ncould not read memory at this address`;
      const values = decodeLittleEndianElements(bytes, sym.elementSizeBytes, shown);
      const truncated = sym.elementCount! > MAX_ARRAY_PREVIEW_ELEMENTS;
      return `${header}\n${sym.elementCount} × ${sizeName(sym.elementSizeBytes)}: [${values.map((v) => `0x${v.toString(16)}`).join(', ')}${truncated ? ', ...' : ''}]`;
    }

    const bits = READABLE_VALUE_BITS[sym.elementSizeBytes];
    if (bits === undefined) {
      return `${header}\n${sizeName(sym.elementSizeBytes)} value — too wide to read as a single number here; try Watch with an explicit cast, e.g. "*(qword*)${addressHex}"`;
    }
    const value = await this.readScalarAt(addressHex, bits);
    if (value === undefined) return `${header}\ncould not read a value at this address`;
    return `${header}\n${formatRegisterValue('value', bits, value)}`;
  }

  /**
   * Formats a resolved source label as one short line — used everywhere a multi-line block would
   * look broken: Watch/REPL/Variables-view evaluate results, inline-value decorations in the
   * editor (see extension/src/inlineValues.ts), and the Data Labels scope's own row value.
   */
  private async formatSymbolValueCompact(sym: DebugSymbol): Promise<string> {
    const addressHex = `0x${sym.address.toString(16)}`;
    if (sym.elementSizeBytes === undefined) return `(code label) ${addressHex}`;

    if (sym.stringLengthBytes !== undefined) {
      const shown = Math.min(sym.stringLengthBytes, MAX_STRING_PREVIEW_BYTES);
      const bytes = await this.readMemoryBytes(addressHex, shown);
      if (!bytes) return `(string, ${sym.stringLengthBytes} bytes) ${addressHex}`;
      const { text } = formatStringPreview(bytes);
      return `"${text}${sym.stringLengthBytes > MAX_STRING_PREVIEW_BYTES ? '...' : ''}"`;
    }

    if ((sym.elementCount ?? 1) > 1) {
      const shown = Math.min(sym.elementCount!, MAX_ARRAY_PREVIEW_ELEMENTS);
      const bytes = await this.readMemoryBytes(addressHex, shown * sym.elementSizeBytes);
      if (!bytes) return `(${sym.elementCount} × ${sizeName(sym.elementSizeBytes)}) ${addressHex}`;
      const values = decodeLittleEndianElements(bytes, sym.elementSizeBytes, shown);
      const truncated = sym.elementCount! > MAX_ARRAY_PREVIEW_ELEMENTS;
      return `[${values.map((v) => v.toString()).join(', ')}${truncated ? ', ...' : ''}]`;
    }

    const bits = READABLE_VALUE_BITS[sym.elementSizeBytes];
    if (bits === undefined) return `(${sizeName(sym.elementSizeBytes)}) ${addressHex}`;
    const value = await this.readScalarAt(addressHex, bits);
    if (value === undefined) return `(could not read) ${addressHex}`;
    return `0x${value.toString(16).padStart(bits / 4, '0')}  ${value.toString()}`;
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

  /** See variablesRequest's own doc comment: dispatchRequest doesn't await this method, so any
   * throw after the first "await" would otherwise become an unhandled rejection instead of a
   * proper DAP error response — a real bug found and fixed in variablesRequest, guarded against
   * here the same way even though every callee below already has its own internal try/catch. */
  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    try {
      await this.evaluateRequestUnsafe(response, args);
    } catch (err) {
      this.sendErrorResponse(response, 3, (err as Error).message);
    }
  }

  private async evaluateRequestUnsafe(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    if (!this.gdb) {
      this.sendErrorResponse(response, 2, 'Debug session is not running');
      return;
    }

    // A bare register name (hovering over "eax" in the source, or typing it into Watch/Debug
    // Console) gets the same hex/decimal/binary formatting as the Registers scope, instead of
    // whatever plain (often signed, or for eflags non-numeric) string gdb would print by default.
    const trimmed = args.expression.trim();
    if (trimmed.length === 0) {
      // An empty Watch entry, or Enter pressed on a blank Debug Console line — forwarding this to
      // gdb as-is would come back as its own raw "Argument required (expression to compute)",
      // which reads as a crash to someone who just hit Enter on nothing.
      response.body = { result: '', variablesReference: 0 };
      this.sendResponse(response);
      return;
    }
    const registerName = trimmed.replace(/^\$/, '').toLowerCase();
    const bits = REGISTER_WIDTH_BITS[registerName];
    if (bits !== undefined) {
      const formatted = await this.formatRegister(registerName, bits);
      if (formatted !== undefined) {
        response.body = { result: formatted, variablesReference: 0 };
        this.sendResponse(response);
        return;
      }
    }

    // A bare source label (hovering over "argc" in "mov [argc], ecx", or typing it into Watch) —
    // gdb has no symbol table for these (fasmg emits none), so it would otherwise just fail with
    // "No symbol in current context". Resolved from the listing file instead (see symbols.ts).
    // "hover" is the only DAP context with room for a multi-line explanation (a tooltip); every
    // other context (watch/repl/variables/clipboard, and whatever unlisted string VS Code sends
    // for an inline-value decoration — see extension/src/inlineValues.ts) gets the compact form.
    const symbol = this.symbolMap.get(trimmed);
    if (symbol) {
      const text = args.context === 'hover' ? await this.formatSymbolValueDetailed(symbol) : await this.formatSymbolValueCompact(symbol);
      response.body = { result: text, variablesReference: 0 };
      this.sendResponse(response);
      return;
    }

    // A bare symbolic constant (e.g. "FD_STDERR" from "FD_STDERR = 2") — these have no runtime
    // address at all (fasmg substitutes them at compile time), so gdb can't resolve them either;
    // it would fail the same way as an unknown label ("No symbol table is loaded"). Resolved
    // entirely from the listing instead — see symbols.ts — so this never reaches gdb at all.
    const constant = this.constantMap.get(trimmed);
    if (constant) {
      const text = args.context === 'hover' ? formatConstantDetailed(constant) : formatConstantCompact(constant);
      response.body = { result: text, variablesReference: 0 };
      this.sendResponse(response);
      return;
    }

    // Anything else in the Debug Console (context 'repl') is treated as a raw gdb/lldb-mi CLI
    // command rather than a value expression — "info registers", "x/10i $pc", "bt", or even
    // "continue"/"next" typed directly. Hover/Watch/clipboard never take this path: those need an
    // actual value back, not console text, so they keep going straight to gdb's expression
    // evaluator below.
    if (args.context === 'repl') {
      try {
        await this.runConsoleCommand(trimmed);
        response.body = { result: '', variablesReference: 0 };
        this.sendResponse(response);
      } catch (err) {
        this.sendErrorResponse(response, 3, (err as Error).message);
      }
      return;
    }

    // A compound expression like "*(dword*)$esp" — passed straight through to gdb's evaluator.
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

  /**
   * Runs a raw gdb/lldb-mi CLI command typed straight into the Debug Console. The console text it
   * prints comes back through the driver's own 'console' stream (already wired to OutputEvent in
   * launchRequest), so this method itself doesn't need to return anything.
   *
   * ContinuedEvent: VS Code only infers "the target resumed" on its own when *it* asked for that
   * (clicking Continue/Next); a raw "continue" typed here arrives as an 'evaluate' request, so
   * without this the Variables/Call Stack views would stay frozen on stale data until the next
   * stop. The listener is scoped to exactly this command's own round-trip (attached right before
   * sending, removed right after), so it never fires during the existing step implementation's own
   * internal -exec-step-instruction loop (stepToNextLine) — that loop never calls this method.
   */
  private async runConsoleCommand(command: string): Promise<void> {
    if (!this.gdb) return;
    const onRunning = () => this.sendEvent(new ContinuedEvent(MAIN_THREAD_ID));
    this.gdb.once('running', onRunning);
    try {
      const quoted = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await this.gdb.sendCommand(`-interpreter-exec console "${quoted}"`, CONSOLE_COMMAND_TIMEOUT_MS);
    } finally {
      this.gdb.off('running', onRunning);
    }
  }

  /** Edits a register's value from the Registers panel (VS Code's in-place variable editor). Only
   * the three groups holding actual whole registers are editable — "registers" (the group headers
   * themselves) and "registers:flags" (individual decoded bits, marked readOnly in variablesRequest
   * for the same reason: gdb has no way to set a single EFLAGS bit in isolation) are rejected. */
  protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
    const kind = this.variableHandles.get(args.variablesReference);
    if (kind !== 'registers:gp' && kind !== 'registers:pointers' && kind !== 'registers:segment') {
      this.sendErrorResponse(response, 8, 'Only registers can be set');
      return;
    }
    const formatted = await this.setRegister(args.name.toLowerCase(), args.value, response);
    if (formatted === undefined) return; // an error response was already sent
    response.body = { value: formatted };
    this.sendResponse(response);
  }

  /** Edits a register's value from a Watch expression (typing e.g. "eax" into Watch, then
   * editing its value in place — DAP's setVariable only covers the Variables/Registers tree). */
  protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): Promise<void> {
    const registerName = args.expression.trim().replace(/^\$/, '').toLowerCase();
    const formatted = await this.setRegister(registerName, args.value, response);
    if (formatted === undefined) return; // an error response was already sent
    response.body = { value: formatted, variablesReference: 0 };
    this.sendResponse(response);
  }

  /**
   * Shared by setVariable/setExpression: validates `name` is a register we know the width of,
   * parses `rawValue` (decimal/hex/binary/asm-style "h" suffix — see parseUserNumber), assigns it
   * in gdb via the same "$reg = value" expression-evaluator trick used to *read* registers
   * elsewhere in this file, and returns the freshly re-read, freshly formatted value — the caller
   * still has to attach it to `response.body` and call `sendResponse` itself. On failure, sends an
   * error response itself and returns undefined, so the caller knows to stop.
   */
  private async setRegister(name: string, rawValue: string, response: DebugProtocol.Response): Promise<string | undefined> {
    if (!this.gdb) {
      this.sendErrorResponse(response, 2, 'Debug session is not running');
      return undefined;
    }
    const bits = REGISTER_WIDTH_BITS[name];
    if (bits === undefined) {
      this.sendErrorResponse(response, 5, `"${name}" is not a register this debugger knows how to set`);
      return undefined;
    }
    const parsed = parseUserNumber(rawValue, bits);
    if (parsed === undefined) {
      this.sendErrorResponse(response, 6, `Could not parse "${rawValue}" as a number (try decimal, 0x.., 0b.., or an asm-style ..h hex literal)`);
      return undefined;
    }

    try {
      await this.gdb.sendCommand(`-data-evaluate-expression "$${name} = ${parsed.toString()}"`);
    } catch (err) {
      this.sendErrorResponse(response, 7, (err as Error).message);
      return undefined;
    }

    const formatted = await this.formatRegister(name, bits);
    return formatted ?? parsed.toString();
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
