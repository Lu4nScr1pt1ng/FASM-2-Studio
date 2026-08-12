// The DAP session: translates VS Code's debug protocol requests into GdbDriver/MI commands and
// GdbDriver events into DAP events. Deliberately honest about what a debugger for raw, DWARF-less
// assembly can offer:
//   - One stack frame (current PC mapped to source via listingMap), not a real unwound call
//     stack — there's no frame-pointer/CFI info to unwind with in general.
//   - "Registers" instead of "variables" — there's no type info, so raw register/memory
//     inspection (via gdb's own expression evaluator, e.g. "$eax" or "*(dword*)$esp") is the
//     asm-appropriate equivalent, and what the Watch/evaluate views expose.
//   - Step (statement granularity) single-steps machine instructions until the PC reaches a
//     different source-mapped line, since there's no line table to consult for "the next
//     statement" the way a real compiled-language debugger would. Step Over and Step Into *do*
//     differ from each other despite that: Over uses -exec-next-instruction (steps over a call,
//     landing right after it returns — this is what makes stepping over a macro invocation whose
//     body ends in a real `call`, like a helper macro that calls a print routine, behave like a
//     single step instead of diving into the callee) while Into uses -exec-step-instruction
//     (dives into the call on purpose). Both are ISA-level distinctions gdb already knows how to
//     make without any symbol table — nothing here is specific to any particular macro.
//   - Instruction-granularity stepping and the `disassemble` request back VS Code's Disassembly
//     View, for actually watching a macro's expansion execute one raw instruction at a time
//     instead of having the whole thing (and the source line it collapses to) step silently past
//     in one statement-granularity Step.
import { ContinuedEvent, DebugSession, Handles, InitializedEvent, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import { readElfEntryPoint } from './elfEntry';
import { GdbDriver } from './gdbDriver';
import { ConsoleKind, handshakeFilePath, holderCommand, isTerminalConsole, releaseTerminal, runInTerminalKind, waitForTty } from './inferiorTerminal';
import { AddressLineMap, buildAddressLineMap, nextMappedLineAtOrAfter } from './listingMap';
import { miData } from './miParser';
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
import directivesData from '@fasm2-studio/server/src/data/directives.json';
import formatKeywordsData from '@fasm2-studio/server/src/data/formatKeywords.json';
import instructionsData from '@fasm2-studio/server/src/data/instructions.json';
import sizeSpecifiersData from '@fasm2-studio/server/src/data/sizeSpecifiers.json';
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
/** The architectural maximum length of a single x86-64 instruction encoding — used to size a
 * disassembly byte-window generously enough to always contain however many whole instructions
 * were asked for (see disassembleAround). */
const MAX_X86_INSTRUCTION_BYTES = 15;
/** Hard ceiling on a single disassembly window, regardless of how large a request's own
 * instructionCount/instructionOffset are — mirrors listingMap.ts's MAX_LOOKAHEAD reasoning: a
 * pathological or malicious request just gets padded with placeholder rows past this point,
 * rather than asking gdb to disassemble an unbounded byte range. Far larger than any real VS Code
 * Disassembly View page (typically a few hundred instructions). */
const MAX_DISASSEMBLE_WINDOW_BYTES = 2_000_000;
/** How long to wait for the client to open a terminal for the debugged program. Generous, because
 * it covers a user-visible action on the client's side (opening a panel, spawning a shell) rather
 * than a message round trip — but bounded, since a client that never answers must not hang the
 * launch forever. */
const RUN_IN_TERMINAL_TIMEOUT_MS = 15_000;

/** The underlying MI command for one machine-instruction step: "-exec-next-instruction" (gdb's
 * `nexti`) runs straight over a `call` instead of diving into it, landing right after it returns —
 * Step Over uses this. "-exec-step-instruction" (`stepi`) dives into a `call` on purpose — Step
 * Into/Step Out both use this (there's no unwound call stack here for a real "run until this frame
 * returns", so Step Out falls back to the same single-instruction-into behavior as Step Into, same
 * as before this distinction existed). Both are ISA-level gdb primitives that already know how to
 * recognize a `call` without any symbol table — nothing macro-specific. */
type StepMiCommand = '-exec-step-instruction' | '-exec-next-instruction';

/** Matches a single bare word — a macro invocation, an instruction mnemonic, or any other stray
 * FASM-source identifier — but not a compound expression ("$eax + 1"), a bracketed/cast expression
 * ("*(dword*)$esp"), or a "$"-prefixed gdb convenience variable ("$pc"). See evaluateRequestUnsafe's
 * own doc comment on why only this shape is safe to short-circuit before ever asking gdb. */
const BARE_IDENTIFIER_RE = /^[A-Za-z_.][A-Za-z0-9_.]*$/;
/** DAP evaluate contexts where the user explicitly asked about *this* token — see
 * evaluateRequestUnsafe's own doc comment for why inline-value decorations are deliberately not
 * included here. */
const EXPLICIT_ASK_CONTEXTS: ReadonlySet<string> = new Set(['hover', 'watch', 'clipboard', 'variables']);
/** Every mnemonic/directive/format-keyword/size-specifier the language server itself knows —
 * these already have a real hover from its own hover provider (confirmed by the real "offers
 * hover documentation for a known mnemonic" server test), which VS Code shows *alongside* this
 * debug adapter's own hover response for the same token. Short-circuiting these with "no runtime
 * value" the same way an unresolved macro name gets doesn't just add noise: a *successful* debug
 * hover response actually gets shown, unlike a failed one (which VS Code silently drops, letting
 * the language hover stand on its own) — so returning anything at all here would step on a hover
 * that was already working fine. Same data source as extension/src/inlineValues.ts's own
 * NEVER_A_VALUE, kept as a separate copy since debug and extension are independent packages. */
const KNOWN_LANGUAGE_TOKENS: ReadonlySet<string> = new Set([
  ...(instructionsData as Array<{ mnemonic: string }>).map((i) => i.mnemonic.toLowerCase()),
  ...(directivesData as Array<{ name: string }>).flatMap((d) => d.name.toLowerCase().split(' ')),
  ...(formatKeywordsData as Array<{ name: string }>).map((k) => k.name.toLowerCase()),
  ...(sizeSpecifiersData as Array<{ name: string }>).map((s) => s.name.toLowerCase()),
]);

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
  /** Command-line arguments for the debugged program itself (not for gdb). */
  args?: string[];
  /** Extra environment variables for the debugged program. Merged over the adapter's own
   * environment, which gdb passes down to the inferior it starts. */
  env?: Record<string, string>;
  /** Where the debugged program's own stdin/stdout live — the Debug Console (default, output only)
   * or a real terminal, which is the only one of the two that can be typed into. See
   * inferiorTerminal.ts. */
  console?: ConsoleKind;
}

export class FasmDebugSession extends DebugSession {
  private gdb: GdbDriver | undefined;
  private addressMap: AddressLineMap | undefined;
  /** Every source-mapped address from addressMap, ascending — lets disassembleAround binary-search
   * for "the nearest known-good instruction boundary at or before X" in O(log n) instead of
   * scanning the whole map on every Disassembly View scroll/page request. */
  private sortedAddresses: bigint[] = [];
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
  /** True from the moment stepToNextLine/stepOneInstruction sends its exec command until it's
   * done awaiting the resulting stop. waitForNextStop's `once('stopped', ...)` has no way to tell
   * *which* in-flight exec command a given stop actually belongs to (MI's *stopped async records
   * carry no token correlating them to the command that caused them) — a second overlapping
   * next/stepIn/stepOut arriving before the first has finished stepping would register a second
   * such listener and could have its own loop's stop consumed by the first step's still-running
   * loop (or vice versa), desyncing "did we land on a new line" from the command that actually
   * produced the stop. Continue/Pause are deliberately not gated by this: neither of them calls
   * waitForNextStop itself (Pause in particular must always be free to interrupt an in-flight step).
   */
  private stepping = false;

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
      // Same reason the gdb child is disposed here: this path skips disconnect/terminate entirely,
      // and the terminal holder would keep an otherwise finished terminal waiting.
      releaseTerminal(this.terminalHandshakeFile);
      void this.gdb?.dispose().finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  /** Whether the client can open a terminal for us on request — a "console" launch attribute
   * asking for one is only answerable if it can. */
  private clientSupportsRunInTerminal = false;
  /** The file this session's terminal holder is waiting on; deleting it releases the terminal. */
  private terminalHandshakeFile: string | undefined;
  /** In-flight terminal handshake, started during launch and awaited before the program runs. */
  private terminalSetup: Promise<void> | undefined;

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    this.clientSupportsRunInTerminal = args.supportsRunInTerminalRequest === true;
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsSingleThreadExecutionRequests = false;
    response.body.supportsSetVariable = true;
    response.body.supportsSetExpression = true;
    response.body.supportsSteppingGranularity = true;
    response.body.supportsDisassembleRequest = true;
    // Every capability below is gated on the client *seeing it declared here* — VS Code hides the
    // corresponding UI entirely otherwise. So an unstated capability is not a graceful degradation,
    // it is a feature that silently does not exist: no "Add Conditional Breakpoint" menu item, no
    // "View Binary Data", no watchpoints, no breakpoints in the disassembly view you are looking at.
    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsLogPoints = true;
    response.body.supportsFunctionBreakpoints = true;
    response.body.supportsInstructionBreakpoints = true;
    response.body.supportsDataBreakpoints = true;
    response.body.supportsReadMemoryRequest = true;
    response.body.supportsWriteMemoryRequest = true;
    response.body.supportsGotoTargetsRequest = true;
    response.body.supportsRestartRequest = true;
    response.body.supportsExceptionInfoRequest = true;
    response.body.supportsTerminateRequest = true;
    // Lets VS Code ask which lines can actually hold a breakpoint before offering one, and is what
    // makes the inline "add breakpoint" affordances in the gutter land on real instructions.
    response.body.supportsBreakpointLocationsRequest = true;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
    try {
      const { entries: listingEntries, ...addressMap } = buildAddressLineMap(args.listingFile, path.resolve(args.asmFile));
      this.addressMap = addressMap;
      this.sortedAddresses = [...this.addressMap.addressToLocation.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
        // gdb's own --args form takes the program's arguments directly, and the inferior inherits
        // gdb's environment — so both reach the debugged program without any extra MI commands.
        programArgs: args.args ?? [],
        env: args.env,
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
          const rawNames = miData(namesResult)?.['register-names'];
          if (Array.isArray(rawNames)) this.registerGroups = resolveRegisterGroups(rawNames as string[]);
        },
        () => {
          // Leave registerGroups empty — the Registers scope will just show nothing rather than
          // fail the whole launch over a view that's secondary to actually running the program.
        },
      );

      // FASM is Intel-syntax throughout; gdb's own disassembler defaults to AT&T on Linux, which
      // would read as a different, unfamiliar language in the Disassembly View. lldb-mi has no
      // equivalent MI-reachable setting, so this is best-effort and silently ignored there — worth
      // doing for the common gdb case, not worth failing the whole launch over on the experimental
      // macOS path.
      void this.gdb.sendCommand('-gdb-set disassembly-flavor intel').catch(() => {});

      // Started here but deliberately *not* awaited here — configurationDone waits for it instead,
      // which is the last moment before the program actually starts and therefore the last moment
      // the tty has to be settled by. Awaiting it inside launchRequest instead delays the launch
      // response by however long the client takes to open a terminal (seconds, since it is a real
      // UI action), and a launch response that lands after the first 'stopped' event is one VS Code
      // silently drops — the same regression the register-name lookup above is written to avoid,
      // caught here by the extension's own real-VS-Code debug tests.
      if (isTerminalConsole(args.console)) {
        const cwd = args.cwd ?? path.dirname(args.program);
        this.terminalSetup = this.attachInferiorTerminal(args.console!, cwd).catch((err: Error) => {
          // Nothing in the session may be left waiting on this promise: a rejection here means the
          // program keeps its output in the Debug Console, not that it fails to run.
          this.sendEvent(new OutputEvent(`could not attach a terminal (${err.message}) — the program keeps its output here.\n`, 'stderr'));
        });
      }

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

  /**
   * Gives the debugged program a terminal of its own, so it can be typed into as well as read.
   *
   * Every failure here degrades to the Debug Console rather than failing the launch, and says why:
   * the program still runs, it just cannot be interacted with — and the one thing worse than that
   * is a program that silently ignores what you asked for.
   */
  private async attachInferiorTerminal(kind: ConsoleKind, cwd: string): Promise<void> {
    if (!this.gdb) return;

    // Windows has no pty for gdb to be pointed at, and -inferior-tty-set is a no-op there. gdb's
    // own answer is a separate console window for the inferior, which is at least a real console
    // with a real stdin. Untested — the debugger side of this extension is verified on Linux — so
    // it is best-effort and says what it did.
    if (process.platform === 'win32') {
      try {
        await this.gdb.sendCommand('-gdb-set new-console on');
        this.sendEvent(new OutputEvent('The program gets its own console window: Windows has no pty to hand to gdb.\n', 'console'));
      } catch (err) {
        this.sendEvent(new OutputEvent(`could not give the program its own console (${(err as Error).message}) — its output stays here.\n`, 'stderr'));
      }
      return;
    }

    if (!this.clientSupportsRunInTerminal) {
      this.sendEvent(
        new OutputEvent('This client cannot open a terminal on request, so the program keeps its output here and has no stdin.\n', 'stderr'),
      );
      return;
    }

    const handshakeFile = handshakeFilePath();
    const opened = await new Promise<DebugProtocol.RunInTerminalResponse | undefined>((resolve) => {
      this.runInTerminalRequest(
        { kind: runInTerminalKind(kind), title: 'FASM program', cwd, args: holderCommand(handshakeFile) },
        RUN_IN_TERMINAL_TIMEOUT_MS,
        (response) => resolve(response),
      );
    });

    if (!opened?.success) {
      releaseTerminal(handshakeFile);
      this.sendEvent(new OutputEvent(`The client did not open a terminal (${opened?.message ?? 'no response'}) — the program keeps its output here.\n`, 'stderr'));
      return;
    }

    const tty = await waitForTty(handshakeFile);
    if (!tty) {
      releaseTerminal(handshakeFile);
      this.sendEvent(new OutputEvent('The terminal opened but never reported a tty — the program keeps its output here.\n', 'stderr'));
      return;
    }

    try {
      await this.gdb.sendCommand(`-inferior-tty-set ${tty}`);
      this.terminalHandshakeFile = handshakeFile;
    } catch (err) {
      releaseTerminal(handshakeFile);
      this.sendEvent(new OutputEvent(`gdb refused the terminal (${(err as Error).message}) — the program keeps its output here.\n`, 'stderr'));
    }
  }

  /**
   * The signal that stopped the program, kept for exceptionInfoRequest. Assembly programs fault
   * far more often than they hit a planned breakpoint — a bad address, a misaligned stack, a wrong
   * register width — so "which signal, and what does it mean" is the single most valuable thing
   * this adapter can say at a stop, and it used to discard it entirely.
   */
  private lastSignal: { name: string; meaning: string } | undefined;

  private onStopped(data: Record<string, unknown>): void {
    const reasonRaw = typeof data.reason === 'string' ? data.reason : '';
    if (reasonRaw === 'exited-normally' || reasonRaw.startsWith('exited')) {
      this.sendEvent(new TerminatedEvent());
      return;
    }

    // A logpoint is a breakpoint whose whole purpose is to *not* stop: report and resume.
    if (reasonRaw === 'breakpoint-hit' && this.handleLogPoint(data)) return;

    // A watchpoint trigger reports as "data breakpoint" so VS Code names what actually stopped the
    // program, rather than falling through to the generic "pause" every unrecognized reason got.
    const isWatchpoint = reasonRaw.endsWith('watchpoint-trigger') || reasonRaw === 'watchpoint-scope';
    const reason = isWatchpoint
      ? 'data breakpoint'
      : reasonRaw === 'breakpoint-hit'
        ? 'breakpoint'
        : reasonRaw === 'signal-received'
          ? 'exception'
          : reasonRaw === 'end-stepping-range'
            ? 'step'
            : 'pause';

    if (reasonRaw === 'signal-received') {
      const name = typeof data['signal-name'] === 'string' ? (data['signal-name'] as string) : 'signal';
      const meaning = typeof data['signal-meaning'] === 'string' ? (data['signal-meaning'] as string) : '';
      this.lastSignal = { name, meaning };
      const stopped = new StoppedEvent(reason, MAIN_THREAD_ID);
      // `description` is what VS Code shows in the call-stack header, `text` in the notification —
      // without them a SIGSEGV reads only as the word "exception".
      (stopped.body as DebugProtocol.StoppedEvent['body']).description = meaning ? `${name} (${meaning})` : name;
      (stopped.body as DebugProtocol.StoppedEvent['body']).text = meaning ? `${name}: ${meaning}` : name;
      this.sendEvent(stopped);
      return;
    }

    this.lastSignal = undefined;
    this.sendEvent(new StoppedEvent(reason, MAIN_THREAD_ID));
  }

  protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse): void {
    const signal = this.lastSignal;
    response.body = {
      exceptionId: signal?.name ?? 'signal',
      description: signal ? `${signal.name}${signal.meaning ? `: ${signal.meaning}` : ''}` : 'The program stopped on a signal.',
      breakMode: 'always',
      details: {
        message: signal?.meaning ?? '',
        // No stack trace to give: there is no unwind information in a DWARF-less assembly binary,
        // which is the same reason stackTraceRequest reports a single frame.
        stackTrace: undefined,
      },
    };
    this.sendResponse(response);
  }

  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
    this.sendResponse(response);
    try {
      // The program's stdin/stdout have to be pointed at their terminal before it starts, not
      // after — a program that reads on its first instruction would otherwise race the handshake.
      await this.terminalSetup;
      await this.gdb?.sendCommand('-exec-run');
    } catch (err) {
      this.sendEvent(new OutputEvent(`failed to start program: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  /**
   * Which lines in a source range can hold a breakpoint at all — answered straight from the
   * listing's per-file line index, with no gdb round trip.
   *
   * VS Code asks this for the range it is about to render, and uses the answer for its inline
   * breakpoint affordances. Answering it is also the half of the fix that stops a bad breakpoint
   * from being offered in the first place; setBreakPointsRequest's sliding is the half that
   * rescues one the user set anyway (from a previous session's saved breakpoints, say).
   */
  protected breakpointLocationsRequest(
    response: DebugProtocol.BreakpointLocationsResponse,
    args: DebugProtocol.BreakpointLocationsArguments,
  ): void {
    const sourcePath = args.source.path ? path.resolve(args.source.path) : undefined;
    const lines = sourcePath ? (this.addressMap?.mappedLinesByFile.get(sourcePath) ?? []) : [];
    const last = args.endLine ?? args.line;

    response.body = { breakpoints: lines.filter((line) => line >= args.line && line <= last).map((line) => ({ line })) };
    this.sendResponse(response);
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
      // Most lines in an asm file produce no code — comments, blanks, bare labels, `include`s,
      // everything in a data section — and they are exactly what a user clicks when they mean the
      // instruction just below. Reporting those unverified left a dead grey dot and no breakpoint;
      // sliding forward to the next line that does produce code matches gdb's own behaviour, and
      // the adjusted `line` in the response is what moves VS Code's marker to where it really went.
      const line = nextMappedLineAtOrAfter(this.addressMap, sourcePath, bp.line);
      const address = line === undefined ? undefined : this.addressMap.locationToAddress.get(`${sourcePath}:${line}`);
      if (line === undefined || address === undefined) {
        breakpoints.push({ verified: false, line: bp.line, message: 'No instruction maps to this line or any line after it' });
        continue;
      }
      try {
        const number = await this.insertBreakpoint(`*0x${address.toString(16)}`, bp);
        if (number) this.rememberBreakpoint(sourcePath, number);
        breakpoints.push({ verified: true, line });
      } catch (err) {
        breakpoints.push({ verified: false, line, message: (err as Error).message });
      }
    }

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  /**
   * Inserts one breakpoint at `location` (any form gdb's `-break-insert` accepts) carrying DAP's
   * optional condition / hit condition / log message, and returns its gdb breakpoint number.
   *
   * `condition` goes straight to gdb as `-c`, since a DAP condition is documented as an expression
   * "in the language of the debugger" — for this adapter that is gdb's own expression syntax, the
   * same one Watch and the Debug Console already use ("$eax == 4", "*(dword*)$esp > 0").
   */
  private async insertBreakpoint(
    location: string,
    bp: { condition?: string; hitCondition?: string; logMessage?: string },
  ): Promise<string | undefined> {
    if (!this.gdb) return undefined;
    const condition = bp.condition?.trim();
    const command = condition ? `-break-insert -c "${condition.replace(/"/g, '\\"')}" ${location}` : `-break-insert ${location}`;
    const result = await this.gdb.sendCommand(command);
    const bkpt = miData(result)?.bkpt as Record<string, unknown> | undefined;
    const number = bkpt?.number !== undefined ? String(bkpt.number) : undefined;
    if (!number) return undefined;

    // DAP's hitCondition is "ignore this many hits first", which is exactly gdb's `-break-after`.
    // Accepts a plain count; a ">5"/"==5" style expression is reduced to its number, since gdb has
    // no notion of a hit-count comparison operator here.
    const hits = bp.hitCondition ? Number.parseInt(bp.hitCondition.replace(/[^\d]/g, ''), 10) : NaN;
    if (Number.isFinite(hits) && hits > 0) {
      await this.gdb.sendCommand(`-break-after ${number} ${hits}`).catch(() => undefined);
    }

    if (bp.logMessage) this.logPoints.set(number, bp.logMessage);
    else this.logPoints.delete(number);

    return number;
  }

  /** gdb breakpoint number -> the DAP log message to print instead of stopping. */
  private readonly logPoints = new Map<string, string>();

  /**
   * Handles a stop that landed on a logpoint: prints the message and resumes, without ever
   * surfacing a StoppedEvent.
   *
   * Implemented in the adapter rather than with gdb's own `dprintf` because a DAP log message
   * interpolates `{expression}` with the debugger's expression syntax, which has no direct
   * translation to a printf format string plus argument list — and getting that translation
   * subtly wrong would corrupt the very output the user added the logpoint to read.
   */
  private handleLogPoint(data: Record<string, unknown>): boolean {
    const number = data.bkptno !== undefined ? String(data.bkptno) : undefined;
    const message = number ? this.logPoints.get(number) : undefined;
    if (!message) return false;

    void this.interpolate(message)
      .then((text) => {
        this.sendEvent(new OutputEvent(`${text}\n`, 'console'));
        return this.gdb?.sendCommand('-exec-continue');
      })
      .catch((err) => this.sendEvent(new OutputEvent(`logpoint failed: ${(err as Error).message}\n`, 'stderr')));
    return true;
  }

  /** Replaces every `{expr}` in a logpoint message with gdb's evaluation of `expr`. */
  private async interpolate(message: string): Promise<string> {
    const parts = message.split(/(\{[^{}]*\})/);
    const evaluated = await Promise.all(
      parts.map(async (part) => {
        if (!part.startsWith('{') || !part.endsWith('}')) return part;
        const expression = part.slice(1, -1).trim();
        if (!expression) return part;
        try {
          const result = await this.gdb!.sendCommand(`-data-evaluate-expression "${expression.replace(/"/g, '\\"')}"`);
          const value = miData(result)?.value;
          return typeof value === 'string' ? value : part;
        } catch {
          // A logpoint that mentions something unevaluatable should still print the rest of its
          // message rather than failing outright.
          return part;
        }
      }),
    );
    return evaluated.join('');
  }

  /**
   * Breakpoints on a label by name. gdb cannot resolve these itself — fasm emits no symbol table —
   * so they are resolved through the same listing-derived symbol map everything else here uses.
   */
  protected async setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): Promise<void> {
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    if (this.gdb && this.functionBreakpointNumbers.length > 0) {
      await this.gdb.sendCommand(`-break-delete ${this.functionBreakpointNumbers.join(' ')}`).catch(() => undefined);
      this.functionBreakpointNumbers = [];
    }

    for (const bp of args.breakpoints ?? []) {
      const symbol = this.symbolMap.get(bp.name);
      if (!symbol || !this.gdb) {
        breakpoints.push({ verified: false, message: `No label named "${bp.name}" in the listing` });
        continue;
      }
      try {
        const number = await this.insertBreakpoint(`*0x${symbol.address.toString(16)}`, bp);
        if (number) this.functionBreakpointNumbers.push(number);
        breakpoints.push({ verified: true, instructionReference: `0x${symbol.address.toString(16)}` });
      } catch (err) {
        breakpoints.push({ verified: false, message: (err as Error).message });
      }
    }

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  private functionBreakpointNumbers: string[] = [];

  /**
   * Breakpoints set directly in the Disassembly View. The view was already supported (see
   * disassembleRequest); this is what makes the breakpoint gutter in it actually work, which
   * matters most exactly where source lines are least useful — inside an expanded macro.
   */
  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): Promise<void> {
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    if (this.gdb && this.instructionBreakpointNumbers.length > 0) {
      await this.gdb.sendCommand(`-break-delete ${this.instructionBreakpointNumbers.join(' ')}`).catch(() => undefined);
      this.instructionBreakpointNumbers = [];
    }

    for (const bp of args.breakpoints ?? []) {
      if (!this.gdb) {
        breakpoints.push({ verified: false });
        continue;
      }
      try {
        const address = BigInt(bp.instructionReference) + BigInt(bp.offset ?? 0);
        const number = await this.insertBreakpoint(`*0x${address.toString(16)}`, bp);
        if (number) this.instructionBreakpointNumbers.push(number);
        breakpoints.push({ verified: true, instructionReference: `0x${address.toString(16)}` });
      } catch (err) {
        breakpoints.push({ verified: false, message: (err as Error).message });
      }
    }

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  private instructionBreakpointNumbers: string[] = [];

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
    const pc = await this.currentPc();
    const loc = pc !== undefined ? this.addressMap?.addressToLocation.get(pc) : undefined;
    const frame = loc
      ? new StackFrame(MAIN_FRAME_ID, path.basename(loc.fsPath), new Source(path.basename(loc.fsPath), loc.fsPath), loc.line)
      : new StackFrame(MAIN_FRAME_ID, '<unmapped address>');
    // Needed even when `loc` resolved fine: this is what tells VS Code a Disassembly View exists
    // for this frame at all (the "Open Disassembly View" affordance), not just what backs it once
    // opened.
    if (pc !== undefined) frame.instructionPointerReference = `0x${pc.toString(16)}`;
    response.body = { stackFrames: [frame], totalFrames: 1 };
    this.sendResponse(response);
  }

  private async currentLocation(): Promise<{ fsPath: string; line: number } | undefined> {
    if (!this.addressMap) return undefined;
    const pc = await this.currentPc();
    if (pc === undefined) return undefined;
    return this.addressMap.addressToLocation.get(pc);
  }

  private async currentPc(): Promise<bigint | undefined> {
    if (!this.gdb) return undefined;
    try {
      return await this.evaluateToBigInt('$pc');
    } catch {
      return undefined;
    }
  }

  private async evaluateToBigInt(expr: string): Promise<bigint | undefined> {
    if (!this.gdb) return undefined;
    const result = await this.gdb.sendCommand(`-data-evaluate-expression ${expr}`);
    const value = miData(result)?.value;
    if (typeof value !== 'string') return undefined;
    const hexMatch = /0x[0-9a-fA-F]+/.exec(value);
    if (!hexMatch) return undefined;
    try {
      return BigInt(hexMatch[0]);
    } catch {
      return undefined;
    }
  }

  /** See variablesRequest's own doc comment on why every DAP handler that awaits anything needs
   * its own try/catch wrapper like this one, rather than relying on dispatchRequest's. */
  protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
    try {
      const instructionOffset = args.instructionOffset ?? 0;
      const target = BigInt(args.memoryReference) + BigInt(args.offset ?? 0);
      response.body = { instructions: await this.disassembleAround(target, instructionOffset, args.instructionCount) };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 10, (err as Error).message);
    }
  }

  /**
   * Resolves `instructionCount` instructions starting `instructionOffset` instructions away from
   * `target` (both DAP conventions — see DisassembleArguments), backed by gdb's own disassembler
   * (works with zero symbol table, same as everything else in this file).
   *
   * The one real difficulty: `instructionOffset` can be negative (VS Code's Disassembly View asks
   * for context *before* the current instruction), and x86 has variable-length instructions, so
   * there's no way to reliably find a real instruction boundary by walking backward from an
   * arbitrary byte offset — you can land mid-instruction and decode garbage that just happens to
   * look plausible. The fix: `sortedAddresses` (built from the same listing-derived addressMap as
   * everything else here) gives the nearest address at or before `target` that fasm2 itself
   * actually emitted an instruction at — a guaranteed-real boundary. Disassembling forward from
   * there, *through* target, is byte-accurate no matter how far back it has to reach, because x86
   * decoding is only ambiguous about where a stream starts, never about what follows a correct
   * start. Any part of the request that still falls outside what gdb could actually disassemble
   * (memory error, running off the start/end of the loaded image) is padded with DAP's own
   * sanctioned "invalid instruction" filler rather than guessed at.
   */
  private async disassembleAround(target: bigint, instructionOffset: number, instructionCount: number): Promise<DebugProtocol.DisassembledInstruction[]> {
    if (!this.gdb) return this.placeholderRun(target, instructionOffset, instructionCount);

    try {
      const anchor = instructionOffset < 0 ? (this.nearestKnownAddressAtOrBefore(target) ?? target) : target;
      // "-data-disassemble" always decodes whole instructions even past its own end address (an
      // instruction straddling the boundary is still returned in full), so over-fetching a
      // generous byte window is free and never risks a truncated instruction the way trying to
      // compute an exact byte length up front could.
      const instructionsPastTarget = Math.max(0, instructionOffset + instructionCount);
      const windowBytes = Math.min((instructionsPastTarget + 8) * MAX_X86_INSTRUCTION_BYTES, MAX_DISASSEMBLE_WINDOW_BYTES);
      const endAddr = target + BigInt(windowBytes);

      const insns = await this.disassembleRawRange(anchor, endAddr);
      const targetIdx = insns.findIndex((insn) => insn.address === target);
      if (targetIdx === -1) return this.placeholderRun(target, instructionOffset, instructionCount);

      const startIdx = targetIdx + instructionOffset;
      const out: DebugProtocol.DisassembledInstruction[] = [];
      for (let i = 0; i < instructionCount; i++) {
        const insn = insns[startIdx + i];
        out.push(insn ? this.toDisassembledInstruction(insn) : this.placeholderInstruction(target + BigInt(startIdx + i - targetIdx)));
      }
      return out;
    } catch {
      return this.placeholderRun(target, instructionOffset, instructionCount);
    }
  }

  /** Binary search over `sortedAddresses` for the greatest address <= `target` — see
   * disassembleAround's own doc comment for why this needs to be a *real* instruction boundary. */
  private nearestKnownAddressAtOrBefore(target: bigint): bigint | undefined {
    const addrs = this.sortedAddresses;
    let lo = 0;
    let hi = addrs.length - 1;
    let result: bigint | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (addrs[mid] <= target) {
        result = addrs[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  /** Raw "-data-disassemble" over an address range, mode 2 (opcodes shown, no source correlation
   * asked of gdb — this file already has its own, listing-derived source mapping, applied in
   * toDisassembledInstruction). Never throws on a malformed individual entry; skips it instead, the
   * same defensive posture as every other MI-result parser in this file. */
  private async disassembleRawRange(startAddr: bigint, endAddr: bigint): Promise<Array<{ address: bigint; opcodes?: string; inst?: string }>> {
    if (!this.gdb) return [];
    const result = await this.gdb.sendCommand(`-data-disassemble -s 0x${startAddr.toString(16)} -e 0x${endAddr.toString(16)} -- 2`);
    const raw = miData(result)?.['asm_insns'];
    if (!Array.isArray(raw)) return [];

    const out: Array<{ address: bigint; opcodes?: string; inst?: string }> = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.address !== 'string') continue;
      let address: bigint;
      try {
        address = BigInt(rec.address);
      } catch {
        continue;
      }
      out.push({
        address,
        opcodes: typeof rec.opcodes === 'string' ? rec.opcodes : undefined,
        inst: typeof rec.inst === 'string' ? rec.inst : undefined,
      });
    }
    return out;
  }

  /** A real, gdb-decoded instruction — annotated with this file's own listing-derived source
   * location when one exists at that exact address (the first instruction of a mapped line or
   * macro invocation), so the Disassembly View shows which FASM source line each instruction
   * belongs to, not just raw bytes. */
  private toDisassembledInstruction(insn: { address: bigint; opcodes?: string; inst?: string }): DebugProtocol.DisassembledInstruction {
    const loc = this.addressMap?.addressToLocation.get(insn.address);
    const out: DebugProtocol.DisassembledInstruction = {
      address: `0x${insn.address.toString(16)}`,
      instruction: insn.inst ?? '(unknown)',
    };
    if (insn.opcodes) out.instructionBytes = insn.opcodes.trim().replace(/\s+/g, ' ');
    if (loc) {
      out.location = new Source(path.basename(loc.fsPath), loc.fsPath);
      out.line = loc.line;
    }
    return out;
  }

  private placeholderRun(target: bigint, instructionOffset: number, instructionCount: number): DebugProtocol.DisassembledInstruction[] {
    const out: DebugProtocol.DisassembledInstruction[] = [];
    for (let i = 0; i < instructionCount; i++) out.push(this.placeholderInstruction(target + BigInt(instructionOffset + i)));
    return out;
  }

  /** DAP's own sanctioned way to represent an instruction slot this adapter couldn't actually
   * resolve (DisassembleArguments' own doc comment: "any unavailable instructions should be
   * replaced with an implementation-defined 'invalid instruction' value") — the address is a
   * placeholder too (real spacing isn't known for a slot gdb never decoded), never claimed to be
   * accurate, which is exactly why every such row is marked `presentationHint: 'invalid'`. */
  private placeholderInstruction(address: bigint): DebugProtocol.DisassembledInstruction {
    const clamped = address < 0n ? 0n : address;
    return { address: `0x${clamped.toString(16)}`, instruction: '(unavailable)', presentationHint: 'invalid' };
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
          // What makes "View Binary Data" (the hex editor) and "Break on Value Change" reachable
          // on this row at all — VS Code offers neither without a memoryReference.
          v.memoryReference = `0x${sym.address.toString(16)}`;
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
      const raw = miData(result)?.value;
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
        const flagsValue = miData(flagsResult)?.value;
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
      const memory = miData(result)?.memory;
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
      const raw = miData(result)?.value;
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

  /**
   * Watchpoints: "stop when this memory changes". gdb implements them natively (`-break-watch`),
   * and they are one of the most useful tools available when debugging assembly — a wrong store
   * through a mis-computed address is the classic bug, and a watchpoint finds it in one run where
   * stepping finds it in a hundred.
   *
   * `dataId` is just the address expression to watch; the Variables view offers this on a Data
   * Label row, whose `evaluateName` is its source label.
   */
  protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
    const name = args.name;
    const symbol = this.symbolMap.get(name);
    if (!symbol) {
      response.body = { dataId: null, description: `"${name}" is not a data label this listing knows an address for.` };
      this.sendResponse(response);
      return;
    }
    const size = symbol.elementSizeBytes !== undefined && symbol.elementCount !== undefined ? symbol.elementSizeBytes * symbol.elementCount : undefined;
    response.body = {
      dataId: `0x${symbol.address.toString(16)}${size ? `:${size}` : ''}`,
      description: `${name} at 0x${symbol.address.toString(16)}${size ? ` (${size} bytes)` : ''}`,
      accessTypes: ['read', 'write', 'readWrite'],
      canPersist: false,
    };
    this.sendResponse(response);
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): Promise<void> {
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    if (this.gdb && this.dataBreakpointNumbers.length > 0) {
      await this.gdb.sendCommand(`-break-delete ${this.dataBreakpointNumbers.join(' ')}`).catch(() => undefined);
      this.dataBreakpointNumbers = [];
    }

    for (const bp of args.breakpoints ?? []) {
      if (!this.gdb) {
        breakpoints.push({ verified: false });
        continue;
      }
      const [address, size] = bp.dataId.split(':');
      // gdb's own watch/rwatch/awatch, via MI's -break-watch flags: no flag = write, -r = read,
      // -a = both. The cast gives the watched region the right width; without one gdb watches
      // whatever default size it infers for a bare address.
      const flag = bp.accessType === 'read' ? '-r ' : bp.accessType === 'readWrite' ? '-a ' : '';
      const width = size ? Number.parseInt(size, 10) : 0;
      // Every cast here is deliberately a single word. MI splits a command on whitespace, so
      // "*(int *)0x..." arrives as two arguments and is rejected with "Garbage following
      // <expression>" — and "long long" would fail the same way, hence plain "long", which is the
      // 8-byte type on the LP64 targets this debugger runs against.
      const castType = width === 1 ? 'char' : width === 2 ? 'short' : width === 8 ? 'long' : 'int';
      try {
        const result = await this.gdb.sendCommand(`-break-watch ${flag}*(${castType}*)${address}`);
        const data = miData(result);
        const watch = (data?.wpt ?? data?.['hw-awpt'] ?? data?.['hw-rwpt']) as Record<string, unknown> | undefined;
        const number = watch?.number !== undefined ? String(watch.number) : undefined;
        if (number) this.dataBreakpointNumbers.push(number);
        breakpoints.push({ verified: number !== undefined });
      } catch (err) {
        breakpoints.push({ verified: false, message: (err as Error).message });
      }
    }

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  private dataBreakpointNumbers: string[] = [];

  /**
   * Raw memory, which is what backs VS Code's hex editor ("View Binary Data" on a variable). For
   * assembly this is not a niche view: a data label is a byte range, and reading it as bytes is
   * frequently the only honest way to look at it.
   */
  protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
    try {
      const address = BigInt(args.memoryReference) + BigInt(args.offset ?? 0);
      const count = args.count ?? 0;
      const bytes = count > 0 ? await this.readMemoryBytes(`0x${address.toString(16)}`, count) : [];
      response.body = {
        address: `0x${address.toString(16)}`,
        data: bytes ? Buffer.from(bytes).toString('base64') : undefined,
        unreadableBytes: bytes ? 0 : count,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 11, (err as Error).message);
    }
  }

  protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
    try {
      if (!this.gdb) throw new Error('Debug session is not running');
      const address = BigInt(args.memoryReference) + BigInt(args.offset ?? 0);
      const bytes = Buffer.from(args.data, 'base64');
      if (bytes.length === 0) {
        response.body = { bytesWritten: 0 };
        this.sendResponse(response);
        return;
      }
      // -data-write-memory-bytes takes the contents as one contiguous hex string.
      await this.gdb.sendCommand(`-data-write-memory-bytes 0x${address.toString(16)} ${bytes.toString('hex')}`);
      response.body = { bytesWritten: bytes.length, offset: 0 };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 12, (err as Error).message);
    }
  }

  /**
   * "Set next statement" — move the program counter to another line without executing what lies
   * between. Natural in assembly, where skipping a call or re-running a block is an ordinary thing
   * to want, and gdb supports it directly via `-exec-jump`.
   */
  protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
    const sourcePath = args.source.path ? path.resolve(args.source.path) : undefined;
    const address = sourcePath ? this.addressMap?.locationToAddress.get(`${sourcePath}:${args.line}`) : undefined;
    response.body = {
      targets:
        address === undefined
          ? []
          : [
              {
                id: Number(address & 0x7fffffffn),
                label: `line ${args.line}`,
                line: args.line,
                instructionPointerReference: `0x${address.toString(16)}`,
              },
            ],
    };
    // Remembered by id, since DAP's gotoRequest carries only the target id back.
    if (address !== undefined) this.gotoTargets.set(Number(address & 0x7fffffffn), address);
    this.sendResponse(response);
  }

  private readonly gotoTargets = new Map<number, bigint>();

  protected async gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): Promise<void> {
    const address = this.gotoTargets.get(args.targetId);
    if (address === undefined || !this.gdb) {
      this.sendErrorResponse(response, 13, 'That location is not a known instruction address.');
      return;
    }
    try {
      // -exec-jump resumes at the new address. The program is then running, so the resulting stop
      // arrives through the ordinary 'stopped' path; announce the move itself as a stop so the UI
      // re-reads the program counter even if nothing else halts it.
      this.sendResponse(response);
      await this.gdb.sendCommand(`-break-insert -t *0x${address.toString(16)}`);
      await this.gdb.sendCommand(`-exec-jump *0x${address.toString(16)}`);
    } catch (err) {
      this.sendEvent(new OutputEvent(`set next statement failed: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  /**
   * Restart re-runs the loaded program in the same gdb session, which keeps every breakpoint,
   * watchpoint and console setting already established — much cheaper, and much less disruptive,
   * than VS Code's fallback of terminating the session and launching a whole new one.
   */
  protected async restartRequest(response: DebugProtocol.RestartResponse): Promise<void> {
    if (!this.gdb) {
      this.sendErrorResponse(response, 14, 'Debug session is not running');
      return;
    }
    try {
      this.sendResponse(response);
      this.lastSignal = undefined;
      await this.gdb.sendCommand('-exec-run');
    } catch (err) {
      this.sendEvent(new OutputEvent(`restart failed: ${(err as Error).message}\n`, 'stderr'));
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

  /** Statement-granularity step: repeats one machine-instruction step (over or into a `call`,
   * per `miCommand`) until the PC reaches a different source-mapped line, since there's no line
   * table to consult for "the next statement" directly. */
  private async stepToNextLine(response: DebugProtocol.Response, miCommand: StepMiCommand): Promise<void> {
    this.sendResponse(response);
    if (!this.gdb || !this.addressMap) return;
    if (this.stepping) return; // a step is already in flight — see `stepping`'s own doc comment
    this.stepping = true;

    try {
      const startLoc = await this.currentLocation();

      for (let i = 0; i < MAX_STEP_INSTRUCTIONS; i++) {
        let result;
        try {
          result = await this.gdb.sendCommand(miCommand);
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
    } finally {
      this.stepping = false;
    }
  }

  /** Instruction-granularity step (VS Code's Disassembly View "Step"): exactly one machine
   * instruction, reported immediately regardless of whether it changed source line — the whole
   * point is watching each instruction happen individually (e.g. a macro's expansion), which
   * stepToNextLine's line-granularity loop deliberately hides. */
  private async stepOneInstruction(response: DebugProtocol.Response, miCommand: StepMiCommand): Promise<void> {
    this.sendResponse(response);
    if (!this.gdb) return;
    if (this.stepping) return; // a step is already in flight — see `stepping`'s own doc comment
    this.stepping = true;
    try {
      let result;
      try {
        result = await this.gdb.sendCommand(miCommand);
      } catch (err) {
        this.sendEvent(new OutputEvent(`step failed: ${(err as Error).message}\n`, 'stderr'));
        return;
      }
      if (result.klass !== 'running') return;
      const stoppedOnce = await this.waitForNextStop();
      if (!stoppedOnce) return;
      this.sendEvent(new StoppedEvent('step', MAIN_THREAD_ID));
    } finally {
      this.stepping = false;
    }
  }

  /**
   * Resolves `true` for a real code stop (the caller should keep stepping/inspecting), `false`
   * for anything that means there's no more program left to step through — the gdb *process*
   * itself exiting (existing behavior), but also the *inferior* exiting normally while gdb stays
   * up, which arrives as an ordinary 'stopped' event with reason "exited"/"exited-normally" (real
   * bug found here: this used to resolve `true` unconditionally for *any* stopped event, so
   * stepping the exact instruction that ends the program — e.g. its own "syscall" exit — made
   * stepToNextLine's loop try to evaluate $pc against a dead inferior, fail, treat that failure as
   * "landed on an unmapped address, keep stepping" (see its own `if (!loc) continue`), and send yet
   * another step command to a process that no longer exists — which is exactly what surfaced as a
   * spurious "step failed: The program is not being run." right after the real, correct
   * TerminatedEvent had already fired from onStopped's own separate 'stopped' listener).
   */
  private waitForNextStop(): Promise<boolean> {
    if (!this.gdb) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onStop = (data: Record<string, unknown>) => {
        this.gdb?.off('exit', onExit);
        const reason = typeof data.reason === 'string' ? data.reason : '';
        resolve(!reason.startsWith('exited'));
      };
      const onExit = () => {
        this.gdb?.off('stopped', onStop);
        resolve(false);
      };
      this.gdb!.once('stopped', onStop);
      this.gdb!.once('exit', onExit);
    });
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    if (args.granularity === 'instruction') void this.stepOneInstruction(response, '-exec-next-instruction');
    else void this.stepToNextLine(response, '-exec-next-instruction');
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    if (args.granularity === 'instruction') void this.stepOneInstruction(response, '-exec-step-instruction');
    else void this.stepToNextLine(response, '-exec-step-instruction');
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
    if (args.granularity === 'instruction') void this.stepOneInstruction(response, '-exec-step-instruction');
    else void this.stepToNextLine(response, '-exec-step-instruction');
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

    // A bare identifier (a single token, no operators/brackets/"$"-prefix) that isn't a register,
    // label, or constant has no runtime value at all — a macro invocation (e.g. "write_msg" in
    // "write_msg write_stderr, usage_text, usage_text_len": the macro itself vanishes entirely at
    // compile time, only the instructions it expands to exist at runtime), or any other stray word
    // fasmg's own preprocessor consumed. Asking gdb would only produce its own raw, unhelpful error
    // ("No symbol table is loaded" or similar) — the exact noise labels/constants above are
    // resolved locally specifically to avoid.
    //
    // Deliberately does NOT cover instruction mnemonics/directives/format keywords/size specifiers
    // (KNOWN_LANGUAGE_TOKENS) even though those are equally "no runtime value" — those already get
    // a real, useful hover from the language server's own hover provider (VS Code shows it
    // *alongside* whatever this debug adapter returns for the same token), and unlike a *failed*
    // evaluate — which VS Code drops silently, leaving the language hover to stand on its own — a
    // *successful* one (this short-circuit) actually gets shown, stepping on a hover that already
    // worked fine. So a known mnemonic just falls through to the generic evaluator below and fails
    // the same way it always did, exactly as before this fix existed.
    //
    // Only short-circuited for contexts where the user explicitly asked about *this* token (hover/
    // watch/clipboard/variables); inline-value decorations (VS Code's own undocumented context
    // string for those — see extension/src/inlineValues.ts) keep falling through to the generic
    // evaluator too, since a "no value here" annotation next to every stray identifier on the
    // stopped line would be noise there, not something anyone explicitly asked for. A "$"-prefixed
    // bare word (e.g. "$pc", a gdb convenience variable, not a register this file knows how to
    // format) is excluded the same way — that's gdb's own namespace, not a FASM source identifier.
    if (EXPLICIT_ASK_CONTEXTS.has(args.context ?? '') && BARE_IDENTIFIER_RE.test(trimmed) && !KNOWN_LANGUAGE_TOKENS.has(trimmed.toLowerCase())) {
      const text = args.context === 'hover' ? `"${trimmed}" has no runtime value here — not a register, label, or constant (likely a macro invocation, which fasmg's compile-time-only constructs never generate a symbol for)` : `(no runtime value) ${trimmed}`;
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
      const value = miData(result)?.value;
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
    releaseTerminal(this.terminalHandshakeFile);
    this.terminalHandshakeFile = undefined;
    await this.gdb?.dispose();
    this.sendResponse(response);
  }

  protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    releaseTerminal(this.terminalHandshakeFile);
    this.terminalHandshakeFile = undefined;
    await this.gdb?.dispose();
    this.sendResponse(response);
  }
}
