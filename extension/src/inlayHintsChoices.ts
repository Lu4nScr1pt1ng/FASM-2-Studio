// What "FASM: Select Inline Annotations" offers and in what order. Kept free of any `vscode`
// import so the wording and the ordering can be asserted without a running editor, the same way
// debuggerChoices.ts is split out from selectDebugger.ts. selectInlayHints.ts turns these into a
// real QuickPick.
//
// The setting behind this is the one feature here that nothing in the UI ever mentioned: it is off
// by default, it is a six-valued enum rather than a switch, and the only place it appeared was its
// own row in the settings editor. Someone who never opened that row had no way to find out that
// the encoding of every instruction is available inline.

export const INLAY_HINTS_SETTING = 'inlayHints';

export type InlayHintsMode = 'off' | 'address' | 'size' | 'addressAndSize' | 'bytes' | 'addressAndBytes';

export interface InlayHintsChoice {
  label: string;
  description: string;
  detail: string;
  mode: InlayHintsMode;
}

/**
 * The modes, each shown as what it actually renders next to a line of code rather than as a
 * description of it. The sample is the same instruction throughout — `mov eax, 60`, the exit
 * syscall number from the hello world "FASM: New File" writes — so the six entries differ only in
 * the part being chosen between, and picking one is reading rather than guessing.
 */
const SAMPLES: Record<InlayHintsMode, string> = {
  off: 'No annotations.',
  address: 'mov eax, 60   →   0x00401000',
  size: 'mov eax, 60   →   5 bytes',
  addressAndSize: 'mov eax, 60   →   0x00401000 · 5 bytes',
  bytes: 'mov eax, 60   →   B8 3C 00 00 00',
  addressAndBytes: 'mov eax, 60   →   0x00401000 · B8 3C 00 00 00',
};

const LABELS: Record<InlayHintsMode, string> = {
  off: 'Off',
  address: 'Address',
  size: 'Size',
  addressAndSize: 'Address and size',
  bytes: 'Encoding',
  addressAndBytes: 'Address and encoding',
};

/**
 * Ordered so that turning the feature off is last rather than first. The list is reached from a
 * status bar entry that says what the current mode is, so someone opening it has already decided
 * to change something; leading with "Off" would put the one destructive answer under the cursor.
 * Within the rest it runs narrowest to widest, which is also cheapest to read at a glance.
 */
export const INLAY_HINTS_MODES: InlayHintsMode[] = ['address', 'size', 'addressAndSize', 'bytes', 'addressAndBytes', 'off'];

export function inlayHintsChoices(current: InlayHintsMode): InlayHintsChoice[] {
  return INLAY_HINTS_MODES.map((mode) => ({
    label: LABELS[mode],
    description: mode === current ? 'current' : '',
    detail: SAMPLES[mode],
    mode,
  }));
}

/** How the current mode reads in the status bar menu, where there is room for a few words and no
 * room for a sample. */
export function inlayHintsSummary(mode: InlayHintsMode): string {
  return mode === 'off' ? 'off' : LABELS[mode].toLowerCase();
}

/**
 * Why a mode that was just switched on is going to annotate nothing, if that is the case.
 *
 * The hints ride on the listing produced by the background compile behind live error checking, so
 * all three of these are load-bearing. Without this the feature simply appears not to work: the
 * setting reads as the mode you chose, and the editor shows nothing, with no way to tell which of
 * the three preconditions is the missing one. Ordered by how fundamental each is — an untrusted
 * workspace runs no compiler at all, so it is checked before the switch that would have run one.
 */
export function unmetPrerequisite(state: {
  trusted: boolean;
  diagnosticsEnabled: boolean;
  dialect: 'fasm2' | 'fasm1';
}): string | undefined {
  if (!state.trusted) {
    return 'this workspace is not trusted, so nothing is assembled in the background to read them from. Trust the folder to turn them on.';
  }
  if (!state.diagnosticsEnabled) {
    return 'live error checking is off, and the annotations come from the same background compile. Turn it back on to see them.';
  }
  if (state.dialect === 'fasm1') {
    return 'this file is being assembled as fasm1, whose listing format is not supported. Only fasm2/fasmg projects can produce them.';
  }
  return undefined;
}
