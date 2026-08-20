// The DAP session: translates VS Code's debug protocol requests into GdbDriver/MI commands and
// GdbDriver events into DAP events. Deliberately honest about what a debugger for raw, DWARF-less
// assembly can offer:
//   - A call stack reconstructed from the listing rather than from unwind information, which a
//     fasmg binary has none of — see unwind.ts. Frames are named by the label they are inside,
//     since there is no function symbol to name them after.
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
import { CapabilitiesEvent, ContinuedEvent, DebugSession, Handles, InitializedEvent, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import { AttachTarget, parseTerminationSignal, resolveAttachTarget } from './attachTarget';
import { readElfEntryPoint } from './elfEntry';
import { readPeEntryPoint } from './peEntry';
import { GdbDriver } from './gdbDriver';
import { agentCommand, agentEnv, agentModulePath, ConsoleKind, endpointPath, isTerminalConsole, runInTerminalKind, TerminalHandshake } from './inferiorTerminal';
import { AddressLineMap, buildAddressLineMap, nextMappedLineAtOrAfter } from '@fasm2-studio/server/src/listing/listingMap';
import { miData } from './miParser';
import { OperandResolver, translateMemoryOperand } from './operandExpression';
import {
  changeReportingNames,
  CounterState,
  DecodedBitField,
  decodeEflags,
  decodeExtendedFloat,
  decodeMxcsr,
  decodeX87Control,
  decodeX87Status,
  decodeX87Tags,
  evaluateJumpConditions,
  formatBinaryGrouped,
  formatBitFieldSummary,
  formatBytesLittleEndian,
  formatChangedSummary,
  formatEflagsSummary,
  formatExtendedFloat,
  formatHexPadded,
  formatMaskRegister,
  formatPkru,
  formatRegisterDelta,
  formatRegisterDetailed,
  formatRegisterValue,
  formatRegisterValueCompact,
  formatSegmentSelector,
  formatVectorDetailed,
  formatVectorValueCompact,
  gdbRegisterName,
  isReservedRegisterMnemonic,
  packedAsciiText,
  parseUserNumber,
  PSEUDO_REGISTER_WIDTH_BITS,
  REGISTER_WIDTH_BITS,
  RegisterBits,
  RegisterGroups,
  registerWidthBits,
  resolveRegisterGroups,
  subRegisterViews,
  unsignedCastType,
  VECTOR_WIDTH_BITS,
  VectorBits,
  vectorLaneGroups,
  vectorSubRegisterViews,
  wideParentOf32BitView,
  X87_REGISTER_NAMES,
} from './registers';
import { SYSCALL_ARGUMENT_REGISTERS, SyscallAbi, syscallName } from './syscalls';
import { collectReturnSites, unwindStack, UnwoundFrame } from './unwind';
import { defaultEnabledSignals, signalHandlingCommands, SIGNAL_FILTERS } from './signalFilters';
import {
  buildConstantMap,
  buildSymbolAddressMap,
  buildSymbolSpans,
  ConstantSymbol,
  DebugSymbol,
  describeAddress,
  formatConstantCompact,
  formatConstantDetailed,
  SymbolSpan,
} from './symbols';
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
/** How long stepToNextLine/stepOneInstruction wait for gdb's *stopped record after a single
 * `-exec-step-instruction`/`-exec-next-instruction` before treating gdb as stuck rather than slow.
 * One machine instruction should always come back in low milliseconds — the loop only reaches for
 * this when gdb itself never delivers the async stop it already acknowledged with "^running", which
 * is not something MAX_STEP_INSTRUCTIONS guards against: that cap only fires between completed
 * steps, and a step that never completes never reaches it. Seen in practice stepping into a Windows
 * API call (no debug symbols, and gdb-on-Windows single-stepping through it) with GDB for MinGW-W64;
 * without this bound that hang is permanent, since `stepping` stays true forever and every later
 * request — Continue, further steps, even a plain register read — silently no-ops against it. */
const STEP_STOP_TIMEOUT_MS = 15_000;
/** How long recoverFromStuckStep waits for its own `-exec-interrupt` to actually produce a stop,
 * once a step has already been judged stuck. Short: this is a last-resort nudge, not a normal wait. */
const STEP_INTERRUPT_TIMEOUT_MS = 3_000;
/** A raw console command (e.g. a typed "continue" or "run") doesn't return control to gdb's
 * command reader until the target stops again, unlike this adapter's own -exec-* commands, which
 * return immediately and report the eventual stop as a separate async event — see
 * runConsoleCommand's own doc comment. DEFAULT_COMMAND_TIMEOUT_MS (gdbDriver.ts, 10s) would fire
 * on any long-running program, so this path gets a much longer budget instead. */
const CONSOLE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Marks a data breakpoint's `dataId` as naming a register rather than an address. A dataId is
 * opaque to VS Code — it hands back whatever dataBreakpointInfoRequest returned — so this is
 * purely how setDataBreakpointsRequest tells the two apart. The colon keeps it from ever colliding
 * with the "0x...:size" form the address case uses, since a register name has no "0x" prefix. */
const REGISTER_DATA_ID_PREFIX = 'register:';
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
type StepMiCommand =
  | '-exec-step-instruction'
  | '-exec-next-instruction'
  /* The same two primitives run backwards against gdb's execution recording — see enableRecording.
   * Reverse stepping is exactly the forward algorithm with the direction flipped, so both step
   * helpers below take these without any further special-casing. */
  | '-exec-step-instruction --reverse'
  | '-exec-next-instruction --reverse';

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

const EMPTY_REGISTER_GROUPS: RegisterGroups = {
  generalPurpose: [], pointers: [], segment: [], eflagsName: undefined,
  vector: [], x87: [], x87Control: [], mxcsrName: undefined, mask: [], thread: [], numbers: new Map(),
  namesByNumber: new Map(),
};

/** How many machine words of stack the Stack group shows by default (see TargetArgs.stackWords).
 *
 * With no DWARF and no types, the raw stack is not a convenience here — it is the only way to see a
 * saved register or an argument that was pushed rather than passed in one. Sixteen words is deep
 * enough to cover a prologue's worth of pushes plus the return address above them, and shallow
 * enough to stay one screen and one memory read. */
const STACK_WORDS_SHOWN = 16;

/** How much stack the unwinder reads, in bytes — one read, sized to bound how deep a backtrace can
 * go rather than to match what the Stack group displays. A chain or scan that runs past this window
 * stops there, so this is the real limit on frame depth; 4KB is a page, covers any realistic
 * hand-written call depth, and is a single round-trip either way. */
const UNWIND_STACK_BYTES = 4096;
/** Frames beyond this are not reported. Bounds the pathological case (a corrupted frame-pointer
 * chain that validates at every step) without touching any real program. */
const MAX_UNWOUND_FRAMES = 64;
/** The System V red zone: 128 bytes below rsp a leaf function may use without moving the stack
 * pointer. Shown only when asked for — see TargetArgs.stackRedZone. */
const RED_ZONE_BYTES = 128;

/** What each x87 environment register is, for the tooltip on its row. The four address fields are
 * one idea split across four registers, so they are described as the one idea. */
const X87_CONTROL_DESCRIPTIONS: Record<string, string> = {
  fctrl: 'x87 control word — the precision and rounding every FPU computation is carried out at, and which exceptions are masked.',
  fstat: 'x87 status word — which exceptions have fired (sticky), the comparison result in C0-C3, and TOP: which physical register st0 currently names.',
  ftag: 'x87 tag word — whether each physical register holds a value at all. An "empty" register still holds bits, and they still read as a plausible number.',
  fop: 'The opcode of the last non-control x87 instruction executed.',
  fiseg: 'Segment of the last x87 instruction — with fioff, the address of the instruction that raised whatever fstat is reporting.',
  fioff: 'Offset of the last x87 instruction — with fiseg, the address of the instruction that raised whatever fstat is reporting.',
  foseg: 'Segment of the last x87 memory operand — with fooff, the address that instruction was reading or writing.',
  fooff: 'Offset of the last x87 memory operand — with foseg, the address that instruction was reading or writing.',
};

const THREAD_REGISTER_DESCRIPTIONS: Record<string, string> = {
  fs_base: 'The base address fs-relative accesses resolve against. In 64-bit mode the fs *selector* is ignored for addressing and this is what `mov rax, [fs:0x28]` actually reads from — thread-local storage, and the stack canary.',
  gs_base: 'The base address gs-relative accesses resolve against. Used for thread-local storage by some runtimes, and by the kernel for per-CPU data.',
  pkru: 'Protection Key Rights — two bits per memory-protection key (access-disable, write-disable), applied on top of the page tables for pages tagged with that key. Reads as unrestricted in any program that never called pkey_alloc, which is essentially all of them.',
};

/**
 * How much room the caller has for a register's value, and therefore which of registers.ts's three
 * renderings it gets:
 *  - `compact` for anywhere the register's name is already on screen beside the value — a tree row
 *    whose name column holds it, a Watch entry labelled with the expression that produced it, or an
 *    inline decoration (VS Code composes those as "<expression> = <result>" itself, so a name in the
 *    result would be the second one on the line).
 *  - `labelled` where the value travels alone and has to say what it is: the Debug Console, the
 *    clipboard.
 *  - `detailed` for a hover, the one place with room for every reading at once.
 */
type RegisterDisplayForm = 'compact' | 'labelled' | 'detailed';
/** DAP evaluate contexts that already show the expression next to whatever comes back — see
 * RegisterDisplayForm. VS Code also sends "watch" for the inline-value decorations the extension's
 * own InlineValuesProvider asks for (confirmed against the VS Code build this repo tests against),
 * which is the same situation: the expression is already on the line. */
const NAME_ALREADY_SHOWN_CONTEXTS: ReadonlySet<string> = new Set(['watch', 'variables']);

/** How many bytes to read behind a register that holds an address, to show what it points at.
 * One qword plus enough trailing bytes for a short string preview — a single gdb round-trip, paid
 * only when a register row is actually expanded. */
const POINTEE_PREVIEW_BYTES = 32;

/** Byte widths a single gdb-cast memory read can resolve to a plain scalar (matches
 * REGISTER_WIDTH_BITS' own domain) — a source label declared with a wider size (e.g. `dqword`,
 * `dt`) still resolves to an address, just not a single-number value (see formatSymbolValueDetailed). */
const READABLE_VALUE_BITS: Record<number, RegisterBits> = { 1: 8, 2: 16, 4: 32, 8: 64 };

/** What both launch and attach need to get a gdb up against the right binary with the right
 * address-to-source map — see startTarget. */
interface TargetArgs {
  /** Path to the assembled, executable binary. */
  program: string;
  /** Path to the original .asm entry source file (for listing correlation). */
  asmFile: string;
  /** Path to the .lst listing produced alongside `program` (see the extension's debug build task). */
  listingFile: string;
  gdbPath?: string;
  cwd?: string;
  /** Command-line arguments for the debugged program itself (not for gdb). Launch only: an
   * already-running process was started with whatever arguments it was started with. */
  args?: string[];
  /** Extra environment variables for the debugged program. Merged over the adapter's own
   * environment, which gdb passes down to the inferior it starts. */
  env?: Record<string, string>;
  /** How many machine words at and above the stack pointer the Stack group lists. Worth raising for
   * a program with deep frames; the whole group is still one memory read however deep it goes. */
  stackWords?: number;
  /** Whether to also list the 128 bytes *below* the stack pointer — the System V red zone, which a
   * leaf function may use as scratch without moving rsp. Off by default because for most code those
   * words are leftovers rather than data, and on when you are debugging a leaf that uses them,
   * where nothing else in the UI shows them at all. */
  stackRedZone?: boolean;
}

interface AttachArgs extends DebugProtocol.AttachRequestArguments, TargetArgs {
  /** Process to attach to. A string is accepted because that is what a `${command:...}` process
   * picker substitution produces. */
  processId?: number | string;
  /** Core dump to open instead of a live process. */
  coreFile?: string;
}

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments, TargetArgs {
  stopOnEntry?: boolean;
  /** Where the debugged program's own stdin/stdout live — the Debug Console (default, output only)
   * or a real terminal, which is the only one of the two that can be typed into. See
   * inferiorTerminal.ts. */
  console?: ConsoleKind;
  /** Set by the extension when it opened the program's terminal itself: the address the agent
   * running in that terminal is trying to reach. Absent for any other DAP client, which gets asked
   * to open a terminal instead. See inferiorTerminal.ts. */
  terminalEndpoint?: string;
  /** Records execution so the program can be stepped *backwards* — see enableRecording for why
   * this is opt-in rather than simply always on. */
  reverseDebugging?: boolean;
}

export class FasmDebugSession extends DebugSession {
  private gdb: GdbDriver | undefined;
  /** Which request started this session. Almost everything is identical either way; what isn't is
   * whether the program is ours to start (`-exec-run` on configurationDone, re-run on restart) and
   * whether it is ours to kill when the session ends. */
  private mode: 'launch' | 'attach' = 'launch';
  /** Whether this launch asked for reverse debugging, and whether gdb actually granted it. The two
   * are separate because the request can fail on a debugger that has no execution recording at all
   * (lldb-mi), and every reverse request has to refuse clearly rather than hand gdb a command it
   * will reject with prose about a target that "does not support this command". */
  private reverseDebugging = false;
  private recording = false;
  /** What an attach session attached to, or undefined for a launch. A core dump is the one target
   * here that can never be resumed, so the execution requests check it. */
  private attachTarget: AttachTarget | undefined;
  /** gdb's console stream so far. Kept because a couple of things gdb only ever says in prose have
   * to be read back out of it — see parseTerminationSignal. */
  private consoleLog = '';
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
  /** The same labels as symbolMap, as ascending address ranges — the reverse lookup ("this register
   * holds 0x402008; what is that?"), which a name-keyed map can't answer. See buildSymbolSpans. */
  private symbolSpans: SymbolSpan[] = [];
  /** Every address a call in this program pushes — the closed set that makes recognising a return
   * address on the stack exact rather than a guess. See collectReturnSites. */
  private returnSites: ReadonlySet<bigint> = new Set();
  private stackWordsShown = STACK_WORDS_SHOWN;
  private showRedZone = false;
  /** The frames of the last stackTraceRequest, by the frame id handed to the client — so a later
   * scopes/variables request naming a frame can say which one it is. */
  private frames: UnwoundFrame[] = [];
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
      // and the terminal agent would keep an otherwise finished terminal waiting.
      this.terminalHandshake?.release();
      void this.gdb?.dispose().finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  /** Whether the client can open a terminal for us on request — a "console" launch attribute
   * asking for one is only answerable if it can. */
  private clientSupportsRunInTerminal = false;
  /** This session's connection to the agent running in the program's terminal; closing it releases
   * the terminal. */
  private terminalHandshake: TerminalHandshake | undefined;
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
    // The Debug Console here is a raw gdb command line (see evaluateRequest's 'repl' branch), which
    // is only usable if you already know gdb's command set by heart. gdb can complete its own
    // commands, and this is what lets the console ask it to.
    response.body.supportsCompletionsRequest = true;
    response.body.completionTriggerCharacters = [' ', '-', '$'];
    // Without these the Breakpoints panel has no exception section at all for a FASM session, and
    // gdb's own defaults — stop on every fault — are the only behaviour reachable. See
    // signalFilters.ts for why a program may legitimately want them off.
    response.body.exceptionBreakpointFilters = SIGNAL_FILTERS.map(({ filter, label, description, default: def }) => ({
      filter,
      label,
      description,
      default: def,
    }));
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  /**
   * Everything launch and attach need identically: the listing-derived maps that turn addresses
   * into source lines, and a gdb loaded with the same binary. What differs afterwards is only how
   * the target starts existing — `-exec-run` for launch, `-target-attach`/`-target-select core`
   * for attach — so that is all either request handler is left holding.
   */
  private startTarget(args: TargetArgs): void {
    const { entries: listingEntries, ...addressMap } = buildAddressLineMap(args.listingFile, path.resolve(args.asmFile));
    this.addressMap = addressMap;
    this.sortedAddresses = [...this.addressMap.addressToLocation.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.symbolMap = buildSymbolAddressMap(listingEntries);
    this.symbolSpans = buildSymbolSpans(this.symbolMap);
    this.constantMap = buildConstantMap(listingEntries);
    this.returnSites = collectReturnSites(listingEntries);
    this.stackWordsShown = args.stackWords ?? STACK_WORDS_SHOWN;
    this.showRedZone = args.stackRedZone === true;

    this.gdb = new GdbDriver();
    this.gdb.on('console', (text) => {
      this.consoleLog += text;
      this.sendEvent(new OutputEvent(text, 'console'));
    });
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
    void this.resolveRegisterNames();

    // FASM is Intel-syntax throughout; gdb's own disassembler defaults to AT&T on Linux, which
    // would read as a different, unfamiliar language in the Disassembly View. lldb-mi has no
    // equivalent MI-reachable setting, so this is best-effort and silently ignored there — worth
    // doing for the common gdb case, not worth failing the whole launch over on the experimental
    // macOS path.
    void this.gdb.sendCommand('-gdb-set disassembly-flavor intel').catch(() => {});

    // Replays the signal choice onto the driver that has just come into existence. The client sends
    // setExceptionBreakpoints during the configuration phase, which runs concurrently with the
    // launch that gets here — so on a cold start that request has usually already been answered
    // against no gdb at all, and this is the call that actually makes it take effect.
    void this.applySignalHandling();
  }

  /**
   * Attaches to something that is already there: a running process, or the core dump of one that
   * already died.
   *
   * The listing still does all the source mapping, exactly as it does for launch — which is also
   * the one thing this cannot resolve for the user. The listing has to be the one produced by the
   * build that made *this* binary; a rebuilt listing describes a different program that happens to
   * share a name, so the extension refuses to build one here rather than quietly correlating
   * addresses against source lines they never belonged to.
   */
  protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachArgs): Promise<void> {
    const resolved = resolveAttachTarget(args);
    if ('error' in resolved) {
      this.sendErrorResponse(response, 2, resolved.error);
      return;
    }

    try {
      this.mode = 'attach';
      this.attachTarget = resolved.target;
      this.startTarget(args);

      if (resolved.target.kind === 'process') {
        // gdb stops the process as part of attaching and reports that stop as its own *stopped
        // record, which onStopped turns into the StoppedEvent — nothing to synthesize here.
        // Its failures are worth passing through verbatim: the overwhelmingly common one on Linux
        // is a ptrace_scope refusal, and gdb's own message already names the sysctl and why.
        await this.gdb!.sendCommand(`-target-attach ${resolved.target.processId}`);
      } else {
        this.consoleLog = '';
        await this.gdb!.sendCommand(`-target-select core ${resolved.target.coreFile}`);
        // A core is never "running", so gdb emits no *stopped record for it at all — without a
        // synthesized one the session would sit at "attached" forever, showing no frame, no
        // registers and no source line, which is the entire content of a post-mortem session.
        this.reportCoreStop();
      }

      // Capabilities are answered at initialize, before anything knows whether this will be a
      // launch or an attach — so the restart button is declared for every session and has to be
      // withdrawn here, for the one kind of session where pressing it would act on the wrong
      // process. A capabilities event is the protocol's own way of saying that after the fact.
      this.sendEvent(new CapabilitiesEvent({ supportsRestartRequest: false }));

      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 2, `Failed to attach: ${(err as Error).message}`);
    }
  }

  /** Turns a loaded core into the stop VS Code needs to render a frame, naming the signal that
   * killed the program — see parseTerminationSignal for why that has to come out of prose. */
  private reportCoreStop(): void {
    const signal = parseTerminationSignal(this.consoleLog);
    this.lastSignal = signal;
    const stopped = new StoppedEvent(signal ? 'exception' : 'pause', MAIN_THREAD_ID);
    const description = signal ? `${signal.name} (${signal.meaning})` : 'core dump';
    (stopped.body as DebugProtocol.StoppedEvent['body']).description = description;
    (stopped.body as DebugProtocol.StoppedEvent['body']).text = signal ? `${signal.name}: ${signal.meaning}` : 'Loaded from a core dump.';
    this.sendEvent(stopped);
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
    try {
      this.mode = 'launch';
      this.startTarget(args);

      // Started here but deliberately *not* awaited here — configurationDone waits for it instead,
      // which is the last moment before the program actually starts and therefore the last moment
      // the tty has to be settled by. Awaiting it inside launchRequest instead delays the launch
      // response by however long the client takes to open a terminal (seconds, since it is a real
      // UI action), and a launch response that lands after the first 'stopped' event is one VS Code
      // silently drops — the same regression the register-name lookup above is written to avoid,
      // caught here by the extension's own real-VS-Code debug tests.
      if (isTerminalConsole(args.console)) {
        const cwd = args.cwd ?? path.dirname(args.program);
        this.terminalSetup = this.attachInferiorTerminal(args.console!, cwd, args.terminalEndpoint).catch((err: Error) => {
          // Nothing in the session may be left waiting on this promise: a rejection here means the
          // program keeps its output in the Debug Console, not that it fails to run.
          this.sendEvent(new OutputEvent(`could not attach a terminal (${err.message}) — the program keeps its output here.\n`, 'stderr'));
        });
      }

      this.reverseDebugging = args.reverseDebugging === true;

      // Recording can only be switched on while the program is stopped, and it has to be on before
      // any of the code the user means to step back through has run — which leaves the entry point
      // as the only place it can start. So a launch that asked for reverse debugging stops there
      // whether or not it asked to, rather than coming up with an empty history and a Step Back
      // button that does nothing.
      const stopAtEntry = args.stopOnEntry === true || this.reverseDebugging;
      if (stopAtEntry) {
        if (this.reverseDebugging && !args.stopOnEntry) {
          this.sendEvent(
            new OutputEvent('Reverse debugging records execution from the entry point, so this launch stops there first.\n', 'console'),
          );
        }
        // gdb's own `start` command needs a symbol table to resolve "main", which these binaries
        // don't have — read the entry point straight out of the executable header instead (stable,
        // well-known layout, no symbols required). The "lowest address in the listing" isn't a
        // safe stand-in: format-directive lines (e.g. the header bytes themselves) can sit at
        // address 0, which isn't a valid breakpoint location and made gdb reject the launch.
        // ELF is tried first since it's the common case; a fasm2 "format PE" build only ever
        // matches the PE reader, so trying both costs nothing a real ELF launch would notice.
        const resolvedProgram = path.resolve(args.program);
        const entryAddress = readElfEntryPoint(resolvedProgram) ?? readPeEntryPoint(resolvedProgram);
        if (entryAddress !== undefined) {
          await this.gdb!.sendCommand(`-break-insert -t *0x${entryAddress.toString(16)}`);
        } else {
          this.sendEvent(
            new OutputEvent('Could not determine the entry point (not a recognized ELF or PE file) — stopOnEntry is disabled for this run.\n', 'stderr'),
          );
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
  private async attachInferiorTerminal(kind: ConsoleKind, cwd: string, providedEndpoint: string | undefined): Promise<void> {
    if (!this.gdb) return;

    // A terminal the extension opened itself, before this process even started: it tells us where
    // to listen and the agent is already out there trying to connect. Preferred over asking the
    // client, because opening it that way puts no shell between us and the agent — see
    // inferiorTerminal.ts on why a shell in that position is the fragile part of this.
    const clientOpensTerminal = providedEndpoint === undefined;
    if (clientOpensTerminal && !this.clientSupportsRunInTerminal) {
      this.sendEvent(
        new OutputEvent('This client cannot open a terminal on request, so the program keeps its output here and has no stdin.\n', 'stderr'),
      );
      return;
    }

    const handshake = new TerminalHandshake(providedEndpoint ?? endpointPath());
    // Windows has no pty for -inferior-tty-set to be pointed at directly, but the command does
    // accept an ordinary Windows named pipe path there and wires the debuggee's stdio to it just
    // the same — see inferiorTerminal.ts's own top comment. The agent hosts that pipe itself, not
    // this adapter, so once it exists the program talks to the terminal directly here too.
    const ioEndpoint = process.platform === 'win32' ? endpointPath() : undefined;
    try {
      await handshake.listen();
    } catch (err) {
      this.sendEvent(new OutputEvent(`could not open a channel to the terminal (${(err as Error).message}) — the program keeps its output here.\n`, 'stderr'));
      return;
    }

    if (clientOpensTerminal) {
      const opened = await new Promise<DebugProtocol.RunInTerminalResponse | undefined>((resolve) => {
        this.runInTerminalRequest(
          {
            kind: runInTerminalKind(kind),
            title: 'FASM program',
            cwd,
            args: agentCommand(agentModulePath(), handshake.endpoint, undefined, ioEndpoint),
            env: agentEnv(),
          },
          RUN_IN_TERMINAL_TIMEOUT_MS,
          (response) => resolve(response),
        );
      });

      if (!opened?.success) {
        handshake.release();
        this.sendEvent(new OutputEvent(`The client did not open a terminal (${opened?.message ?? 'no response'}) — the program keeps its output here.\n`, 'stderr'));
        return;
      }
    }

    const tty = await handshake.waitForTty();
    // On Windows there is no tty to report, so `tty` is always undefined there even on success —
    // `handshake.reported` is what actually distinguishes "the agent connected and its pipe is
    // ready" from "nothing ever answered" (see its own doc comment).
    const ready = ioEndpoint !== undefined ? handshake.reported : tty !== undefined;
    if (!ready) {
      handshake.release();
      this.sendEvent(
        new OutputEvent('The terminal never reported in — the program keeps its output here, where it has no stdin to read.\n', 'stderr'),
      );
      return;
    }

    try {
      await this.gdb.sendCommand(`-inferior-tty-set ${ioEndpoint ?? tty}`);
      this.terminalHandshake = handshake;
    } catch (err) {
      handshake.release();
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

  /** Whether the register set has been re-read since the process started running — see
   * resolveRegisterNames for why once is not enough. */
  private registerNamesResolvedWhileRunning = false;

  /** Whether the program has executed since the last register snapshot was taken — set at every
   * resume (see ensureResumable), cleared by refreshChangedRegisters. What keeps the panel being
   * read twice within one stop (which VS Code does after an in-place edit) from diffing a register
   * against itself and reporting that nothing ever changes. */
  private inferiorRanSinceSnapshot = false;

  /** The integer registers as of the last time the panel was read, as of the read before that, and
   * which names differ between the two. Both snapshots are kept because they answer different
   * questions: the diff drives the group headers, and the older values are what a register's own
   * "previous" row shows. See refreshChangedRegisters. */
  private registerSnapshot = new Map<string, bigint>();
  private registerPrevious = new Map<string, bigint>();
  private changedRegisterNames = new Set<string>();
  /** Whether anything may have moved since the snapshot was taken — a resume, or a write from any
   * of the several paths that can perform one. Starts true because there is no snapshot at all
   * yet, and the first stop has to take one for the first step to have something to differ from. */
  private registerValuesStale = true;
  /** Whether gdb's "everything changed" report for the session's first stop has been consumed yet.
   * Tracked rather than inferred from the snapshot being empty, so that a client which expands a
   * register group before ever reading the Registers scope cannot leave that report to surface
   * later as a step that appeared to move every register in the target. */
  private changedRegistersBaselineTaken = false;
  /** Whether gdb has already been asked which registers changed, at this stop. The query is
   * consuming (see readChangedRegisterNames), so this is what holds the answer steady across the
   * several reads a client makes of one stop. Cleared at every resume. */
  private changedRegistersReadAtThisStop = false;

  /**
   * Re-reads the integer registers and works out which moved since the last time this ran.
   *
   * "Which registers did that instruction touch" is the question an assembly debugging session is
   * mostly made of, and nothing else in the UI answers it: VS Code highlights a *row* whose value
   * changed, which requires the group to already be open, and the reason to open a group is usually
   * that you already suspect the answer. The group headers carry it instead (formatChangedSummary),
   * so it is readable with everything collapsed.
   *
   * Called from the Registers scope's own top-level fetch rather than from the stop handler, which
   * makes the cost exactly zero for a session where nobody opens the panel — and two MI commands
   * for a session where somebody does, regardless of how many registers the target has. The
   * comparison is therefore "since the last time this panel was read", which for the case that
   * matters (stepping with it open) is precisely per-step.
   *
   * Two commands rather than one because the two questions genuinely differ. *Which* registers
   * moved comes from gdb (readChangedRegisterNames), which knows about every register class
   * including the ones with no integer reading to diff. *What they held before* has to be kept
   * here, because gdb reports only names and the "previous" row shows a value and a delta.
   */
  private async refreshChangedRegisters(): Promise<void> {
    if (this.changedRegistersReadAtThisStop) return;
    await this.refreshRegisterValuesIfStale();
    // A failed read leaves both snapshots and the diff in place: "the panel could not be read just
    // now" and "nothing changed" are very different claims, and only one of them is true. Left
    // un-consumed too, so the next reader at this stop tries again.
    if (this.registerSnapshot.size === 0) return;
    this.changedRegisterNames = await this.readChangedRegisterNames();
  }

  /**
   * Every register the panel reads as a plain integer, which one batched MI command covers.
   *
   * The SIMD registers are the only exclusion, and not an arbitrary one: asked for a vector
   * register in `x` format gdb answers with a whole struct of lane vectors ("{v8_bfloat16 = {...},
   * v4_float = {...}, ...}") rather than a number, so they go through readVectorRegister instead.
   * Everything else here — including the x87 environment words and the 80-bit stack registers —
   * comes back as one integer literal, verified against gdb 16.3 to be bit-for-bit the same value
   * the per-register cast read produces.
   */
  private scalarRegisterNames(): string[] {
    const groups = this.registerGroups;
    return [
      ...groups.generalPurpose, ...groups.pointers, ...groups.segment,
      ...groups.mask, ...groups.thread, ...groups.x87Control,
      ...(groups.eflagsName ? [groups.eflagsName] : []),
      ...(groups.mxcsrName ? [groups.mxcsrName] : []),
    ];
  }

  /**
   * A scalar register's value at this stop, from the batched snapshot when it holds one.
   *
   * The snapshot was taken by refreshChangedRegisters at the top of this same panel read, from the
   * same stop, so it is not a cache in the sense that can go stale on its own — the program cannot
   * have run in between. The one thing that *can* invalidate it is an in-place edit, which is what
   * registerValuesStale tracks.
   *
   * Falling back to an individual read matters more than the batching does: hover and Watch resolve
   * names the panel never lists (al, r8d, ah), and those are legitimately not in the snapshot.
   */
  private async registerValue(name: string, bits: RegisterBits | undefined): Promise<bigint | undefined> {
    await this.refreshRegisterValuesIfStale();
    return this.registerSnapshot.get(name) ?? this.readRegisterBigInt(name, bits);
  }

  /**
   * Re-reads the batched snapshot when anything may have moved since it was taken.
   *
   * Called from registerValue rather than only from refreshChangedRegisters, and that is the point:
   * a client can fetch a register *group* at a fresh stop without ever fetching the Registers scope
   * that owns it, so the group readers cannot assume anyone has refreshed anything for them.
   *
   * It never asks gdb which registers changed — that question is consuming (see
   * readChangedRegisterNames), and asking it here would throw away the answer belonging to the last
   * actual step, on a path that runs for every group expansion.
   */
  private async refreshRegisterValuesIfStale(): Promise<void> {
    if (!this.registerValuesStale) return;
    const values = await this.readRegisterValues(this.scalarRegisterNames(), 'x');
    // Left stale on a failed read, so the next reader tries again rather than serving values from
    // before whatever just happened.
    if (values.size === 0) return;
    this.registerValuesStale = false;
    // "What it held before the last step" only shifts when there was a step. A refresh triggered by
    // an in-place edit updates what the rows show without rewriting the step history underneath it.
    if (this.inferiorRanSinceSnapshot) {
      this.registerPrevious = this.registerSnapshot;
      this.inferiorRanSinceSnapshot = false;
    }
    this.registerSnapshot = values;
  }

  /**
   * Which registers gdb says have changed since it last answered this question.
   *
   * Asked of gdb rather than diffed here, and that is the whole point: a diff can only cover
   * registers with an integer reading to compare, which silently excluded every register class
   * where "did that instruction touch it" is hardest to answer by eye. gdb's own answer covers all
   * of them — verified against gdb 16.3, where a single `fld` reports st0, fstat and ftag changed,
   * and a `movdqu xmm0` reports xmm0, none of which the old general-purpose-only diff could see.
   *
   * Two properties of this command drive the shape of everything around it, both confirmed against
   * real gdb rather than assumed:
   *
   *  - It is *consuming*. Asking twice in a row returns an empty list the second time, because
   *    answering resets gdb's own baseline. That is why this is reached only through
   *    refreshChangedRegisters' once-per-stop guard, and why its result is cached in
   *    changedRegisterNames rather than re-fetched per group — VS Code reads the panel more than
   *    once at a single stop, and the second read would otherwise report that nothing had moved.
   *  - Reading register *values* does not consume it, so refreshChangedRegisters is free to take
   *    its value snapshot first.
   *
   * The answer is asked for and thrown away at the session's first stop, where gdb reports every
   * register in the target as changed — true, in that they went from unknown to known, and useless
   * as a report of what the last instruction did. Asked for anyway rather than skipped, because not
   * asking would leave that report sitting in gdb to be collected by the next step, which would
   * then appear to have moved the entire machine.
   */
  private async readChangedRegisterNames(): Promise<Set<string>> {
    const changed = new Set<string>();
    if (!this.gdb) return changed;
    const baseline = !this.changedRegistersBaselineTaken;
    this.changedRegistersBaselineTaken = true;
    this.changedRegistersReadAtThisStop = true;
    try {
      const result = await this.gdb.sendCommand('-data-list-changed-registers');
      const numbers = miData(result)?.['changed-registers'];
      if (baseline || !Array.isArray(numbers)) return changed;
      for (const entry of numbers) {
        if (typeof entry !== 'string') continue;
        const name = this.registerGroups.namesByNumber.get(Number(entry));
        if (name !== undefined) changed.add(name);
      }
    } catch {
      // A target that does not implement this leaves every group header without its "changed"
      // note, which is a missing annotation rather than a broken panel.
    }
    return changed;
  }

  /**
   * Those of `names` that moved at the last step, in the order the group displays them.
   *
   * The program counter is deliberately never one of them. It changes at essentially every stop —
   * that is what executing an instruction *is* — so a summary that named it would say "changed:
   * rip" forever, and a marker that is always on is one nobody reads. Its own row still carries
   * what it moved by, where that is a fact about this step rather than a constant.
   */
  private changedAmong(names: readonly string[]): string[] {
    return names.filter(
      (name) =>
        name !== 'rip' &&
        name !== 'eip' &&
        // Matched through every spelling gdb might have reported, since the Vector group displays a
        // pseudo-register whose changes are reported against its raw halves — see
        // changeReportingNames.
        changeReportingNames(name).some((alias) => this.changedRegisterNames.has(alias)),
    );
  }

  /**
   * A group header's value column: whatever the group says about its own state, plus what moved in
   * it at the last step.
   *
   * The two belong together rather than competing for the column. A collapsed Flags group wants to
   * say both "[ ZF PF IF ]" and "and one of those just changed" — the second is what tells a reader
   * scanning a stepped instruction that this group is the one worth opening, and the first is what
   * they came to read once they did.
   */
  private groupHeader(base: string, names: readonly string[]): string {
    const changed = this.changedAmong(names);
    if (changed.length === 0) return base;
    // Naming the register that moved is pointless when the group holds exactly one — the header is
    // already that register's own row.
    const note = names.length === 1 ? 'changed' : formatChangedSummary(changed);
    return base.length === 0 ? note : `${base}  ${note}`;
  }
  /** The in-flight register-set resolution, which the Registers scope waits on before reading
   * anything. Without that wait the *first* stop would race it and render whatever groups the
   * pre-run resolution had found — which is precisely the set missing the vector registers this
   * second resolution exists to discover. Never rejects (resolveRegisterNamesUnsafe swallows its
   * own failures), so awaiting it is unconditionally safe. */
  private registerNamesPending: Promise<void> | undefined;

  /**
   * Asks gdb which registers this target actually has, and groups them (registers.ts).
   *
   * Called twice, and the second call is the one that matters. gdb knows the register set of a
   * loaded binary before it runs, but only *approximately*: the answer at that point comes from the
   * architecture, and the answer after the process starts comes from the process itself, which is
   * where the CPU's actual extensions become visible. On a machine with AVX the pre-run list has
   * xmm0-15 and no ymm registers at all; the post-run list has ymm0-15 and pkru as well. Resolving
   * only at launch — which is all this used to do — therefore hides every AVX register permanently,
   * on hardware that has them, for the whole session.
   *
   * Failure is deliberately silent and non-fatal: the Registers scope showing fewer groups is not a
   * reason to fail a launch, and the pre-run resolution stands if the second one cannot be made.
   */
  private async resolveRegisterNames(): Promise<void> {
    this.registerNamesPending = this.resolveRegisterNamesUnsafe();
    await this.registerNamesPending;
  }

  private async resolveRegisterNamesUnsafe(): Promise<void> {
    try {
      const namesResult = await this.gdb?.sendCommand('-data-list-register-names');
      const rawNames = namesResult === undefined ? undefined : miData(namesResult)?.['register-names'];
      if (Array.isArray(rawNames)) this.registerGroups = resolveRegisterGroups(rawNames as string[]);
    } catch {
      // Leave whatever the previous resolution produced — for the first call that is the empty set,
      // which just means the Registers scope shows nothing rather than failing the whole launch
      // over a view that is secondary to actually running the program.
    }
  }

  private onStopped(data: Record<string, unknown>): void {
    // The first stop is the first moment gdb can describe the *running* process's register set
    // rather than the binary's architecture — and the two differ by every vector extension the CPU
    // has. Fired once and not awaited: nothing in this handler depends on it, and the Registers
    // scope is only read after the StoppedEvent below has reached the client.
    if (!this.registerNamesResolvedWhileRunning) {
      this.registerNamesResolvedWhileRunning = true;
      void this.resolveRegisterNames();
    }

    const reasonRaw = typeof data.reason === 'string' ? data.reason : '';
    if (reasonRaw === 'exited-normally' || reasonRaw.startsWith('exited')) {
      this.sendEvent(new TerminatedEvent());
      return;
    }

    // stepToNextLine's line-granularity loop single-steps the target one machine instruction at a
    // time internally, and each of those is a real gdb stop — gdb reports it exactly the way it
    // reports any other completed step, reason "end-stepping-range" — before the loop decides for
    // itself whether the PC has reached a new mapped line yet or it needs to keep going. Left
    // unfiltered, every one of those intermediate stops reached here too and became its own
    // StoppedEvent, telling the client the program had stopped — and inviting it to re-fetch the
    // call stack, registers and so on — while the loop was already about to send the *next*
    // -exec-step-instruction. Only a program that never calls into anything outside its own listing
    // exercises this: stepping over straight-line syscalls (the Linux templates) almost always
    // reaches a new mapped line on the very first internal step, so the loop runs once and this
    // never came up. Stepping into `invoke SomeWin32Api` dives into a real CALL, and returning from
    // one can take dozens of instructions before the PC is back on a mapped line — dozens of these
    // firing in a burst while another step was already in flight is what left the Registers view
    // blank and every action disabled. stepToNextLine (and stepOneInstruction, for the same reason)
    // sends its own single StoppedEvent once it has actually decided the step is over; this handler
    // only needs to cover stops those loops did not ask for and have no way to notice on their own,
    // so an ordinary step completion is skipped here for exactly as long as one of them is running.
    if (this.stepping && reasonRaw === 'end-stepping-range') return;

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

  /**
   * Which signals should stop the session — the checkboxes in the Breakpoints panel.
   *
   * DAP sends the complete desired set, so a signal absent from `filters` is one to actively turn
   * off rather than one to leave alone. Kept even when there is no gdb yet: this request arrives
   * during the configuration phase, which races the launch that creates the driver, and
   * startTarget replays whatever is here once gdb exists.
   */
  // "BreakPoints", with the capital P the base class spells its dispatch method with — the same
  // spelling as setBreakPointsRequest above. Named the natural way, this compiles, typechecks and
  // is simply never called, leaving the base class's no-op to answer every request: the checkboxes
  // render, respond, and do nothing at all.
  protected async setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): Promise<void> {
    this.enabledSignals = new Set(args.filters ?? []);
    await this.applySignalHandling();
    this.sendResponse(response);
  }

  private enabledSignals = defaultEnabledSignals();

  /** Serializes applySignalHandling — see there for why two of them can be in flight at once. */
  private signalHandlingQueue: Promise<void> = Promise.resolve();

  /**
   * Pushes the current signal choice into gdb.
   *
   * Queued rather than run directly, and reading `this.enabledSignals` when it runs rather than
   * when it is scheduled. Two callers can be in flight at once on a cold start — startTarget
   * replaying the stored choice onto a new gdb, and the client's own setExceptionBreakpoints — and
   * each issues one command per signal. Interleaved, the two runs race per signal and whichever
   * lands last wins, which is not necessarily the one holding the user's actual choice: a stale
   * "stop SIGSEGV" arriving after the request that turned it off leaves the debugger stopping on a
   * signal the user unchecked.
   *
   * Best-effort per command: `handle` is a gdb CLI command that lldb-mi does not have, and a macOS
   * session losing its signal toggles is a far better outcome than one that fails to launch over
   * them. Same reasoning as the `disassembly-flavor` set in startTarget.
   */
  private applySignalHandling(): Promise<void> {
    this.signalHandlingQueue = this.signalHandlingQueue.then(async () => {
      if (!this.gdb) return;
      for (const command of signalHandlingCommands(this.enabledSignals)) {
        await this.gdb.sendCommand(`-interpreter-exec console "${command}"`).catch(() => undefined);
      }
    });
    return this.signalHandlingQueue;
  }

  protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse): void {
    const signal = this.lastSignal;
    response.body = {
      exceptionId: signal?.name ?? 'signal',
      description: signal ? `${signal.name}${signal.meaning ? `: ${signal.meaning}` : ''}` : 'The program stopped on a signal.',
      breakMode: 'always',
      details: {
        message: signal?.meaning ?? '',
        // Left to the Call Stack view rather than duplicated as prose in the exception dialog:
        // this field wants a formatted trace string, and the frames are already on screen beside
        // it with their source lines clickable, which a string here would not be.
        stackTrace: undefined,
      },
    };
    this.sendResponse(response);
  }

  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
    this.sendResponse(response);
    // An attached target is already running (or already dead, for a core) — "-exec-run" here would
    // start a *second*, unrelated copy of the program rather than continuing the one being
    // debugged, which is as wrong as it sounds.
    if (this.mode === 'attach') return;
    try {
      // The program's stdin/stdout have to be pointed at their terminal before it starts, not
      // after — a program that reads on its first instruction would otherwise race the handshake.
      await this.terminalSetup;
      // Registered *before* -exec-run, not after: waitForNextStop subscribes synchronously, and
      // gdb's "^running" acknowledgement and the "*stopped" that follows it can arrive in the same
      // read from the stream — so subscribing after the await can miss the very stop being waited
      // for, leaving recording permanently off on a launch that asked for it.
      const firstStop = this.reverseDebugging ? this.waitForNextStop() : undefined;
      await this.gdb?.sendCommand('-exec-run');
      if (firstStop) void firstStop.then((outcome) => (outcome === 'stopped' ? this.enableRecording() : undefined));
    } catch (err) {
      this.sendEvent(new OutputEvent(`failed to start program: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  /**
   * Whether the target can be resumed or stepped at all. A core dump cannot: it is a snapshot of
   * memory and registers, with no process behind it to run.
   *
   * Answered here rather than left to gdb because gdb's own reply ("The program is not being run")
   * describes a program that failed to start, which is not what happened and sends you looking for
   * a launch problem that doesn't exist.
   */
  private ensureResumable(response: DebugProtocol.Response): boolean {
    if (this.attachTarget?.kind !== 'core') {
      // Every path that resumes the program passes through here first, which makes this the one
      // place "the program is about to execute" can be recorded without each of the eight resume
      // handlers having to remember to. It has to be recorded *synchronously, here* rather than
      // from gdb's own "*running" record, which is what this originally did: the step handlers
      // send their own StoppedEvent as soon as gdb answers "^running" and the stop arrives, so a
      // client can have fetched the whole Registers scope before that async record is even parsed
      // — and the snapshot then compared a stop against itself and reported that nothing had ever
      // changed. (Observed directly: the group headers lagged a step behind, and every second
      // step showed no change at all.)
      //
      // Marking it for a *pause* too is not a miss: the program has been running freely up to the
      // moment it is interrupted, so its registers have moved as surely as after any step.
      this.inferiorRanSinceSnapshot = true;
      // The batched value snapshot is invalidated by the same event, and separately from the
      // change bookkeeping above: a client may fetch a *group* at the next stop without fetching
      // the Registers scope that owns it, which is the only place the change bookkeeping runs. The
      // e2e regression that pinned this down set a register watchpoint, continued, and read the
      // General Purpose group straight from the stop — every row still showing the values from
      // before the continue.
      this.registerValuesStale = true;
      // gdb's "which registers changed" answer belongs to one stop, and the program is about to
      // reach a different one.
      this.changedRegistersReadAtThisStop = false;
      return true;
    }
    this.sendErrorResponse(
      response,
      15,
      'This is a core dump — there is no running process to resume or step. Registers, memory, data labels and the faulting source line can all still be inspected.',
    );
    return false;
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

  /**
   * The call stack — reconstructed here rather than asked of gdb, which reports one frame for a
   * binary with no unwind information however deep the program is (see unwind.ts).
   *
   * Frames are named by the label they are executing inside ("print_hex+0x12"), because that is the
   * answer a fasm reader wants and the only one available: there is no function symbol to name a
   * frame after, and naming every frame after its *file* — which is what the single-frame version
   * did — says nothing once there is more than one.
   */
  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
    const pc = await this.currentPc();
    if (pc === undefined) {
      response.body = { stackFrames: [], totalFrames: 0 };
      this.sendResponse(response);
      return;
    }
    this.frames = await this.unwind(pc);
    const stackFrames = await Promise.all(
      this.frames.map(async (frame, index) => {
        const loc = this.addressMap?.addressToLocation.get(frame.pc);
        // describeAddress only knows the user's own listing — every frame still inside it names
        // itself, same as always. One that isn't (a call into a Windows API, say) used to fall
        // straight to "<unmapped address>", the Call Stack view's own version of the Disassembly
        // View's old wall of "(unavailable)": gdb has a real answer, this just never asked it.
        const label = describeAddress(this.symbolSpans, frame.pc) ?? (await this.foreignSymbolAt(frame.pc));
        const stackFrame = loc
          ? new StackFrame(MAIN_FRAME_ID + index, label ?? `0x${frame.pc.toString(16)}`, new Source(path.basename(loc.fsPath), loc.fsPath), loc.line)
          : new StackFrame(MAIN_FRAME_ID + index, label ?? `0x${frame.pc.toString(16)} <unmapped address>`);
        // Needed even when `loc` resolved fine: this is what tells VS Code a Disassembly View exists
        // for this frame at all (the "Open Disassembly View" affordance), not just what backs it once
        // opened.
        stackFrame.instructionPointerReference = `0x${frame.pc.toString(16)}`;
        // A caller frame is shown at the instruction it will *return to*, which is the one after its
        // call — so the source line highlighted for it is the line after the one that called. Saying
        // "subtle" here would be underselling it: this is the one place the frame list can mislead,
        // and DAP has no field that means "this frame is mid-call".
        if (index > 0) stackFrame.presentationHint = 'subtle';
        return stackFrame;
      }),
    );
    response.body = { stackFrames, totalFrames: stackFrames.length };
    this.sendResponse(response);
  }

  /** gdb's own "module!function+offset" for `address`, the Call Stack equivalent of what
   * toDisassembledInstruction already does for the Disassembly View — used only once
   * describeAddress (this file's own listing-derived symbols) has nothing, i.e. exactly the
   * frames that otherwise render as a bare "<unmapped address>". A 1-byte window is enough:
   * "-data-disassemble" always decodes the *whole* instruction starting at its own start address
   * regardless of how short a range it's asked for (see disassembleAround's own reasoning), and
   * only that first instruction's symbol is wanted here. */
  private async foreignSymbolAt(address: bigint): Promise<string | undefined> {
    try {
      const [first] = await this.disassembleRawRange(address, address + 1n);
      if (!first?.funcName) return undefined;
      return first.funcOffset ? `${first.funcName}+0x${first.funcOffset.toString(16)}` : first.funcName;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the stack once and hands it to the unwinder.
   *
   * One memory read for the whole backtrace, sized by UNWIND_STACK_BYTES rather than by the Stack
   * group's own (user-configurable, usually much smaller) depth: a chain walk that runs off the end
   * of the window stops there, so the window is what bounds how deep a backtrace can go.
   */
  private async unwind(pc: bigint): Promise<UnwoundFrame[]> {
    const spName = this.stackPointerName();
    const bits = spName === undefined ? undefined : REGISTER_WIDTH_BITS[spName];
    const sp = spName === undefined ? undefined : await this.registerValue(spName, bits);
    if (spName === undefined || bits === undefined || sp === undefined) return [{ pc, via: 'stop' }];

    const wordBytes = bits / 8;
    const bytes = await this.readMemoryBytes(`0x${sp.toString(16)}`, UNWIND_STACK_BYTES);
    if (!bytes) return [{ pc, via: 'stop' }];
    const values = decodeLittleEndianElements(bytes, wordBytes, Math.floor(bytes.length / wordBytes));
    const stack = values.map((value, i) => ({ address: sp + BigInt(i * wordBytes), value }));

    const bpName = this.framePointerName();
    return unwindStack({
      pc,
      stackPointer: sp,
      framePointer: bpName === undefined ? undefined : await this.registerValue(bpName, REGISTER_WIDTH_BITS[bpName]),
      wordBytes,
      stack,
      isReturnSite: (address) => this.returnSites.has(address),
      maxFrames: MAX_UNWOUND_FRAMES,
    });
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

    // "-data-disassemble" always decodes whole instructions even past its own end address (an
    // instruction straddling the boundary is still returned in full), so over-fetching a
    // generous byte window is free and never risks a truncated instruction the way trying to
    // compute an exact byte length up front could.
    const instructionsPastTarget = Math.max(0, instructionOffset + instructionCount);
    const windowBytes = Math.min((instructionsPastTarget + 8) * MAX_X86_INSTRUCTION_BYTES, MAX_DISASSEMBLE_WINDOW_BYTES);
    const endAddr = target + BigInt(windowBytes);

    if (instructionOffset < 0) {
      const known = this.nearestKnownAddressAtOrBefore(target);
      // A listing-derived anchor exists for every address at all, by construction — sortedAddresses
      // holds every address fasm2's own listing ever mapped, so the binary search always returns
      // *something* once the target is past the first one. What it does not guarantee is that the
      // anchor is anywhere *near* target: once target leaves the user's own program entirely (a
      // step into a Windows API call, say), "nearest mapped address <= target" degrades to "the
      // last address the user's own program has", which can be gigabytes below a system DLL's own
      // address range. Disassembling everything in between is exactly what failed here, confirmed
      // against a real `invoke GetStdHandle`: gdb reported "Cannot access memory" partway through
      // the gap, well short of ever reaching target, and the *whole* page came back as a wall of
      // "(unavailable)" over one bad address far from anything being looked at.
      if (known !== undefined && target - known <= BigInt(MAX_DISASSEMBLE_WINDOW_BYTES)) {
        const insns = await this.tryDisassembleThrough(known, endAddr, target);
        if (insns) return this.instructionsAroundTarget(insns, target, instructionOffset, instructionCount);
      } else {
        // No real boundary nearby — estimate one instead of giving up on "before" context
        // entirely. Backing up `|instructionOffset|` instructions' worth of the longest possible
        // x86 encoding overshoots the real distance in the ordinary case (average instruction
        // length is well under half of that), so the decode almost always has several real
        // instructions of margin before it ever needs to reach target — and even where the
        // estimated start doesn't land exactly on a boundary, x86 decoding resynchronizes quickly
        // (a misaligned start reliably hits an invalid opcode within a few bytes and gets skipped),
        // so everything from a handful of instructions before target onward still comes out
        // correct. Shrinks and retries on failure (unmapped memory just past a module's own base
        // address is a real possibility an estimate can walk into), down to no backward context at
        // all rather than ever falling through to a page of placeholders target itself doesn't need.
        for (let backBytes = Math.abs(instructionOffset) * MAX_X86_INSTRUCTION_BYTES; backBytes > 0; backBytes = Math.floor(backBytes / 2)) {
          const insns = await this.tryDisassembleThrough(target - BigInt(backBytes), endAddr, target);
          if (insns) return this.instructionsAroundTarget(insns, target, instructionOffset, instructionCount);
        }
      }
    }

    // instructionOffset >= 0 (no "before" context asked for at all), or every attempt above failed
    // to even reach target — which is, itself, always safe to start from: it's where the program
    // actually is right now, so it is by definition mapped, executable memory.
    const insns = await this.tryDisassembleThrough(target, endAddr, target);
    return insns ? this.instructionsAroundTarget(insns, target, instructionOffset, instructionCount) : this.placeholderRun(target, instructionOffset, instructionCount);
  }

  /** Disassembles `anchor`..`endAddr` and hands it back only if `target` actually turned up in it —
   * gdb hitting unmapped/unreadable memory partway through a range throws, and a range that never
   * reaches target at all (an anchor estimate that undershot) is just as useless to a caller that
   * only ever wants instructions located *relative to target*. Either way, undefined rather than a
   * thrown error: every caller here has a fallback of its own to move on to. */
  private async tryDisassembleThrough(
    anchor: bigint,
    endAddr: bigint,
    target: bigint,
  ): Promise<Array<{ address: bigint; opcodes?: string; inst?: string; funcName?: string; funcOffset?: number }> | undefined> {
    try {
      const insns = await this.disassembleRawRange(anchor, endAddr);
      return insns.some((insn) => insn.address === target) ? insns : undefined;
    } catch {
      return undefined;
    }
  }

  /** Slices `instructionCount` instructions starting `instructionOffset` away from wherever `target`
   * actually landed in `insns` — the shared second half of every disassembleAround path once it has
   * a decoded window that actually contains target. */
  private instructionsAroundTarget(
    insns: Array<{ address: bigint; opcodes?: string; inst?: string; funcName?: string; funcOffset?: number }>,
    target: bigint,
    instructionOffset: number,
    instructionCount: number,
  ): DebugProtocol.DisassembledInstruction[] {
    const targetIdx = insns.findIndex((insn) => insn.address === target);
    const startIdx = targetIdx + instructionOffset;
    const out: DebugProtocol.DisassembledInstruction[] = [];
    for (let i = 0; i < instructionCount; i++) {
      const insn = insns[startIdx + i];
      out.push(insn ? this.toDisassembledInstruction(insn) : this.placeholderInstruction(target + BigInt(startIdx + i - targetIdx)));
    }
    return out;
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
   * toDisassembledInstruction). "func-name"/"offset" are gdb's own symbol lookup, used the same way
   * — the Disassembly View's only source of *any* context for code the listing never mapped, e.g. a
   * step into a Windows API call. Never throws on a malformed individual entry; skips it instead,
   * the same defensive posture as every other MI-result parser in this file. */
  private async disassembleRawRange(
    startAddr: bigint,
    endAddr: bigint,
  ): Promise<Array<{ address: bigint; opcodes?: string; inst?: string; funcName?: string; funcOffset?: number }>> {
    if (!this.gdb) return [];
    const result = await this.gdb.sendCommand(`-data-disassemble -s 0x${startAddr.toString(16)} -e 0x${endAddr.toString(16)} -- 2`);
    const raw = miData(result)?.['asm_insns'];
    if (!Array.isArray(raw)) return [];

    const out: Array<{ address: bigint; opcodes?: string; inst?: string; funcName?: string; funcOffset?: number }> = [];
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
      // gdb reports offset as a decimal string ("0", "7", …) — /^\d+$/ rather than a bare Number()
      // check so a malformed or hex-looking value never silently becomes NaN-as-0.
      const offsetStr = rec.offset;
      out.push({
        address,
        opcodes: typeof rec.opcodes === 'string' ? rec.opcodes : undefined,
        inst: typeof rec.inst === 'string' ? rec.inst : undefined,
        funcName: typeof rec['func-name'] === 'string' ? rec['func-name'] : undefined,
        funcOffset: typeof offsetStr === 'string' && /^\d+$/.test(offsetStr) ? Number(offsetStr) : undefined,
      });
    }
    return out;
  }

  /** A real, gdb-decoded instruction — annotated with this file's own listing-derived source
   * location when one exists at that exact address (the first instruction of a mapped line or
   * macro invocation), so the Disassembly View shows which FASM source line each instruction
   * belongs to, not just raw bytes. Falls back to gdb's own symbol lookup (module!function, +offset
   * past its first instruction) when there is no such location — code the listing never emitted,
   * same case disassembleAround's own fallback anchor exists for — so a step into a Windows API
   * call reads as "KERNEL32!GetStdHandle+0x7" instead of a bare, contextless address. */
  private toDisassembledInstruction(insn: { address: bigint; opcodes?: string; inst?: string; funcName?: string; funcOffset?: number }): DebugProtocol.DisassembledInstruction {
    const loc = this.addressMap?.addressToLocation.get(insn.address);
    const out: DebugProtocol.DisassembledInstruction = {
      address: `0x${insn.address.toString(16)}`,
      instruction: insn.inst ?? '(unknown)',
    };
    if (insn.opcodes) out.instructionBytes = insn.opcodes.trim().replace(/\s+/g, ' ');
    if (loc) {
      out.location = new Source(path.basename(loc.fsPath), loc.fsPath);
      out.line = loc.line;
    } else if (insn.funcName) {
      out.symbol = insn.funcOffset ? `${insn.funcName}+0x${insn.funcOffset.toString(16)}` : insn.funcName;
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

    if (kind.startsWith('registers')) await this.registerNamesPending;

    if (kind === 'registers') {
      const groups = this.registerGroups;
      await this.refreshChangedRegisters();
      const variables: Variable[] = [];
      if (groups.generalPurpose.length > 0) {
        const v = this.registerGroupVariable('General Purpose', 'registers:gp');
        v.value = this.groupHeader('', groups.generalPurpose);
        variables.push(v);
      }
      if (groups.pointers.length > 0) {
        const v = this.registerGroupVariable('Pointers', 'registers:pointers');
        v.value = this.groupHeader('', groups.pointers);
        variables.push(v);
      }
      // Directly under Pointers, because it is the same question continued: rsp says where the
      // stack is, and this says what is in it.
      if (this.stackPointerName() !== undefined) variables.push(this.registerGroupVariable('Stack', 'registers:stack'));
      if (groups.eflagsName) {
        const value = await this.registerValue(groups.eflagsName, REGISTER_WIDTH_BITS[groups.eflagsName]);
        const v = this.registerGroupVariable('Flags', 'registers:flags');
        // The set flags, not the number: "[ ZF PF IF ]" is the whole reason to glance at this row,
        // and a group header is the one place with no name column to compete with.
        v.value = value === undefined ? '<unavailable>' : this.groupHeader(formatEflagsSummary(value), [groups.eflagsName]);
        variables.push(v);
      }
      if (groups.vector.length > 0) {
        // Named for what the program calls them rather than for the widest one present: someone
        // writing `movaps xmm0, ...` is looking for SSE, and would not think to open a group called
        // "ZMM" to find it.
        const widest = VECTOR_WIDTH_BITS[groups.vector[0]];
        const label = widest === 512 ? 'Vector (SSE/AVX/AVX-512)' : widest === 256 ? 'Vector (SSE/AVX)' : 'Vector (SSE)';
        const v = this.registerGroupVariable(label, 'registers:vector');
        v.value = this.groupHeader(`${groups.vector.length} x ${widest}-bit`, groups.vector);
        variables.push(v);
      }
      if (groups.mxcsrName) {
        const value = await this.registerValue(groups.mxcsrName, PSEUDO_REGISTER_WIDTH_BITS[groups.mxcsrName]);
        const v = this.registerGroupVariable('MXCSR', 'registers:mxcsr');
        v.value = value === undefined ? '<unavailable>' : this.groupHeader(formatBitFieldSummary(decodeMxcsr(value)), [groups.mxcsrName]);
        variables.push(v);
      }
      if (groups.x87.length > 0 || groups.x87Control.length > 0) {
        const v = this.registerGroupVariable('x87 FPU', 'registers:x87');
        // TOP is what makes st0 mean a particular physical register, so it belongs on the header:
        // it is the one number that changes what every row underneath is naming.
        const status = await this.registerValue('fstat', PSEUDO_REGISTER_WIDTH_BITS['fstat']);
        let base = '';
        if (status !== undefined) {
          const decoded = decodeX87Status(status);
          const top = decoded.find((f) => f.name === 'TOP');
          if (top) base = `st0 = R${top.value}  ${formatBitFieldSummary(decoded.filter((f) => f.name !== 'TOP'))}`;
        }
        // The stack registers only. fstat and ftag move on *every* x87 instruction (TOP rotates, the
        // tag word follows it), so including the environment words here would mark the group changed
        // whenever it was touched at all — which is the same as never marking it.
        v.value = this.groupHeader(base, groups.x87);
        variables.push(v);
      }
      if (groups.mask.length > 0) {
        const v = this.registerGroupVariable('Mask (AVX-512)', 'registers:mask');
        v.value = this.groupHeader('', groups.mask);
        variables.push(v);
      }
      if (groups.thread.length > 0) {
        const v = this.registerGroupVariable('Thread / Syscall', 'registers:thread');
        v.value = this.groupHeader('', groups.thread);
        variables.push(v);
      }
      if (groups.segment.length > 0) {
        const v = this.registerGroupVariable('Segment', 'registers:segment');
        v.value = this.groupHeader('', groups.segment);
        variables.push(v);
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:mask') {
      const variables: DebugProtocol.Variable[] = [];
      for (const name of this.registerGroups.mask) {
        variables.push(
          await this.registerVariable(name, {
            // A mask register holds one bit per vector lane. It is not an address, so annotating it
            // with whatever label happens to sit at 0xff would point nowhere real; it is not packed
            // text either; and a decimal reading of a bit pattern is the column formatRegisterValue-
            // Compact's own `decimal: false` exists for.
            address: false,
            ascii: false,
            decimal: false,
            suffix: async (value) => formatMaskRegister(value),
          }),
        );
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:gp' || kind === 'registers:pointers') {
      const names = kind === 'registers:gp' ? this.registerGroups.generalPurpose : this.registerGroups.pointers;
      const variables: DebugProtocol.Variable[] = [];
      for (const name of names) {
        variables.push(
          await this.registerVariable(name, {
            address: true,
            ascii: true,
            // The program counter is the one register whose value has a better reading than any
            // number: the instruction it is about to execute. One disassembly round-trip, on the
            // row where nothing else answers the question being asked.
            suffix: name === 'rip' || name === 'eip' ? (value) => this.instructionTextAt(value) : undefined,
          }),
        );
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:segment') {
      const variables: DebugProtocol.Variable[] = [];
      for (const name of this.registerGroups.segment) {
        variables.push(
          await this.registerVariable(name, {
            // A selector (0x33) is a descriptor-table index, not an address and not data:
            // annotating it with the label that happens to sit at 0x33, or offering to open a
            // memory view there, would only ever point somewhere meaningless.
            address: false,
            ascii: false,
            decimal: false,
            suffix: async (value) => {
              const parts = [formatSegmentSelector(value)];
              // fs and gs are the two whose selector is not the interesting half. In 64-bit mode
              // the selector is ignored for addressing entirely and the *base* is what `[fs:0x28]`
              // actually reads from — so a row saying only "fs = 0x0" is hiding the answer.
              const base = await this.segmentBase(name);
              if (base !== undefined) parts.push(`base 0x${base.toString(16)}`);
              return parts.join('  ');
            },
          }),
        );
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:vector') {
      response.body = { variables: await this.vectorGroupVariables() };
      this.sendResponse(response);
      return;
    }

    if (kind.startsWith('registers:vec:')) {
      response.body = { variables: await this.vectorDetailVariables(kind.slice('registers:vec:'.length)) };
      this.sendResponse(response);
      return;
    }

    if (kind.startsWith('registers:lanes:')) {
      const [name, laneKind] = kind.slice('registers:lanes:'.length).split(':');
      response.body = { variables: await this.vectorLaneVariables(name, laneKind) };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:x87') {
      response.body = { variables: await this.x87GroupVariables() };
      this.sendResponse(response);
      return;
    }

    if (kind.startsWith('registers:st:')) {
      response.body = { variables: await this.x87DetailVariables(kind.slice('registers:st:'.length)) };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:mxcsr') {
      const name = this.registerGroups.mxcsrName;
      const raw = name === undefined ? undefined : await this.registerValue(name, PSEUDO_REGISTER_WIDTH_BITS[name]);
      const variables: DebugProtocol.Variable[] = [];
      if (name !== undefined && raw !== undefined) {
        variables.push(this.wholeWordVariable(name, PSEUDO_REGISTER_WIDTH_BITS[name], raw));
        variables.push(...FasmDebugSession.bitFieldVariables(decodeMxcsr(raw)));
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind.startsWith('registers:word:')) {
      response.body = { variables: await this.controlWordVariables(kind.slice('registers:word:'.length)) };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:thread') {
      response.body = { variables: await this.threadGroupVariables() };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:stack') {
      response.body = { variables: await this.stackVariables() };
      this.sendResponse(response);
      return;
    }

    if (kind.startsWith('registers:reg:')) {
      response.body = { variables: await this.registerDetailVariables(kind.slice('registers:reg:'.length)) };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:flags') {
      const eflagsName = this.registerGroups.eflagsName;
      const bits = eflagsName ? REGISTER_WIDTH_BITS[eflagsName] : undefined;
      const raw = eflagsName ? await this.registerValue(eflagsName, bits) : undefined;
      const variables: DebugProtocol.Variable[] = [];
      if (eflagsName !== undefined && bits !== undefined && raw !== undefined) {
        // The register itself, first: it is the only row here that can actually be *written*
        // (gdb can set eflags as a whole; it has no way to set one bit in isolation), and without
        // it there was no way to reach the raw value at all from the panel.
        const whole: DebugProtocol.Variable = new Variable(eflagsName, formatRegisterValueCompact(bits, raw, { decimal: false }), this.variableHandles.create(`registers:reg:${eflagsName}`));
        whole.evaluateName = eflagsName;
        whole.type = `${bits}-bit register`;
        variables.push(whole);

        // Which jumps would be taken is the question the flags are read *for* — see
        // evaluateJumpConditions. Its own row lists the taken ones; expanding shows every condition
        // with the flag test that decided it.
        const conditions = evaluateJumpConditions(raw, await this.counterState());
        const taken: DebugProtocol.Variable = new Variable(
          'Conditions',
          conditions.filter((c) => c.taken).map((c) => c.mnemonics.split(' / ')[0]).join(', '),
          this.variableHandles.create('registers:flags:conditions'),
        );
        taken.type = 'Which conditional branches would be taken if one were executed right now. The same conditions govern cmovcc and setcc — a cmovg moves exactly when a jg would jump.';
        taken.presentationHint = { kind: 'data', attributes: ['readOnly'] };
        variables.push(taken);

        variables.push(...FasmDebugSession.bitFieldVariables(decodeEflags(raw)));
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    if (kind === 'registers:flags:conditions') {
      const eflagsName = this.registerGroups.eflagsName;
      const raw = eflagsName ? await this.registerValue(eflagsName, REGISTER_WIDTH_BITS[eflagsName]) : undefined;
      const variables: DebugProtocol.Variable[] = [];
      if (raw !== undefined) {
        for (const condition of evaluateJumpConditions(raw, await this.counterState())) {
          const v: DebugProtocol.Variable = new Variable(condition.mnemonics, condition.taken ? 'taken' : 'not taken');
          v.type = condition.meaning;
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
            // "[3]" is already the row's name — the value column only has to carry the value.
            variables.push(new Variable(`[${i}]`, formatRegisterValueCompact(bits, value)));
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

  /** Whether the connected target actually reports this register — the groups are built from gdb's
   * own "-data-list-register-names" for the loaded binary, so this is architecture-correct rather
   * than a 64-bit guess (a 32-bit target has no rax to be asked about). */
  private targetHasRegister(name: string): boolean {
    return this.registerGroups.generalPurpose.includes(name) || this.registerGroups.pointers.includes(name);
  }

  private registerGroupVariable(label: string, handleKey: string): Variable {
    return new Variable(label, '', this.variableHandles.create(handleKey));
  }

  /** Which register holds the stack pointer on this target, or undefined before gdb has reported
   * its register set (the Registers scope is read after a stop, by which point it always has). */
  private stackPointerName(): string | undefined {
    return this.registerGroups.pointers.find((name) => name === 'rsp' || name === 'esp');
  }

  /** Which register holds the frame pointer, if this target has one. Only a *convention* in
   * assembly — nothing obliges a fasm program to maintain rbp as a frame pointer — which is why the
   * unwinder validates the chain it finds rather than trusting it (see walkFramePointers). */
  private framePointerName(): string | undefined {
    return this.registerGroups.pointers.find((name) => name === 'rbp' || name === 'ebp');
  }

  /** The counter register and what it holds, for the `loop`/`jrcxz` conditions the flags alone
   * cannot answer (see counterConditions). Undefined when the target reports no counter register
   * or the read fails — which drops those four rows rather than failing the whole Flags group. */
  private async counterState(): Promise<CounterState | undefined> {
    const name = this.registerGroups.generalPurpose.find((n) => n === 'rcx' || n === 'ecx');
    const bits = name === undefined ? undefined : REGISTER_WIDTH_BITS[name];
    const value = name === undefined ? undefined : await this.registerValue(name, bits);
    if (name === undefined || bits === undefined || value === undefined) return undefined;
    return { name, value, bits };
  }

  /** Which of the two Linux syscall conventions this target uses. Decided by the register set gdb
   * reported rather than by the host: a 32-bit binary debugged on a 64-bit machine makes i386
   * syscalls, and numbering it as x86-64 would name every call wrong. */
  private syscallAbi(): SyscallAbi {
    return this.registerGroups.generalPurpose.includes('rax') ? 'x86_64' : 'i386';
  }

  /** The instruction at `address`, as one short line ready to sit at the end of a register row.
   * Undefined when gdb cannot decode there — an unmapped address, or a program that has not
   * started — which is a perfectly ordinary answer and not worth a row saying so. */
  private async instructionTextAt(address: bigint): Promise<string | undefined> {
    if (address === 0n) return undefined;
    try {
      const [first] = await this.disassembleRawRange(address, address + BigInt(MAX_X86_INSTRUCTION_BYTES));
      // gdb pads its own mnemonic column ("mov    rdi,rsp") for a fixed-width listing; a row that
      // is already carrying two other columns wants it collapsed, and a comma-space is how fasm
      // itself would have written the operands.
      return first?.inst?.trim().replace(/\s+/g, ' ').replace(/,(?=\S)/g, ', ');
    } catch {
      return undefined;
    }
  }

  /** The base address behind a segment register, for the two that have one on x86-64. Undefined for
   * cs/ss/ds/es (whose base is architecturally zero in long mode, so there is nothing to say) and on
   * any target that does not report the base pseudo-registers at all. */
  private async segmentBase(segmentName: string): Promise<bigint | undefined> {
    const baseName = `${segmentName}_base`;
    if (!this.registerGroups.thread.includes(baseName)) return undefined;
    return this.registerValue(baseName, PSEUDO_REGISTER_WIDTH_BITS[baseName]);
  }

  /** One decoded bit or field of a control/status word as a read-only row. Read-only because the
   * hardware offers no way to write one: gdb can set eflags or mxcsr as a whole, never a single bit
   * of either, and a row that accepted an edit it could not perform would be lying. */
  private static bitFieldVariables(decoded: readonly DecodedBitField[]): DebugProtocol.Variable[] {
    return decoded.map((field) => {
      // "1  set" rather than a bare "1": scanning a column of sixteen zeroes and ones for the one
      // that changed is exactly the work the word does for free. A multi-bit field says what its
      // value means instead, which is the only reading of "RC = 3" that helps.
      const text = field.meaning !== undefined ? `${field.value}  ${field.meaning}` : `${field.value}  ${field.value ? 'set' : 'clear'}`;
      const v: DebugProtocol.Variable = new Variable(field.name, text);
      v.type = field.description;
      v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
      return v;
    });
  }

  /** The whole control/status register as its own row above the decoded bits — the only row in such
   * a group that can actually be written, and without it the raw value would not be reachable from
   * the panel at all. */
  private wholeWordVariable(name: string, bits: RegisterBits, value: bigint): DebugProtocol.Variable {
    const v: DebugProtocol.Variable = new Variable(name, formatRegisterValueCompact(bits, value, { decimal: false }), this.variableHandles.create(`registers:reg:${name}`));
    v.evaluateName = name;
    v.type = `${bits}-bit register`;
    return v;
  }

  /** The Vector group's rows: one per SIMD register, at the widest name this target reports it by. */
  private async vectorGroupVariables(): Promise<DebugProtocol.Variable[]> {
    const variables: DebugProtocol.Variable[] = [];
    for (const name of this.registerGroups.vector) {
      const bits = VECTOR_WIDTH_BITS[name];
      const value = await this.readVectorRegister(name, bits);
      if (value === undefined) {
        const unavailable: DebugProtocol.Variable = new Variable(name, '<unavailable>');
        unavailable.evaluateName = name;
        variables.push(unavailable);
        continue;
      }
      const v: DebugProtocol.Variable = new Variable(name, formatVectorValueCompact(bits, value), this.variableHandles.create(`registers:vec:${name}`));
      v.evaluateName = name;
      v.type = `${bits}-bit vector register`;
      variables.push(v);
    }
    return variables;
  }

  /** The children of one vector register: every lane reading of the bits it holds, plus its
   * narrower aliases. All derived from the single value already read — expanding the whole group
   * costs exactly one gdb round-trip per register and nothing further. */
  private async vectorDetailVariables(name: string): Promise<DebugProtocol.Variable[]> {
    const bits = VECTOR_WIDTH_BITS[name];
    const value = bits === undefined ? undefined : await this.readVectorRegister(name, bits);
    if (value === undefined || bits === undefined) return [];

    const variables: DebugProtocol.Variable[] = [
      this.readOnlyVariable('hex', formatHexPadded(bits, value), "Zero-padded to the register's full width."),
    ];

    for (const group of vectorLaneGroups(bits, value)) {
      // The lanes go on the row itself when they fit, which for the wide-lane readings is where
      // they are actually useful — "2 x double  3.14, -1" needs no expanding. The narrow ones
      // (thirty-two bytes) would overflow any row, so those become children.
      const inline = group.lanes.join(', ');
      const v: DebugProtocol.Variable =
        inline.length <= 60
          ? new Variable(group.label, inline)
          : new Variable(group.label, `${group.lanes.length} lanes`, this.variableHandles.create(`registers:lanes:${name}:${group.kind}`));
      v.type = group.description;
      v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
      variables.push(v);
    }

    const text = packedAsciiText(bits, value);
    if (text !== undefined) variables.push(this.readOnlyVariable('as text', `'${text}'`, 'Every byte of this register is printable text.'));

    for (const sub of vectorSubRegisterViews(name, value)) {
      const v: DebugProtocol.Variable = new Variable(sub.name, formatVectorValueCompact(sub.bits, sub.value), this.variableHandles.create(`registers:vec:${sub.name}`));
      v.evaluateName = sub.name;
      v.type = `${sub.bits}-bit view of ${name}`;
      variables.push(v);
    }
    return variables;
  }

  /** One row per lane, for a lane reading too wide to sit on its parent's row. */
  private async vectorLaneVariables(name: string, laneKind: string): Promise<DebugProtocol.Variable[]> {
    const bits = VECTOR_WIDTH_BITS[name];
    const value = bits === undefined ? undefined : await this.readVectorRegister(name, bits);
    if (value === undefined || bits === undefined) return [];
    const group = vectorLaneGroups(bits, value).find((g) => g.kind === laneKind);
    // "[0]" is already the row's name, and lane 0 is the *low* end of the register — the opposite
    // end from where it sits when reading the hex, which the group's own description says.
    return (group?.lanes ?? []).map((lane, i) => this.readOnlyVariable(`[${i}]`, lane));
  }

  /**
   * Reads a whole SIMD register as one unsigned integer.
   *
   * Through its 64-bit lanes rather than gdb's own `uint128` field, because that field only exists
   * on the 128-bit registers — a ymm has no `uint256` — and one code path that works at every width
   * beats a special case per width. gdb prints the lane vector in one go ("{1234605616436508552,
   * -2}"), so this is a single round-trip regardless of how wide the register is. The lanes come
   * back *signed*, which is why each is wrapped back to its unsigned bit pattern before being
   * shifted into place.
   */
  private async readVectorRegister(name: string, bits: VectorBits): Promise<bigint | undefined> {
    if (!this.gdb) return undefined;
    try {
      const laneCount = bits / 64;
      const result = await this.gdb.sendCommand(`-data-evaluate-expression "$${name}.v${laneCount}_int64"`);
      const raw = miData(result)?.value;
      if (typeof raw !== 'string') return undefined;
      const lanes = raw.replace(/[{}]/g, '').split(',').map((part) => part.trim());
      if (lanes.length !== laneCount) return undefined;
      let value = 0n;
      for (let i = 0; i < laneCount; i++) {
        if (!/^-?\d+$/.test(lanes[i])) return undefined;
        value |= (BigInt(lanes[i]) & 0xffffffffffffffffn) << BigInt(i * 64);
      }
      return value;
    } catch {
      return undefined;
    }
  }

  /**
   * The x87 group's rows: the eight stack registers, then the environment words.
   *
   * Both batched reads are one MI command each for all eight registers, which is what makes
   * expanding this group cost two round-trips instead of sixteen. The raw form has to come from
   * "-data-list-register-values" (and therefore from gdb's own register *numbers*) because there is
   * no expression that asks for it: `-data-evaluate-expression "$st0"` gives the decimal reading
   * only, and the `/x` format that would change that is a console-command feature the MI
   * expression evaluator rejects outright.
   */
  private async x87GroupVariables(): Promise<DebugProtocol.Variable[]> {
    const names = this.registerGroups.x87;
    const [raws, decimals] = await Promise.all([this.readRegisterValues(names, 'x'), this.readRegisterValues(names, 'N')]);
    // Which physical register st0 currently names — the whole reason the tag word cannot be read
    // as "st0's tag is at index 0".
    const status = await this.registerValue('fstat', PSEUDO_REGISTER_WIDTH_BITS['fstat']);
    const tagWord = await this.registerValue('ftag', PSEUDO_REGISTER_WIDTH_BITS['ftag']);
    const top = status === undefined ? undefined : decodeX87Status(status).find((f) => f.name === 'TOP')?.value;
    const tags = tagWord === undefined ? undefined : decodeX87Tags(tagWord);

    const variables: DebugProtocol.Variable[] = [];
    names.forEach((name, index) => {
      const raw = raws.get(name);
      const decimal = decimals.get(name);
      if (raw === undefined) {
        variables.push(new Variable(name, '<unavailable>'));
        return;
      }
      // An empty register still holds bits, and they still read as a plausible number — so the tag
      // is the only thing that distinguishes "this is the value you pushed" from "this is whatever
      // was here before". Saying so is the entire point of showing it.
      const physical = top === undefined ? undefined : (top + index) % 8;
      const tag = physical === undefined ? undefined : tags?.[physical].state;
      const parts = [tag === 'empty' ? '<empty>' : (decimal ?? formatHexPadded(80, raw))];
      if (tag !== undefined && tag !== 'empty') parts.push(`(${tag})`);
      const v: DebugProtocol.Variable = new Variable(name, parts.join('  '), this.variableHandles.create(`registers:st:${name}`));
      v.evaluateName = name;
      v.type = physical === undefined ? '80-bit x87 register' : `80-bit x87 register — currently physical register R${physical}`;
      variables.push(v);
    });

    for (const name of this.registerGroups.x87Control) {
      const bits = PSEUDO_REGISTER_WIDTH_BITS[name];
      const value = await this.registerValue(name, bits);
      if (value === undefined) continue;
      const decoded = name === 'fctrl' ? decodeX87Control(value) : name === 'fstat' ? decodeX87Status(value) : undefined;
      // Every one of these is a bit pattern rather than a quantity, tag word and opcode included.
      const hex = formatRegisterValueCompact(bits, value, { decimal: false });
      const v: DebugProtocol.Variable = new Variable(
        name,
        decoded ? `${hex}  ${formatBitFieldSummary(decoded)}` : hex,
        this.variableHandles.create(`registers:word:${name}`),
      );
      v.evaluateName = name;
      v.type = X87_CONTROL_DESCRIPTIONS[name] ?? `${bits}-bit register`;
      variables.push(v);
    }
    return variables;
  }

  /** The children of one x87 stack register: the bit fields of the 80-bit extended format, which
   * are the only place the states that actually cause trouble (an unnormal, a signaling NaN, a
   * pseudo-infinity) are visible at all — every one of them prints as an ordinary decimal. */
  private async x87DetailVariables(name: string): Promise<DebugProtocol.Variable[]> {
    const [raws, decimals] = await Promise.all([this.readRegisterValues([name], 'x'), this.readRegisterValues([name], 'N')]);
    const raw = raws.get(name);
    if (raw === undefined) return [];
    const decoded = decodeExtendedFloat(raw);
    const variables: DebugProtocol.Variable[] = [
      this.readOnlyVariable('value', decimals.get(name) ?? '<unavailable>', "gdb's own exact decimal reading — an 80-bit significand does not fit in the 53 bits a double has, so this is the one column not recomputed here."),
      this.readOnlyVariable('class', decoded.classification, 'Which of the extended format\'s value classes these bits encode. "unsupported" means an encoding no FPU since the 387 can produce, so something wrote raw bytes over the x87 state.'),
      this.readOnlyVariable('hex', formatHexPadded(80, raw), 'All 80 bits: sign, 15-bit exponent, 64-bit significand.'),
      this.readOnlyVariable('sign', decoded.negative ? '1  negative' : '0  positive'),
      this.readOnlyVariable(
        'exponent',
        decoded.exponent === undefined ? `0x${decoded.biasedExponent.toString(16)}  (no scale)` : `2^${decoded.exponent}  (biased 0x${decoded.biasedExponent.toString(16)})`,
        'Stored biased by 16383; the unbiased power of two is what the value is actually scaled by.',
      ),
      this.readOnlyVariable(
        'significand',
        `0x${decoded.significand.toString(16).padStart(16, '0')}`,
        'x87 is the one IEEE format that stores the leading integer bit rather than implying it — which is why it has states no other format does.',
      ),
      this.readOnlyVariable('integer bit', decoded.integerBit ? '1  set' : '0  clear', 'Clear at a non-zero exponent means an unnormal: a value no current FPU can produce.'),
    ];
    return variables;
  }

  /** The children of one x87 environment word — its decoded fields, plus the tag states when the
   * word is the tag word (whose eight two-bit entries are not a flag list). */
  private async controlWordVariables(name: string): Promise<DebugProtocol.Variable[]> {
    const bits = PSEUDO_REGISTER_WIDTH_BITS[name];
    const value = bits === undefined ? undefined : await this.registerValue(name, bits);
    if (value === undefined || bits === undefined) return [];

    // No whole-register row here, unlike the Flags and MXCSR groups: the row that was expanded to
    // get here is already this register, showing this value, and is already the one that accepts an
    // edit — repeating it underneath itself would be a row that says nothing new.
    const variables: DebugProtocol.Variable[] = [];
    if (name === 'fctrl') variables.push(...FasmDebugSession.bitFieldVariables(decodeX87Control(value)));
    else if (name === 'fstat') variables.push(...FasmDebugSession.bitFieldVariables(decodeX87Status(value)));
    else if (name === 'ftag') {
      const status = await this.registerValue('fstat', PSEUDO_REGISTER_WIDTH_BITS['fstat']);
      const top = status === undefined ? undefined : decodeX87Status(status).find((f) => f.name === 'TOP')?.value;
      for (const { physical, state } of decodeX87Tags(value)) {
        // Named by both the physical register and the st(n) that currently means it, because the
        // mapping between those two rotates with every push and pop.
        const stName = top === undefined ? undefined : `st${(physical - top + 8) % 8}`;
        variables.push(this.readOnlyVariable(stName === undefined ? `R${physical}` : `R${physical}  (${stName})`, state));
      }
    }
    return variables;
  }

  /** The Thread / Syscall group: where TLS lives, and which syscall the program is in. */
  private async threadGroupVariables(): Promise<DebugProtocol.Variable[]> {
    const variables: DebugProtocol.Variable[] = [];
    for (const name of this.registerGroups.thread) {
      const bits = PSEUDO_REGISTER_WIDTH_BITS[name];
      const value = await this.registerValue(name, bits);
      if (value === undefined || bits === undefined) continue;

      if (name === 'orig_rax' || name === 'orig_eax') {
        variables.push(this.syscallVariable(name, bits, value));
        continue;
      }
      // pkru is a rights mask rather than an address: its bits say which protection keys may be
      // read and written, so the decoded reading is the only one that says anything, and there is
      // nothing at "0x0" for a hex editor to open.
      if (name === 'pkru') {
        const v: DebugProtocol.Variable = new Variable(name, `${formatRegisterValueCompact(bits, value, { decimal: false })}  ${formatPkru(value)}`);
        v.evaluateName = name;
        v.type = THREAD_REGISTER_DESCRIPTIONS[name] ?? `${bits}-bit register`;
        v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
        variables.push(v);
        continue;
      }
      const v: DebugProtocol.Variable = new Variable(name, formatRegisterValueCompact(bits, value));
      v.evaluateName = name;
      v.type = THREAD_REGISTER_DESCRIPTIONS[name] ?? `${bits}-bit register`;
      // A TLS base is an address like any other, so the hex editor should open there.
      v.memoryReference = `0x${value.toString(16)}`;
      v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
      variables.push(v);
    }
    return variables;
  }

  /**
   * The syscall row: the number the program entered the kernel with, and the name that number has.
   *
   * Worth its own shape rather than a plain register row for two reasons. Linux sets this register
   * to -1 when the program is not in a syscall at all, which as a number reads as
   * "18446744073709551615" and means "nothing to see here" — so it is said in words. And a fasm
   * program with no libc is essentially a sequence of syscalls, so the number *is* the operation:
   * "59" is the whole meaning of the instruction that is executing, and it is `execve`.
   */
  private syscallVariable(name: string, bits: RegisterBits, value: bigint): DebugProtocol.Variable {
    const notInSyscall = value === (1n << BigInt(bits)) - 1n;
    const abi = this.syscallAbi();
    const named = notInSyscall ? undefined : syscallName(abi, value);
    const text = notInSyscall ? 'not in a syscall' : named !== undefined ? `${value}  ${named}` : `${value}  (no syscall has this number)`;
    const v: DebugProtocol.Variable = new Variable(name, text);
    v.evaluateName = name;
    v.type =
      named !== undefined
        ? `Linux ${abi} syscall ${value}: ${named}. Its arguments are in ${SYSCALL_ARGUMENT_REGISTERS[abi].join(', ')} — note the fourth is ${SYSCALL_ARGUMENT_REGISTERS[abi][3]}, not rcx, which the syscall instruction overwrites.`
        : 'The syscall number the program entered the kernel with, kept by Linux because the register it came in has since been overwritten with the return value.';
    v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
    return v;
  }

  /**
   * The Stack group: the machine words sitting at and above the stack pointer.
   *
   * The Call Stack view now answers "what called this" (see unwind.ts), but it answers only that.
   * What the prologue just pushed, which saved register is in which slot, and what an argument
   * passed on the stack actually holds are all still questions only the raw words can settle, and
   * each one is run through the same label resolution every register row gets — which is what turns
   * a pushed return address into "→ start+0x25" rather than a bare number.
   *
   * The two annotations that make this a picture of a frame rather than a column of numbers come
   * free from state already in hand: the frame pointer says where the current frame begins, and the
   * listing-derived return sites say which words are return addresses.
   *
   * One register read plus one memory read for the whole group, however deep it goes.
   */
  private async stackVariables(): Promise<DebugProtocol.Variable[]> {
    const spName = this.stackPointerName();
    if (spName === undefined) return [];
    const bits = REGISTER_WIDTH_BITS[spName];
    const sp = await this.registerValue(spName, bits);
    if (sp === undefined || bits === undefined) return [];

    const wordBytes = bits / 8;
    // The red zone sits *below* the stack pointer, so reading it means starting lower and listing
    // the negative offsets first — the whole group stays one read and one ascending list of
    // addresses either way.
    const redZoneWords = this.showRedZone ? RED_ZONE_BYTES / wordBytes : 0;
    const start = sp - BigInt(redZoneWords * wordBytes);
    const bytes = await this.readMemoryBytes(`0x${start.toString(16)}`, (redZoneWords + this.stackWordsShown) * wordBytes);
    if (!bytes) return [];

    const bpName = this.framePointerName();
    const bp = bpName === undefined ? undefined : await this.registerValue(bpName, REGISTER_WIDTH_BITS[bpName]);
    const words = decodeLittleEndianElements(bytes, wordBytes, Math.floor(bytes.length / wordBytes));
    const rows = words.map((word, i) => ({ word, offset: i * wordBytes - redZoneWords * wordBytes }));
    // Ordered by what is worth reading first rather than by address: the stack pointer is where the
    // program is, so it leads, and the red zone follows with the slot nearest rsp first. Listing
    // the whole thing in address order instead — which is the obvious way, and what this did until
    // the output was actually looked at — opens the group with sixteen rows of untouched scratch
    // and pushes the return address off the bottom.
    rows.sort((a, b) => (a.offset < 0) === (b.offset < 0) ? Math.abs(a.offset) - Math.abs(b.offset) : a.offset < 0 ? 1 : -1);
    return rows.map(({ word, offset }) => {
      const address = sp + BigInt(offset);
      const sign = offset < 0 ? '-' : '+';
      // The row's name is where it is relative to the stack pointer, because that is how the
      // source addresses it — "[rsp+8]" is a thing you write, "0x7ffd3c40" is not.
      const name = `[${spName}${sign}0x${Math.abs(offset).toString(16)}]`;
      const notes: string[] = [];
      // What makes the raw stack readable as a *structure* rather than a column of numbers: where
      // the current frame begins, and which words are the return addresses that got us here.
      if (bp !== undefined && address === bp) notes.push(`← ${bpName}`);
      if (this.returnSites.has(word)) notes.push('return address');
      if (offset < 0) notes.push('red zone');

      const value = formatRegisterValueCompact(bits, word, { ascii: true, pointsTo: describeAddress(this.symbolSpans, word) });
      const v: DebugProtocol.Variable = new Variable(name, notes.length > 0 ? `${value}  ${notes.join('  ')}` : value);
      v.evaluateName = `*(${unsignedCastType(bits)}*)($${gdbRegisterName(spName)}${sign}${Math.abs(offset)})`;
      v.type =
        offset < 0
          ? `The ${sizeName(wordBytes)} at 0x${address.toString(16)}, below the stack pointer — System V lets a leaf function use these 128 bytes as scratch without moving ${spName}.`
          : `The ${sizeName(wordBytes)} at 0x${address.toString(16)}.`;
      v.memoryReference = `0x${address.toString(16)}`;
      v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
      return v;
    });
  }

  /** Batched "-data-list-register-values" for registers whose value has no expression form worth
   * asking for — one MI command for all of them, keyed back by name. `format` is gdb's own single
   * letter: 'x' for the raw bit pattern, 'N' for its natural (here, floating-point) reading. */
  private async readRegisterValues(names: readonly string[], format: 'x'): Promise<Map<string, bigint>>;
  private async readRegisterValues(names: readonly string[], format: 'N'): Promise<Map<string, string>>;
  private async readRegisterValues(names: readonly string[], format: 'x' | 'N'): Promise<Map<string, bigint | string>> {
    const out = new Map<string, bigint | string>();
    if (!this.gdb || names.length === 0) return out;
    const numbers = names.map((name) => this.registerGroups.numbers.get(name));
    if (numbers.some((n) => n === undefined)) return out;
    try {
      const result = await this.gdb.sendCommand(`-data-list-register-values ${format} ${numbers.join(' ')}`);
      const rows = miData(result)?.['register-values'];
      if (!Array.isArray(rows)) return out;
      const byNumber = new Map<number, string>();
      for (const entry of rows) {
        if (typeof entry !== 'object' || entry === null) continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec.number !== 'string' || typeof rec.value !== 'string') continue;
        byNumber.set(Number(rec.number), rec.value);
      }
      names.forEach((name, i) => {
        const raw = byNumber.get(numbers[i] as number);
        if (raw === undefined) return;
        if (format === 'N') {
          out.set(name, raw);
          return;
        }
        try {
          out.set(name, BigInt(raw));
        } catch {
          // A register gdb answered for in a shape that is not a plain integer literal — skipped
          // rather than guessed at, the same posture as every other MI parser in this file.
        }
      });
    } catch {
      return out;
    }
    return out;
  }

  private readOnlyVariable(label: string, text: string, description?: string): DebugProtocol.Variable {
    const v: DebugProtocol.Variable = new Variable(label, text);
    if (description) v.type = description;
    v.presentationHint = { kind: 'data', attributes: ['readOnly'] };
    return v;
  }

  /**
   * One register's row in the Registers panel: a short value (see formatRegisterValueCompact) plus
   * an expandable child list carrying every fuller reading of the same bits.
   *
   * The split is the point. A register row is read at a glance, dozens of times per debugging
   * session, and what is being looked for is almost always "did this change, and is it the thing I
   * expect" — a question hex answers and a 79-character binary expansion actively obstructs. The
   * expansion, the byte breakdown, the sub-register views and whatever the value points at are all
   * still one click away, and none of them costs a gdb round-trip until that click happens.
   */
  private async registerVariable(
    name: string,
    options: { address: boolean; ascii: boolean; decimal?: boolean; suffix?: (value: bigint) => Promise<string | undefined> },
  ): Promise<DebugProtocol.Variable> {
    const bits = registerWidthBits(name);
    const value = await this.registerValue(name, bits);
    if (value === undefined || bits === undefined) {
      const unavailable: DebugProtocol.Variable = new Variable(name, '<unavailable>');
      unavailable.evaluateName = name;
      return unavailable;
    }

    const pointsTo = options.address ? describeAddress(this.symbolSpans, value) : undefined;
    const suffix = await options.suffix?.(value);
    const compact = formatRegisterValueCompact(bits, value, { ascii: options.ascii, pointsTo, decimal: options.decimal });
    const v: DebugProtocol.Variable = new Variable(
      name,
      suffix === undefined ? compact : `${compact}  ${suffix}`,
      this.variableHandles.create(`registers:reg:${name}`),
    );
    v.evaluateName = name;
    v.type = `${bits}-bit register`;
    // What a register holds is, very often, an address — and this is the field that decides
    // whether VS Code offers "View Binary Data" on the row at all, so without it the hex
    // editor was reachable from a data label but not from the rsi/rdi/rsp actually pointing at
    // the buffer you want to look at.
    if (options.address) v.memoryReference = `0x${value.toString(16)}`;
    return v;
  }

  /** The children of one register row — every reading of the same value that the row itself is too
   * narrow to carry, plus the one thing that does need gdb: what the value points at, when it
   * points anywhere readable. */
  private async registerDetailVariables(name: string): Promise<DebugProtocol.Variable[]> {
    const bits = registerWidthBits(name);
    const value = await this.registerValue(name, bits);
    if (value === undefined || bits === undefined) return [];

    const readOnly = (label: string, text: string, description?: string): DebugProtocol.Variable => this.readOnlyVariable(label, text, description);

    const negative = ((value >> BigInt(bits - 1)) & 1n) === 1n;
    const signed = value - (negative ? 1n << BigInt(bits) : 0n);
    const variables: DebugProtocol.Variable[] = [
      readOnly('hex', formatHexPadded(bits, value), 'Zero-padded to the register\'s full width, so two registers line up digit for digit.'),
      readOnly('unsigned', value.toString()),
    ];
    // Only when the two readings actually differ. For any value with its top bit clear they are the
    // same digits, and a second row repeating them is the same redundancy the compact row format
    // exists to cut — "signed 7" under "unsigned 7" is a row that answers nothing.
    if (negative) variables.push(readOnly('signed', signed.toString(), "Two's-complement reading of the same bits."));
    variables.push(
      readOnly('binary', formatBinaryGrouped(bits, value), 'Grouped into bytes and nibbles, so a bit position can be counted off directly.'),
      readOnly('bytes', formatBytesLittleEndian(bits, value), 'The individual bytes in memory order — x86 is little-endian, so the low byte comes first.'),
    );

    // What it held before the step that just ran, for a register that moved — with the difference
    // worked out, since that is the reading being asked for ("rsp changed by -8" is a push).
    const previous = this.registerPrevious.get(name);
    if (previous !== undefined && previous !== value) {
      variables.push(readOnly('previous', formatRegisterDelta(bits, previous, value), 'What this register held before the last step, and how far it moved.'));
    }

    const text = packedAsciiText(bits, value);
    if (text !== undefined) variables.push(readOnly('as text', `'${text}'`, 'Every byte of this value is printable text — a packed character literal.'));

    // Derived from the value already read: no extra round-trip, and it answers "what is in al"
    // without anyone having to do the masking in their head.
    for (const sub of subRegisterViews(name, value)) {
      const v: DebugProtocol.Variable = new Variable(sub.name, formatRegisterValueCompact(sub.bits, sub.value));
      v.evaluateName = sub.name;
      v.type = `${sub.bits}-bit view of ${name}`;
      variables.push(v);
    }

    const pointee = await this.pointeeVariable(name, bits, value);
    if (pointee) variables.push(pointee);
    return variables;
  }

  /** What the register points at, for a register that turns out to hold a readable address —
   * dereferencing by hand ("*(qword*)$rsi" in Watch) is otherwise the only way to see it, and at
   * this level a register holding an address is the normal case, not the exception. Returns
   * undefined when the address isn't mapped, which is the answer for most values most of the time
   * and not worth a row saying so. */
  private async pointeeVariable(name: string, bits: RegisterBits, value: bigint): Promise<DebugProtocol.Variable | undefined> {
    if (value === 0n || bits < 32) return undefined;
    const bytes = await this.readMemoryBytes(`0x${value.toString(16)}`, POINTEE_PREVIEW_BYTES);
    if (!bytes) return undefined;

    // Read at the pointer's own width — a 32-bit target's pointers address dwords, and showing a
    // qword there would splice two unrelated values together.
    const [pointed] = decodeLittleEndianElements(bytes, bits / 8, 1);
    let text = formatRegisterValueCompact(bits, pointed);
    // A register pointing at a string is common enough in assembly (every write syscall takes one)
    // that showing the text alongside the raw qword is worth the zero extra cost — the bytes are
    // already read.
    const printable = bytes.slice(0, bytes.findIndex((b) => b === 0) === -1 ? bytes.length : bytes.indexOf(0));
    if (printable.length >= 2 && printable.every((b) => b >= 0x20 && b < 0x7f)) {
      const { text: preview } = formatStringPreview(printable);
      text += `  "${preview}${printable.length === bytes.length ? '...' : ''}"`;
    }
    return {
      name: `[${name}]`,
      value: text,
      variablesReference: 0,
      evaluateName: `*(${unsignedCastType(bits)}*)$${gdbRegisterName(name)}`,
      type: `The ${bits === 64 ? 'qword' : 'dword'} at the address ${name} holds.`,
      memoryReference: `0x${value.toString(16)}`,
      presentationHint: { kind: 'data', attributes: ['readOnly'] },
    };
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
      const result = await this.gdb.sendCommand(`-data-evaluate-expression "(${castType})$${gdbRegisterName(name)}"`);
      const raw = miData(result)?.value;
      if (typeof raw !== 'string') return undefined;
      const match = /^\d+/.exec(raw);
      if (!match) return undefined;
      return BigInt(match[0]);
    } catch {
      return undefined;
    }
  }

  /**
   * Formats register `name` for one of the three shapes a caller can have room for.
   *
   * `eflags` additionally gets its decoded flag names ("[ IF ZF ]"), which is what anyone reading
   * that register actually wants; they are derived from the value already in hand rather than asked
   * of gdb as a second round-trip, so the names can never disagree with the number beside them.
   */
  private async formatRegister(name: string, bits: RegisterBits | undefined, form: RegisterDisplayForm = 'labelled'): Promise<string | undefined> {
    const value = await this.registerValue(name, bits);
    if (value === undefined || bits === undefined) return undefined;

    // A control/status word is a set of named bits, not a quantity: its decoded summary is what
    // anyone reading it wants, and an address annotation or a packed-text reading of one would be
    // an interpretation nothing ever performs on it.
    const decoded = this.decodeControlWord(name, value);
    const options = {
      ascii: decoded === undefined,
      pointsTo: decoded === undefined ? describeAddress(this.symbolSpans, value) : undefined,
      decimal: decoded === undefined,
    };
    const summary = decoded === undefined ? undefined : formatBitFieldSummary(decoded);
    if (form === 'detailed') {
      const text = formatRegisterDetailed(name, bits, value, options);
      return summary === undefined ? text : `${text}\n${summary}`;
    }
    const text = form === 'compact' ? formatRegisterValueCompact(bits, value, options) : formatRegisterValue(name, bits, value, options);
    return summary === undefined ? text : `${text}  ${summary}`;
  }

  /** The decoded fields of `name`, if `name` is one of the four control/status words this target
   * reports, or undefined for an ordinary register holding an ordinary number. */
  private decodeControlWord(name: string, value: bigint): DecodedBitField[] | undefined {
    if (name === this.registerGroups.eflagsName) return decodeEflags(value);
    if (name === this.registerGroups.mxcsrName) return decodeMxcsr(value);
    if (name === 'fctrl') return decodeX87Control(value);
    if (name === 'fstat') return decodeX87Status(value);
    return undefined;
  }

  /**
   * A register of any class, formatted for `form` — the single entry point hover, Watch and the
   * Debug Console go through, since a user typing a name into Watch has no reason to care which of
   * three internal read paths the name happens to need.
   */
  private async formatAnyRegister(name: string, form: RegisterDisplayForm): Promise<string | undefined> {
    const vectorBits = VECTOR_WIDTH_BITS[name];
    if (vectorBits !== undefined) return this.formatVectorRegister(name, vectorBits, form);
    if (X87_REGISTER_NAMES.includes(name)) return this.formatX87Register(name, form);
    return this.formatRegister(name, registerWidthBits(name), form);
  }

  private async formatVectorRegister(name: string, bits: VectorBits, form: RegisterDisplayForm): Promise<string | undefined> {
    const value = await this.readVectorRegister(name, bits);
    if (value === undefined) return undefined;
    if (form === 'detailed') return formatVectorDetailed(name, bits, value);
    const compact = formatVectorValueCompact(bits, value);
    return form === 'compact' ? compact : `${name} = ${compact}`;
  }

  /** An x87 register reads as its decimal value plus the structure of the bits behind it — the two
   * halves of the answer, since the decimal alone cannot distinguish a value that was computed from
   * one left in an empty register by whatever ran before. */
  private async formatX87Register(name: string, form: RegisterDisplayForm): Promise<string | undefined> {
    const [raws, decimals] = await Promise.all([this.readRegisterValues([name], 'x'), this.readRegisterValues([name], 'N')]);
    const raw = raws.get(name);
    if (raw === undefined) return undefined;
    const decimal = decimals.get(name) ?? formatHexPadded(80, raw);
    if (form === 'detailed') {
      return [`${name}  (80-bit x87 register)`, decimal, formatHexPadded(80, raw), formatExtendedFloat(raw)].join('\n');
    }
    const compact = `${decimal}  ${formatExtendedFloat(raw)}`;
    return form === 'compact' ? compact : `${name} = ${compact}`;
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

  /** The listing-derived maps as the plain lookup pair operandExpression.ts asks for — the only
   * symbol information a fasmg binary carries, since it emits no DWARF/CodeView for gdb to read. */
  private operandResolver(): OperandResolver {
    return {
      symbolAddress: (name) => this.symbolMap.get(name)?.address,
      constantValue: (name) => this.constantMap.get(name)?.value,
    };
  }

  /** Reads a single scalar of `bits` width at `addressHex`, the same unsigned-cast trick
   * readRegisterBigInt uses for registers — shared by both formatSymbolValue* variants below.
   * `addressHex` is any expression gdb can evaluate to an address, not only a literal one (see
   * operandExpression.ts, which hands it a register-relative one like `($rsp+8)`). */
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
    // A hover has room for the full-width and binary readings the compact one-liners drop.
    return `${header}\nvalue = ${formatHexPadded(bits, value)}  ${value.toString()}\n${formatBinaryGrouped(bits, value)}`;
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
   *
   * VS Code shows "Break on Value Change" on *every* variable row once the adapter declares
   * supportsDataBreakpoints — it is gated on the session, not on the row — so a register row got
   * the offer too and could only ever be answered with "rsp is not a data label". A register is a
   * perfectly good thing to watch, and gdb watches one directly, so it is answered here instead.
   * Which kind of row this is comes from the container handle rather than from the name, so a
   * program that happens to label something `rsp` still gets its label watched.
   */
  protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
    const name = args.name;
    const container = args.variablesReference !== undefined ? this.variableHandles.get(args.variablesReference) : undefined;
    if (typeof container === 'string' && container.startsWith('registers')) {
      response.body = {
        dataId: `${REGISTER_DATA_ID_PREFIX}${name}`,
        // Says which of the two readings this is: watching `rsi` stops when the pointer itself is
        // reassigned, not when the buffer it points at is written — the row's "View Binary Data"
        // is what leads to the other one, and confusing them costs a whole debugging session.
        description: `${name} itself (not the memory it points at)`,
        // gdb implements a register watchpoint by single-stepping and comparing, which it can only
        // do for writes: `rwatch $rsp` is rejected outright with "Expression cannot be implemented
        // with read/access watchpoint." Offering the other two would put two menu entries there
        // that fail at the moment the breakpoint is set.
        accessTypes: ['write'],
        canPersist: false,
      };
      this.sendResponse(response);
      return;
    }

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
      // gdb's own watch/rwatch/awatch, via MI's -break-watch flags: no flag = write, -r = read,
      // -a = both. The cast gives the watched region the right width; without one gdb watches
      // whatever default size it infers for a bare address.
      const flag = bp.accessType === 'read' ? '-r ' : bp.accessType === 'readWrite' ? '-a ' : '';

      // A register is watched as gdb's own `$name` convenience expression — there is no address to
      // take, and no cast to apply, since the register already has its width. Handled before the
      // "address:size" split below, which would otherwise read the prefix as the address.
      if (bp.dataId.startsWith(REGISTER_DATA_ID_PREFIX)) {
        const register = bp.dataId.slice(REGISTER_DATA_ID_PREFIX.length);
        try {
          const result = await this.gdb.sendCommand(`-break-watch $${register}`);
          const watch = miData(result)?.wpt as Record<string, unknown> | undefined;
          const number = watch?.number !== undefined ? String(watch.number) : undefined;
          if (number) this.dataBreakpointNumbers.push(number);
          breakpoints.push({ verified: number !== undefined });
        } catch (err) {
          breakpoints.push({ verified: false, message: (err as Error).message });
        }
        continue;
      }

      const [address, size] = bp.dataId.split(':');
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
    if (!this.ensureResumable(response)) return;
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
    // "-exec-run" against an attached target starts a fresh copy of the binary and leaves the
    // process you were actually debugging untouched — a restart that restarts the wrong thing.
    // The capabilities event sent on attach withdraws the button, so this is the backstop for a
    // client that asks anyway.
    if (this.mode === 'attach') {
      this.sendErrorResponse(response, 14, 'Restart is not available while attached — end the session and attach again.');
      return;
    }
    try {
      this.sendResponse(response);
      this.lastSignal = undefined;
      // The register snapshot described the process being replaced. Cleared rather than left to be
      // diffed against, since "changed since the last step" and "differs from what a whole other
      // process happened to hold" are not the same claim, and only the first one is worth showing.
      this.registerSnapshot = new Map();
      this.changedRegisterNames = new Set();
      // A restart kills the process the recording described, taking the history with it — so the
      // recording has to be re-established against the new one, exactly as configurationDone does
      // for the first run (including subscribing before -exec-run, for the same reason).
      const firstStop = this.reverseDebugging ? this.waitForNextStop() : undefined;
      this.recording = false;
      await this.gdb.sendCommand('-exec-run');
      if (firstStop) void firstStop.then((outcome) => (outcome === 'stopped' ? this.enableRecording() : undefined));
    } catch (err) {
      this.sendEvent(new OutputEvent(`restart failed: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
    if (!this.ensureResumable(response)) return;
    this.sendResponse(response);
    try {
      await this.gdb?.sendCommand('-exec-continue');
    } catch (err) {
      this.sendEvent(new OutputEvent(`continue failed: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  /**
   * Turns on gdb's execution recording, which is what makes stepping backwards possible at all.
   *
   * Opt-in rather than always on, because `record full` is genuinely expensive: gdb single-steps
   * the program and journals every register and memory write, which slows execution by orders of
   * magnitude and grows a buffer for the whole run. That is a fine trade for "why is eax wrong
   * here", and a bad one for every other launch.
   *
   * Announced to the client with a CapabilitiesEvent rather than in initializeRequest, because
   * whether this works is not known that early: the launch arguments haven't arrived yet, and
   * lldb-mi has no execution recording at all, so the Step Back button must only appear once gdb
   * has actually accepted the command. `record` has no MI form — it is a console command, reached
   * through -interpreter-exec.
   */
  private async enableRecording(): Promise<void> {
    try {
      await this.gdb?.sendCommand('-interpreter-exec console "record full"');
      this.recording = true;
      this.sendEvent(new CapabilitiesEvent({ supportsStepBack: true }));
      this.sendEvent(
        new OutputEvent('Reverse debugging is on: execution is being recorded, so Step Back and Reverse Continue are available.\n', 'console'),
      );
    } catch (err) {
      // Not fatal to the launch — the program runs perfectly well forwards, which is what every
      // other feature here needs. Only the backwards half is unavailable, and saying so plainly is
      // better than a Step Back button that fails on every press.
      this.sendEvent(
        new OutputEvent(
          `Reverse debugging is unavailable: ${(err as Error).message}. ` +
            'Execution recording is a gdb feature; lldb-mi does not have it. Everything else in this session is unaffected.\n',
          'stderr',
        ),
      );
    }
  }

  /** Guards the reverse requests. They can only be reached at all once the CapabilitiesEvent above
   * has been sent, but a client that asks anyway gets a straight answer instead of gdb's own. */
  private ensureRecording(response: DebugProtocol.Response): boolean {
    if (this.recording) return true;
    this.sendErrorResponse(
      response,
      16,
      'Nothing has been recorded, so there is no execution history to step back through. Set "reverseDebugging": true in this launch configuration to record the next run.',
    );
    return false;
  }

  protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
    if (!this.ensureResumable(response)) return;
    if (!this.ensureRecording(response)) return;
    // Mirrors nextRequest/stepInRequest: the Disassembly View asks for instruction granularity and
    // means exactly one instruction, everything else means "back to the previous source line".
    if (args.granularity === 'instruction') void this.stepOneInstruction(response, '-exec-step-instruction --reverse');
    else void this.stepToNextLine(response, '-exec-step-instruction --reverse');
  }

  protected async reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse): Promise<void> {
    if (!this.ensureResumable(response)) return;
    if (!this.ensureRecording(response)) return;
    this.sendResponse(response);
    try {
      await this.gdb?.sendCommand('-exec-continue --reverse');
    } catch (err) {
      this.sendEvent(new OutputEvent(`reverse continue failed: ${(err as Error).message}\n`, 'stderr'));
    }
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
    if (!this.ensureResumable(response)) return;
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

        const stopOutcome = await this.waitForNextStop(STEP_STOP_TIMEOUT_MS);
        if (stopOutcome === 'exited') return; // process exited or errored mid-step
        if (stopOutcome === 'timeout') {
          await this.recoverFromStuckStep();
          return;
        }

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
      const stopOutcome = await this.waitForNextStop(STEP_STOP_TIMEOUT_MS);
      if (stopOutcome === 'exited') return;
      if (stopOutcome === 'timeout') {
        await this.recoverFromStuckStep();
        return;
      }
      this.sendEvent(new StoppedEvent('step', MAIN_THREAD_ID));
    } finally {
      this.stepping = false;
    }
  }

  /**
   * Resolves `'stopped'` for a real code stop (the caller should keep stepping/inspecting),
   * `'exited'` for anything that means there's no more program left to step through — the gdb
   * *process* itself exiting (existing behavior), but also the *inferior* exiting normally while
   * gdb stays up, which arrives as an ordinary 'stopped' event with reason
   * "exited"/"exited-normally" (real bug found here: this used to resolve truthy for *any* stopped
   * event, so stepping the exact instruction that ends the program — e.g. its own "syscall" exit —
   * made stepToNextLine's loop try to evaluate $pc against a dead inferior, fail, treat that failure
   * as "landed on an unmapped address, keep stepping" (see its own `if (!loc) continue`), and send
   * yet another step command to a process that no longer exists — which is exactly what surfaced as
   * a spurious "step failed: The program is not being run." right after the real, correct
   * TerminatedEvent had already fired from onStopped's own separate 'stopped' listener).
   *
   * `timeoutMs` adds a third outcome, `'timeout'`: gdb acknowledged the command that led here but
   * never delivered the async stop it implied — see STEP_STOP_TIMEOUT_MS for why the step loops
   * need this and the other two callers (waiting on a session's very first stop, not on one leg of
   * a step loop) pass nothing and wait indefinitely, as before.
   */
  private waitForNextStop(timeoutMs?: number): Promise<'stopped' | 'exited' | 'timeout'> {
    if (!this.gdb) return Promise.resolve('exited');
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: 'stopped' | 'exited' | 'timeout') => {
        if (timer) clearTimeout(timer);
        this.gdb?.off('stopped', onStop);
        this.gdb?.off('exit', onExit);
        resolve(result);
      };
      const onStop = (data: Record<string, unknown>) => {
        const reason = typeof data.reason === 'string' ? data.reason : '';
        settle(reason.startsWith('exited') ? 'exited' : 'stopped');
      };
      const onExit = () => settle('exited');
      this.gdb!.once('stopped', onStop);
      this.gdb!.once('exit', onExit);
      if (timeoutMs !== undefined) timer = setTimeout(() => settle('timeout'), timeoutMs);
    });
  }

  /**
   * Recovers a step loop from a stuck `waitForNextStop` — see STEP_STOP_TIMEOUT_MS. Tries
   * `-exec-interrupt` to reclaim gdb, the same command Pause uses, since a step that never
   * completed has left the target genuinely still running (or gdb genuinely wedged) either way.
   *
   * Deliberately does not always send its own StoppedEvent: when the interrupt lands, gdb's own
   * resulting stop reaches the client through the ordinary onStopped path — its reason is never
   * "end-stepping-range", so onStopped's stepping-loop suppression (`this.stepping &&
   * reasonRaw === 'end-stepping-range'`) doesn't swallow it — and sending a second one here would
   * just duplicate it, the same class of bug the 1.27.2 event-flood fix was written to avoid. Only
   * when the interrupt itself gets no answer either is one forced, so the client is never left
   * waiting on a StoppedEvent that nothing will ever send.
   */
  private async recoverFromStuckStep(): Promise<void> {
    this.sendEvent(
      new OutputEvent(
        `Step did not complete after ${STEP_STOP_TIMEOUT_MS / 1000}s — gdb acknowledged it but never reported the ` +
          'target stopping again. Likely stepping into code with no debug symbols (a Windows API call, say); "Step ' +
          'Over" avoids diving into it. Interrupting to keep the session usable.\n',
        'stderr',
      ),
    );
    let reclaimed = false;
    try {
      await this.gdb?.sendCommand('-exec-interrupt');
      reclaimed = (await this.waitForNextStop(STEP_INTERRUPT_TIMEOUT_MS)) === 'stopped';
    } catch {
      // best-effort — the point below is to unstick the UI regardless of whether gdb answered
    }
    if (!reclaimed) this.sendEvent(new StoppedEvent('pause', MAIN_THREAD_ID));
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    if (!this.ensureResumable(response)) return;
    if (args.granularity === 'instruction') void this.stepOneInstruction(response, '-exec-next-instruction');
    else void this.stepToNextLine(response, '-exec-next-instruction');
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    if (!this.ensureResumable(response)) return;
    if (args.granularity === 'instruction') void this.stepOneInstruction(response, '-exec-step-instruction');
    else void this.stepToNextLine(response, '-exec-step-instruction');
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
    if (!this.ensureResumable(response)) return;
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
    } finally {
      // Any evaluated expression may have *written* to the machine — "set $orig_rax = 59" in the
      // Debug Console is a register write that never passes through setRegister, and a Watch entry
      // is just as free to contain an assignment. Rather than trying to tell a reading expression
      // from a writing one (gdb's evaluator accepts far more than this file could classify), the
      // batched snapshot is simply dropped afterwards. The cost is one extra MI command on the next
      // panel read; the alternative is a row that reports a value the user has already changed.
      this.registerValuesStale = true;
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
    const form: RegisterDisplayForm = args.context === 'hover' ? 'detailed' : NAME_ALREADY_SHOWN_CONTEXTS.has(args.context ?? '') ? 'compact' : 'labelled';
    // A name fasm reserves cannot also be one of this program's labels, so it resolves as a
    // register before the symbol table is consulted. The pseudo-registers gdb adds on top of the
    // ISA (fs_base, mxcsr, orig_rax) do *not* get that precedence — see PSEUDO_REGISTER_WIDTH_BITS
    // — so they are tried further down, after this program's own names have had their chance.
    if (isReservedRegisterMnemonic(registerName)) {
      const formatted = await this.formatAnyRegister(registerName, form);
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

    // The registers gdb adds that the ISA does not name — `fs_base`, `mxcsr`, `orig_rax`. Resolved
    // only now, with this program's own labels and constants already given their chance, because
    // fasm reserves none of these spellings: a program is free to define a label called `orig_rax`,
    // and a debugger that answered with the register instead would be describing the wrong thing
    // entirely. Typing one into Watch still works, which is what this is for.
    if (PSEUDO_REGISTER_WIDTH_BITS[registerName] !== undefined) {
      const formatted = await this.formatRegister(registerName, PSEUDO_REGISTER_WIDTH_BITS[registerName], form);
      if (formatted !== undefined) {
        response.body = { result: formatted, variablesReference: 0 };
        this.sendResponse(response);
        return;
      }
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

    // A fasm memory operand as written in the source — "dword [rsp+8]", "[buffer+rcx*4]" — which
    // is what the editor's EvaluatableExpressionProvider sends for a hover over one, and the
    // natural thing to type into Watch while reading assembly. None of it is gdb syntax: the
    // registers need "$", the labels have no symbol table to be found in, the literals are fasm's,
    // and gdb has no "dword" type. See operandExpression.ts, which does all four substitutions.
    const operand = translateMemoryOperand(trimmed, this.operandResolver());
    if (operand) {
      const value = await this.readScalarAt(operand.address, operand.bits);
      if (value !== undefined) {
        // Same hex/decimal/binary presentation the Registers scope uses, labelled with the operand
        // as the user wrote it rather than with the gdb expression it was translated into.
        response.body = { result: formatRegisterValue(operand.text, operand.bits, value), variablesReference: 0 };
        this.sendResponse(response);
        return;
      }
      // A translated operand that would not read (an address the process cannot touch) falls
      // through, so gdb's own error text is what reaches the user instead of silence.
    }

    // A compound expression like "*(unsigned int*)$esp" — passed straight through to gdb's
    // evaluator.
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
  /**
   * Completes a partly-typed Debug Console command by asking gdb, which is the only thing that
   * knows its own command set — and knows it for the exact build in use, rather than from a list
   * baked in here that would drift.
   *
   * gdb answers with whole commands ("info reg" → "info registers"), so each target replaces
   * everything typed so far rather than being appended to it. Failure is answered with an empty
   * list: a console that offers nothing is the status quo, while an error popup on a keystroke is
   * not.
   */
  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments,
  ): Promise<void> {
    const prefix = args.text.slice(0, Math.max(0, args.column - 1));
    response.body = { targets: [] };
    if (!this.gdb || !prefix.trim()) {
      this.sendResponse(response);
      return;
    }

    try {
      const quoted = prefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const result = await this.gdb.sendCommand(`-complete "${quoted}"`, CONSOLE_COMMAND_TIMEOUT_MS);
      const matches = miData(result)?.matches;
      if (Array.isArray(matches)) {
        response.body.targets = matches
          .filter((match): match is string => typeof match === 'string')
          .map((match) => ({ label: match, start: 0, length: prefix.length }));
      }
    } catch {
      // Older gdbs predate -complete, and lldb-mi never had it. No completions, no error.
    }
    this.sendResponse(response);
  }

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

  /** Every container that can hold an editable register row: the three whole-register groups, the
   * Flags group (whose first child is the eflags register itself — the individual decoded bits in it
   * are marked readOnly instead, since gdb has no way to set one EFLAGS bit in isolation), and a
   * register's own detail children, whose sub-register views (al, ax, r8d, ...) are real registers
   * gdb can write. Whether a given *row* in one of these is settable is then decided by setRegister,
   * which only recognizes actual register names — so "hex" or "binary" is rejected by name. */
  private static isSettableContainer(kind: string | undefined): boolean {
    if (kind === undefined) return false;
    const containers = ['registers:gp', 'registers:pointers', 'registers:segment', 'registers:flags', 'registers:mask', 'registers:vector', 'registers:x87', 'registers:mxcsr'];
    // The per-register detail containers: an integer register's children (its sub-register views),
    // a vector register's (its narrower aliases), and a control word's own first row.
    const prefixes = ['registers:reg:', 'registers:vec:', 'registers:word:'];
    return containers.includes(kind) || prefixes.some((prefix) => kind.startsWith(prefix));
  }

  /** Edits a register's value from the Registers panel (VS Code's in-place variable editor). */
  protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
    const kind = this.variableHandles.get(args.variablesReference);
    if (!FasmDebugSession.isSettableContainer(kind)) {
      this.sendErrorResponse(response, 8, 'Only registers can be set');
      return;
    }
    // 'compact' so the row VS Code paints from this response is identical to the one the next
    // variables request would produce — a mismatch here reads as the write having done something
    // other than what it did.
    const formatted = await this.setRegister(args.name.toLowerCase(), args.value, response, 'compact');
    if (formatted === undefined) return; // an error response was already sent
    response.body = { value: formatted };
    this.sendResponse(response);
  }

  /** Edits a register's value from a Watch expression (typing e.g. "eax" into Watch, then
   * editing its value in place — DAP's setVariable only covers the Variables/Registers tree). */
  protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): Promise<void> {
    const registerName = args.expression.trim().replace(/^\$/, '').toLowerCase();
    // A Watch row already shows the expression that produced the value in its own name column.
    const formatted = await this.setRegister(registerName, args.value, response, 'compact');
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
  private async setRegister(name: string, rawValue: string, response: DebugProtocol.Response, form: RegisterDisplayForm = 'labelled'): Promise<string | undefined> {
    if (!this.gdb) {
      this.sendErrorResponse(response, 2, 'Debug session is not running');
      return undefined;
    }

    const vectorBits = VECTOR_WIDTH_BITS[name];
    if (vectorBits !== undefined) return this.setVectorRegister(name, vectorBits, rawValue, response, form);
    if (X87_REGISTER_NAMES.includes(name)) return this.setX87Register(name, rawValue, response, form);

    const bits = registerWidthBits(name);
    if (bits === undefined) {
      this.sendErrorResponse(response, 5, `"${name}" is not a register this debugger knows how to set`);
      return undefined;
    }
    // What the register holds right now is what tells parseUserNumber which column of the pre-filled
    // display string the user actually edited — every column that still matches this one was left
    // alone. One extra round-trip, on a keystroke-rate path, in exchange for never guessing.
    const current = await this.readRegisterBigInt(name, bits);
    const parsed = parseUserNumber(rawValue, bits, current);
    if (parsed === undefined) {
      this.sendErrorResponse(response, 6, `Could not parse "${rawValue}" as a number (try decimal, 0x.., 0b.., or an asm-style ..h hex literal)`);
      return undefined;
    }

    // Writing a 32-bit view goes to its 64-bit parent so the upper half is zeroed, the way every
    // real "mov eax, ..." does — see wideParentOf32BitView. `parsed` is already wrapped to 32 bits,
    // so assigning it to the parent *is* the zero-extension. Only when the parent is a register this
    // target actually has: on i386 "eax" is the whole register and there is no rax to redirect to.
    const parent = bits === 32 ? wideParentOf32BitView(name) : undefined;
    const target = parent !== undefined && this.targetHasRegister(parent) ? parent : name;

    try {
      await this.gdb.sendCommand(`-data-evaluate-expression "$${gdbRegisterName(target)} = ${parsed.toString()}"`);
    } catch (err) {
      this.sendErrorResponse(response, 7, (err as Error).message);
      return undefined;
    }
    // The batched snapshot every row is drawn from was taken before this write and no longer
    // describes the machine. Writing a sub-register makes this wider than it looks — a "set al" is a
    // change to rax — so the whole snapshot is dropped rather than the one name patched.
    this.registerValuesStale = true;

    const formatted = await this.formatRegister(name, bits, form);
    return formatted ?? parsed.toString();
  }

  /**
   * Writes a whole SIMD register, one 64-bit lane at a time.
   *
   * Lane by lane because that is the only assignable form gdb offers — there is no `$xmm0 = ...`
   * that takes a single 128-bit integer, and the struct field that *reads* as one (`uint128`) is
   * not writable. Each lane is handed over as a signed decimal rather than the hex it was parsed
   * from, since the field's declared type is `int64_t` and a value above its range is a value gdb
   * would have to be trusted to wrap the same way this file already did.
   */
  private async setVectorRegister(
    name: string,
    bits: VectorBits,
    rawValue: string,
    response: DebugProtocol.Response,
    form: RegisterDisplayForm,
  ): Promise<string | undefined> {
    const current = await this.readVectorRegister(name, bits);
    const parsed = parseUserNumber(rawValue, bits, current);
    if (parsed === undefined) {
      this.sendErrorResponse(response, 6, `Could not parse "${rawValue}" as a number (try 0x.., 0b.., decimal, or an asm-style ..h hex literal)`);
      return undefined;
    }
    try {
      for (let lane = 0; lane < bits / 64; lane++) {
        const unsigned = (parsed >> BigInt(lane * 64)) & 0xffffffffffffffffn;
        const signed = unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
        await this.gdb?.sendCommand(`-gdb-set $${name}.v${bits / 64}_int64[${lane}] = ${signed.toString()}`);
      }
    } catch (err) {
      this.sendErrorResponse(response, 7, (err as Error).message);
      return undefined;
    }
    this.registerValuesStale = true;
    return (await this.formatVectorRegister(name, bits, form)) ?? `0x${parsed.toString(16)}`;
  }

  /**
   * Writes an x87 register from a decimal float — `3.14`, `-1.5`, `1e10`.
   *
   * A float rather than a bit pattern because that is what the register means and what the row
   * shows: the display an edit starts from is gdb's own decimal reading, so the natural thing to do
   * is change a digit in it and press Enter. Handing that string to gdb unchanged is also what
   * preserves it exactly — an 80-bit significand has more precision than a JS number, so parsing it
   * here on the way past would quietly round the value the user typed.
   */
  private async setX87Register(name: string, rawValue: string, response: DebugProtocol.Response, form: RegisterDisplayForm): Promise<string | undefined> {
    const trimmed = rawValue.trim();
    // Deliberately strict about the shape rather than forwarding whatever was typed: gdb's
    // expression evaluator would happily accept `$rax` or a function call here, and an edit box on
    // a register row is not a place to be running arbitrary expressions against the inferior.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
      this.sendErrorResponse(response, 6, `Could not parse "${rawValue}" as a decimal number — an x87 register holds a floating-point value, so write it as one (e.g. 3.14, -1.5, 1e10).`);
      return undefined;
    }
    try {
      await this.gdb?.sendCommand(`-gdb-set $${name} = ${trimmed}`);
    } catch (err) {
      this.sendErrorResponse(response, 7, (err as Error).message);
      return undefined;
    }
    // An x87 write is never confined to the register named: pushing a value rotates TOP and retags
    // the stack, so fstat and ftag — both in the snapshot — have moved too.
    this.registerValuesStale = true;
    return (await this.formatX87Register(name, form)) ?? trimmed;
  }

  /**
   * Ends the session, leaving an attached process running unless the client explicitly asked for
   * it to be killed.
   *
   * That default is the protocol's, and it is the right one: you attached to a process you did not
   * start, very possibly a long-running one, and ending a debugging session is not a request to
   * end the program.
   *
   * Both directions need saying out loud, because gdb's own shutdown does neither on request:
   * quitting gdb while attached *always* detaches and leaves the process running, so "terminate the
   * debuggee" has to kill it explicitly, and the detach is sent first rather than left implicit so
   * it happens in a defined order. Killing goes through the console `kill` command (with confirm
   * off, since there is no one to answer a prompt) rather than an MI one: gdb has no MI command for
   * it — "-exec-abort" answers "Undefined MI command" — which is the sort of thing only a real
   * session tells you, and the attach end-to-end test is what pinned it down.
   *
   * Either command failing means the target is already gone, which is the outcome both were asking
   * for anyway.
   */
  private async endSession(terminateDebuggee: boolean | undefined): Promise<void> {
    this.terminalHandshake?.release();
    this.terminalHandshake = undefined;
    if (this.attachTarget?.kind === 'process') {
      if (terminateDebuggee === true) {
        await this.gdb?.sendCommand('-gdb-set confirm off').catch(() => undefined);
        await this.runConsoleCommand('kill').catch(() => undefined);
      } else {
        await this.gdb?.sendCommand('-target-detach').catch(() => undefined);
      }
    }
    await this.gdb?.dispose();
  }

  protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args?: DebugProtocol.DisconnectArguments): Promise<void> {
    await this.endSession(args?.terminateDebuggee);
    this.sendResponse(response);
  }

  protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    // "terminate" means the debuggee, so an attached process is killed here even though a plain
    // disconnect leaves it running — the client only sends this when that is what was asked for.
    await this.endSession(true);
    this.sendResponse(response);
  }
}
