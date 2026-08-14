// Dragging a file from the Explorer into a source file and getting the `include` line for it.
//
// fasm has no module system: a path inside a string literal is the only thing that ties two files
// together, and writing one means counting `../` levels by hand against a search order (the
// including file's directory, then INCLUDE) that is not written down anywhere in the project. That
// is the kind of thing an editor should do, and the gesture for it — drag the file in — is one
// people already try, because it works in the languages next door.
//
// Without a provider, VS Code's own default handles the drop by inserting the file's path as plain
// text, which in a fasm buffer is not valid syntax and is not even the right path: it is spelled
// against the workspace root rather than against the file being edited.

import * as vscode from 'vscode';
import { fasmConfig } from './config';
import { includeDirectivesFor } from './includeDropPath';

/** fasm2Studio.includePath, split the way the assembler splits INCLUDE. */
function searchDirs(resource: vscode.Uri): string[] {
  return fasmConfig(resource)
    .get<string>('includePath', '')
    .split(';')
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

/**
 * The dropped files, in the order they were dragged.
 *
 * `text/uri-list` is the mime type the Explorer puts a file drag on, and it carries one URI per
 * line — CRLF-separated per the spec, with `#`-prefixed comment lines. Non-file schemes are
 * dropped: an `include` names something the assembler opens off disk, and a path derived from an
 * untitled or remote-virtual URI would not be one.
 */
async function droppedFsPaths(dataTransfer: vscode.DataTransfer): Promise<string[]> {
  const item = dataTransfer.get('text/uri-list');
  if (!item) return [];
  const value = await item.asString();
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      try {
        return vscode.Uri.parse(line, true);
      } catch {
        return undefined;
      }
    })
    .filter((uri): uri is vscode.Uri => uri?.scheme === 'file')
    .map((uri) => uri.fsPath);
}

/** Exported for the integration suite, which drives it with a real DataTransfer — VS Code offers no
 * command for invoking a drop provider, so the registration below is the only part not covered. */
export class IncludeDropProvider implements vscode.DocumentDropEditProvider {
  async provideDocumentDropEdits(
    document: vscode.TextDocument,
    _position: vscode.Position,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentDropEdit | undefined> {
    // An unsaved buffer has no directory for a relative path to be spelled against, and it is also
    // the one document Build/Run/Debug cannot act on — so there is nothing here worth writing.
    if (document.uri.scheme !== 'file') return undefined;

    const paths = await droppedFsPaths(dataTransfer);
    if (token.isCancellationRequested || paths.length === 0) return undefined;

    const text = includeDirectivesFor(document.uri.fsPath, paths, searchDirs(document.uri));
    // Returning undefined rather than an empty edit hands the drop back to VS Code's default,
    // which is the right outcome for something an `include` has no business naming — a dropped
    // image, or the file's own tab.
    return text === undefined ? undefined : new vscode.DocumentDropEdit(text);
  }
}

export function registerIncludeDrop(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Two-argument form on purpose: the third `metadata` parameter (dropMimeTypes,
    // providedDropEditKinds) arrived after this extension's minimum VS Code version, and passing it
    // would make the registration silently do nothing on the older ones still in engines.
    vscode.languages.registerDocumentDropEditProvider({ language: 'fasm' }, new IncludeDropProvider()),
  );
}
