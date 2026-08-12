// Makes the "file.asm [12]:" location headers in fasm's own error output clickable, wherever they
// appear — the build task's terminal, or a plain `fasm2 foo.asm` the user ran by hand.
//
// This exists instead of a `contributes.problemMatchers` entry because fasm's output cannot be
// expressed as one. A problem matcher's multi-line pattern matches a *fixed-length* window of
// consecutive lines (VS Code's own matcher asserts `lines.length - start === patterns.length`),
// but the distance from a fasm header to its "Error:" line varies with what went wrong:
//
//     prog.asm [5]:                                   prog.asm [5]:
//     \tmov eax, undefined_thing                      \tnotarealthing 1,2
//     mov? [3] x86.parse_operand@src [32] (CALM)      ? [4]
//     Error: symbol 'x' is undefined or out of scope. Processed: notarealthing 1,2
//                                                     Error: illegal instruction.
//
// Three lines in one case, four in the other, and a deeper macro expansion adds more. No single
// fixed-length pattern covers that, so a matcher would silently drop whichever shape it wasn't
// written for. Linking the header alone is honest about what it can do, needs no pattern at all,
// and works in terminals a task provider never sees.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseLocationHeader } from './fasmOutput';

/** Every base directory a relative compiler-printed path could be relative to, most likely first:
 * the terminal's own cwd (for this extension's build task, the source file's directory — see
 * taskProvider.ts), then each open workspace folder. */
function candidateBases(cwd: string | undefined): string[] {
  return [...(cwd ? [cwd] : []), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)];
}

async function resolveOnDisk(rawPath: string, cwd: string | undefined): Promise<string | undefined> {
  const candidates = path.isAbsolute(rawPath) ? [rawPath] : candidateBases(cwd).map((base) => path.join(base, rawPath));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try the next base
    }
  }
  return undefined;
}

function terminalCwd(terminal: vscode.Terminal | undefined): string | undefined {
  const cwd = (terminal?.creationOptions as vscode.TerminalOptions | undefined)?.cwd;
  return typeof cwd === 'string' ? cwd : cwd?.fsPath;
}

interface ResolvedLink extends vscode.TerminalLink {
  fsPath: string;
  line: number;
}

export function registerTerminalLinks(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      async provideTerminalLinks(ctx: vscode.TerminalLinkContext): Promise<ResolvedLink[]> {
        const location = parseLocationHeader(ctx.line);
        if (!location) return [];

        // Resolved here rather than on click so a line that merely *looks* like a header (a
        // trace frame that slipped through, output from some other tool) is simply not underlined,
        // instead of offering a link that fails once the user trusts it enough to click.
        const fsPath = await resolveOnDisk(location.rawPath, terminalCwd(ctx.terminal));
        if (!fsPath) return [];

        const trimmed = ctx.line.trimEnd();
        const startIndex = ctx.line.indexOf(trimmed);
        return [
          {
            startIndex: startIndex < 0 ? 0 : startIndex,
            length: trimmed.length,
            tooltip: `Open ${path.basename(fsPath)}:${location.line}`,
            fsPath,
            line: location.line,
          },
        ];
      },

      async handleTerminalLink(link: ResolvedLink): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(link.fsPath));
        const editor = await vscode.window.showTextDocument(doc);
        // fasm line numbers are 1-based; VS Code's are 0-based. Clamped because the file may have
        // been edited since the compiler reported against it.
        const position = new vscode.Position(Math.max(0, Math.min(link.line - 1, doc.lineCount - 1)), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      },
    }),
  );
}
