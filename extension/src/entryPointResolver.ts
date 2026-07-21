// Resolves which real entry point (a file with its own top-level "format" directive) a
// build/run/debug command should actually target — fasm2/fasm1 can't compile a fragment (an
// .inc/.asm meant only to be `include`d) standalone. Mirrors findReachableEntryPoints, already
// used server-side, so a workspace with several independent projects behaves the same way here:
// editing a shared fragment and hitting Build resolves to whichever single project reaches it,
// and only prompts when that's genuinely ambiguous (or unknown) rather than guessing.
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

interface EntryPointItem extends vscode.QuickPickItem {
  fsPath: string;
}

function toQuickPickItems(entryUris: string[], relativeTo: string): EntryPointItem[] {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(relativeTo));
  return entryUris.map((entryUri) => {
    const fsPath = vscode.Uri.parse(entryUri).fsPath;
    return { label: path.basename(fsPath), description: folder ? path.relative(folder.uri.fsPath, fsPath) : fsPath, fsPath };
  });
}

async function pickEntryPoint(fileFsPath: string, entryUris: string[], placeHolder: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(toQuickPickItems(entryUris, fileFsPath), { placeHolder });
  return picked?.fsPath;
}

export async function resolveEntryPointFsPath(client: LanguageClient, fileFsPath: string): Promise<string | undefined> {
  const uri = vscode.Uri.file(fileFsPath).toString();
  const response = await client.sendRequest<{ entryUri?: string; ambiguousEntryUris?: string[] }>('fasm2Studio/resolveEntryPoint', { uri });

  if (response.entryUri) return vscode.Uri.parse(response.entryUri).fsPath;

  if (response.ambiguousEntryUris) {
    return pickEntryPoint(fileFsPath, response.ambiguousEntryUris, `"${path.basename(fileFsPath)}" is included by more than one project — which one is this for?`);
  }

  // Not reachable from any known entry point at all (a genuinely orphaned fragment, or one whose
  // includer hasn't been opened/indexed yet) — fall back to every entry point known in the
  // workspace, rather than failing outright, in case the user knows a relationship we don't.
  const { entryUris } = await client.sendRequest<{ entryUris: string[] }>('fasm2Studio/listEntryPoints', {});
  if (entryUris.length === 0) {
    void vscode.window.showErrorMessage(
      `FASM2 Studio: no entry point found for "${path.basename(fileFsPath)}". It has no "format" directive of its own, and isn't reachable via \`include\` from any file that does.`,
    );
    return undefined;
  }
  if (entryUris.length === 1) return vscode.Uri.parse(entryUris[0]).fsPath;
  return pickEntryPoint(fileFsPath, entryUris, `"${path.basename(fileFsPath)}" isn't reachable from any known entry point — which project is this for?`);
}
