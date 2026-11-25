import * as fs from 'fs';
import { parse } from './parser';
import { cleanTexinfo, parseDeftypefn, Signature, signatureFromDeclaration } from './signatures';

/** Usage forms and a short description of a function, from Octave's help (see the __vsc_sig__ helper). */
export interface HelpInfo { signatures: Signature[]; doc: string; /** Defining m-file, if any. */ file?: string; }

/** Build signatures and a description from __vsc_sig__ records. */
export function helpFromRecords(name: string, recs: string[][]): HelpInfo | undefined {
  const fmt = recs.find(r => r[0] === 'FMT')?.[1];
  if (!fmt || fmt === 'Not found') { return undefined; }
  const signatures: Signature[] = [];
  for (const r of recs) {
    if (r[0] === 'SIG') { const s = parseDeftypefn(r[1]); if (s) { signatures.push(s); } }
  }
  const file = recs.find(r => r[0] === 'FILE')?.[1];
  if (!signatures.length && file) {
    // Plain-text help (your own functions): take the declaration from the file.
    try {
      const f = parse(fs.readFileSync(file, 'utf8').split(/\r?\n/)).functions;
      const decl = f.find(x => x.name === name) ?? f[0];
      if (decl) { signatures.push(signatureFromDeclaration(decl.signature)); }
    } catch { /* unreadable file */ }
  }
  const rawDoc = recs.find(r => r[0] === 'DOC')?.[1] ?? '';
  const doc = fmt === 'texinfo' ? cleanTexinfo(rawDoc) : rawDoc.trim();
  return { signatures, doc, file };
}
