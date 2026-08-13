// "Run | Debug | Build" above the line that makes a file a program.
//
// Every other way to start a build is either a chord to remember, a palette search, or a ▷ button
// that looks identical in every language — none of which say *what* they will act on. That matters
// more here than in most languages: `include` graphs mean the file you are looking at frequently is
// not the file that gets assembled, and the extension already resolves that silently. A lens
// anchored to the `format` directive puts the affordance on the one line that identifies an entry
// point, so it appears exactly on the files these commands act on directly, and nowhere else.
//
// Fragments deliberately get no lens. They build fine (the commands resolve them to whichever entry
// point includes them), but an .inc included by four programs has no single answer to put in a lens
// label, and offering "Run" on a file that cannot run standalone would misdescribe what happens.
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { isFasmDocument } from './activeEditor';
import { fasmConfig } from './config';

/** Set by extension.ts once the client exists; the provider is registered before that. */
type ClientGetter = () => LanguageClient | undefined;

/**
 * The first line whose leading token is `format`, which is what makes a file an entry point rather
 * than a fragment.
 *
 * Matched case-insensitively on purpose. fasmg is case-sensitive and fasm1 is not, so a lowercase-
 * only match would drop the lens on perfectly valid `FORMAT PE CONSOLE` fasm1 sources; the cost of
 * being wrong in the other direction is a lens one line off in a file the server already agreed is
 * an entry point, which is why this only ever runs *after* that agreement.
 */
function formatDirectiveLine(document: vscode.TextDocument): number {
  for (let line = 0; line < document.lineCount; line++) {
    if (/^\s*format\b/i.test(document.lineAt(line).text)) return line;
  }
  return 0;
}

export class FasmCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly getClient: ClientGetter) {}

  /** Re-asks the server which files are entry points. The answer changes when a `format` directive
   * is added or removed, and when an include is written that pulls a fragment into a program. */
  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (!isFasmDocument(document) || document.isUntitled) return [];
    if (!fasmConfig(document.uri).get<boolean>('codeLens', true)) return [];

    const client = this.getClient();
    if (!client) return [];

    // Asking the server rather than scanning for `format` here: a `format` directive can arrive
    // through an include, and the server already owns that graph (findReachableEntryPoints). A
    // client-side regex would disagree with the entry point the commands actually build.
    let entryUris: string[];
    try {
      ({ entryUris } = await client.sendRequest<{ entryUris: string[] }>('fasm2Studio/listEntryPoints', {}, token));
    } catch {
      // A lens is an affordance, not a result: a server that is restarting or has gone away should
      // leave the gutter clean rather than raise an error over a decoration.
      return [];
    }
    if (token.isCancellationRequested) return [];
    // Re-parsed rather than string-compared as received: the server's URIs come back over the wire
    // from several producers (didOpen, the file watcher), and only a round trip through Uri
    // normalizes percent-encoding and drive-letter case the same way document.uri.toString() does.
    const self = document.uri.toString();
    if (!entryUris.some((entryUri) => vscode.Uri.parse(entryUri).toString() === self)) return [];

    const range = document.lineAt(formatDirectiveLine(document)).range;
    // Ordered as the editor title bar orders them, so the two places that offer these commands do
    // not disagree about which one is the primary action.
    return [
      new vscode.CodeLens(range, { title: '$(play) Run', tooltip: 'Assemble this program and run it', command: 'fasm2Studio.buildAndRun', arguments: [document.uri] }),
      new vscode.CodeLens(range, { title: '$(debug-alt) Debug', tooltip: 'Assemble this program with debug info and start gdb', command: 'fasm2Studio.debug', arguments: [document.uri] }),
      new vscode.CodeLens(range, { title: '$(tools) Build', tooltip: 'Assemble this program without running it', command: 'fasm2Studio.build', arguments: [document.uri] }),
    ];
  }
}

export function registerCodeLens(context: vscode.ExtensionContext, getClient: ClientGetter): FasmCodeLensProvider {
  const provider = new FasmCodeLensProvider(getClient);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'fasm' }, provider),
    // Toggling the setting has to reach lenses already on screen; without this the change only
    // takes effect on the next edit to each open file.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fasm2Studio.codeLens')) provider.refresh();
    }),
  );
  return provider;
}
