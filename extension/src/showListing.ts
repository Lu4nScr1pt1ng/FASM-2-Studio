// "FASM: Show Listing" — the assembler's own account of what it emitted, line by line.
//
// The extension has been generating listings all along and never showing anyone one: a debug build
// needs it to map addresses back to source, and the inlay hints are built from it. Both consume a
// parsed subset. The listing itself — every statement with its address, its offset in the output
// file, and the exact bytes it assembled to — is the artifact assembly programmers actually ask an
// assembler for, and there was no way to obtain it short of knowing that a fasmg macro exists,
// finding it inside the installed extension, and passing an `-i` flag by hand.
//
// It opens as a virtual read-only document rather than a file written next to the source. A listing
// describes one moment of one build; it is something to read, not a build artifact to manage,
// and writing one into the project would mean something else then had to clean it up.
//
// Deliberately a fresh compile rather than whatever a previous debug build left on disk: nothing in
// a listing's contents says which version of the source it describes, so a stale one is worse than
// none at all.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { MESSAGE_PREFIX } from './config';
import { resolveEntryPointFsPath } from './entryPointResolver';
import { activeFasmEditor, buildableFsPath, NO_ACTIVE_FASM_FILE_MESSAGE } from './activeEditor';
import { ensureTrusted } from './workspaceTrust';

/** The scheme the listing documents live under. Registered to a content provider below, which is
 * what makes them read-only: a virtual document has no filesystem behind it to save to. */
const LISTING_SCHEME = 'fasm2-listing';

interface ListingResponse {
  text?: string;
  error?: string;
  /** Errors the compile that produced this listing also reported. A listing is written by the
   * assembly itself, so a build can fail and still leave a real (if truncated) one behind. */
  errorCount?: number;
}

/**
 * One listing per entry point, keyed by the URI it is shown under.
 *
 * The URI is derived from the entry point's own path and so is stable across runs, which is what
 * makes re-running the command update the tab that is already open instead of stacking up a new
 * one beside it every time.
 */
class ListingContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.toString(), text);
    // VS Code caches a virtual document's content until told otherwise, so an already-open tab
    // would keep showing the previous build's listing without this.
    this.onDidChangeEmitter.fire(uri);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.contents.clear();
  }
}

/** Where an entry point's listing is shown. Ends in the entry point's full file name so a tab
 * reading "hello.asm.lst" says which program it belongs to — several programs in one workspace
 * routinely share a base name. */
function listingUriFor(entryFsPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: LISTING_SCHEME, path: `${entryFsPath}.lst` });
}

export function registerShowListing(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): void {
  const provider = new ListingContentProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(LISTING_SCHEME, provider),
    provider,

    vscode.commands.registerCommand('fasm2Studio.showListing', async (resource?: vscode.Uri) => {
      // First, as with every other command here that ends in a spawned assembler.
      if (!(await ensureTrusted('Showing a listing'))) return;

      let sourceFsPath: string | undefined;
      if (resource) {
        sourceFsPath = resource.fsPath;
      } else {
        const editor = activeFasmEditor();
        if (!editor) {
          void vscode.window.showWarningMessage(NO_ACTIVE_FASM_FILE_MESSAGE);
          return;
        }
        sourceFsPath = await buildableFsPath(editor.document);
      }
      if (!sourceFsPath) return;

      const client = getClient();
      if (!client) {
        void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}the language server is not ready yet — try again in a moment.`);
        return;
      }

      // A listing describes a whole program, so an included fragment gets the listing of whichever
      // entry point it belongs to — the same resolution Build and Debug use.
      const entryFile = await resolveEntryPointFsPath(client, sourceFsPath);
      if (!entryFile) return;

      const response = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `${MESSAGE_PREFIX}assembling ${path.basename(entryFile)} for its listing…`,
        },
        async (): Promise<ListingResponse> => {
          try {
            return await client.sendRequest<ListingResponse>('fasm2Studio/buildListing', {
              uri: vscode.Uri.file(entryFile).toString(),
            });
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      );

      if (!response.text) {
        void vscode.window.showErrorMessage(
          `${MESSAGE_PREFIX}no listing for ${path.basename(entryFile)}: ${response.error ?? 'the assembler wrote none'}`,
        );
        return;
      }

      const uri = listingUriFor(entryFile);
      provider.set(uri, response.text);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });

      // The listing exists, so it is shown — but a build that failed part-way through produces one
      // that stops where the error did, and a truncated listing with nothing saying so reads as a
      // program that assembles to less than it does.
      if (response.errorCount) {
        void vscode.window.showWarningMessage(
          `${MESSAGE_PREFIX}this listing is from a build that reported ${response.errorCount} error${response.errorCount === 1 ? '' : 's'}, so it may stop short of the whole program.`,
        );
      }
    }),
  );
}
