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
