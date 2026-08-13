import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './config';

/** Shared text for every "a command that needs an active FASM editor found none" message, so
 * Build/Run/Debug and the F5-with-no-launch.json fallback in debugAdapter.ts read identically. */
export const NO_ACTIVE_FASM_FILE_MESSAGE = `${MESSAGE_PREFIX}open a .asm/.inc file first.`;

/** Whether `document` is a FASM source, per VS Code's own languageId classification (grammar-
 * based, so it also covers untitled/no-extension buffers the user has manually set the language
 * of) — the one condition every command/provider that only applies to FASM files gates on. */
export function isFasmDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'fasm';
}

/** The active editor, or undefined if there isn't one or it isn't showing a FASM document. */
export function activeFasmEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && isFasmDocument(editor.document) ? editor : undefined;
}

export const UNSAVED_FILE_MESSAGE =
  `${MESSAGE_PREFIX}this buffer has never been saved, so there is no file on disk for the assembler to read. Save it somewhere first.`;

const SAVE_AS = 'Save As…';

/**
 * The on-disk path to build/run/debug `document` as, prompting to save first if it has none.
 *
 * `isFasmDocument` classifies by language id, which deliberately includes untitled buffers so that
 * highlighting and completion work in a scratch file. Everything that spawns a compiler needs more
 * than that: an untitled document's `uri.fsPath` is its *label* ("Untitled-1"), not a path, and
 * feeding that to entry-point resolution asked the server about a file that has never existed.
 * What the user actually saw was the "which project is this for?" quick pick — the fallback for a
 * fragment no entry point reaches — offering unrelated files from elsewhere in the workspace, since
 * a name that resolves to nothing is indistinguishable from an orphaned fragment.
 */
export async function buildableFsPath(document: vscode.TextDocument): Promise<string | undefined> {
  if (!document.isUntitled) return document.uri.fsPath;

  const choice = await vscode.window.showWarningMessage(UNSAVED_FILE_MESSAGE, SAVE_AS);
  if (choice !== SAVE_AS) return undefined;

  // workspace.saveAs, not TextDocument.save(): saving an untitled buffer replaces it with a
  // different document backed by the chosen path, so `document` itself stays untitled and only the
  // returned uri names where the contents actually landed.
  const saved = await vscode.workspace.saveAs(document.uri);
  return saved?.fsPath;
}
