// Turns the path in every `include 'foo.inc'` into a real link.
//
// Go-to-definition already jumps through an include (see definition.ts), but a link is a different
// affordance: it underlines on hover without needing a modifier key, shows the resolved target in
// a tooltip, and — most useful of all — is *absent* when the path does not resolve. That absence
// is diagnostic in itself for the single most common fasmg setup failure, an `include` that needs
// fasm2Studio.includePath set to be found at all.

import { DocumentLink } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { toLspRange } from '../lspUtils';
import { Workspace } from '../workspace';

export function getDocumentLinks(workspace: Workspace, uri: string): DocumentLink[] {
  const doc = workspace.getDocument(uri);
  if (!doc) return [];

  const links: DocumentLink[] = [];
  for (const include of doc.includes) {
    const target = workspace.resolveIncludeUri(uri, include.path);
    // An unresolvable include gets no link at all. Offering one that fails on click would be
    // worse than nothing: it would suggest the path is fine and the editor is broken, when in
    // fact the path is exactly what needs fixing.
    if (!target) continue;
    links.push({
      range: toLspRange(include.range),
      target,
      tooltip: URI.parse(target).fsPath,
    });
  }
  return links;
}
