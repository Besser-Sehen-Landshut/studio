/**
 * What the comment tokenizers of the built-in proofs share (src/proofs.ts, src/proof-languages.ts):
 * the runs they cut a file into, and the one way they give up.
 */

/**
 * A run of the file. A comment keeps its kind while the tokenizer runs; `meaningful` marks one
 * that must stay byte for byte, and nothing in the tokenizer reads that flag. `eol` marks a line
 * comment: it always ends a line.
 */
export type Seg = {
  kind: 'code' | 'string' | 'comment' | 'ws';
  text: string;
  meaningful?: true;
  eol?: true;
};

/** Thrown for anything the tokenizer cannot classify for sure. */
export class Unclassifiable extends Error {}

/** Gives up on the file; a declared function, so that a call narrows types where it stands. */
export function no(why: string): never {
  throw new Unclassifiable(why);
}

/**
 * Collects segments. Each comment is classified the moment it is read, on its own, and keeps its
 * kind; comments are never merged, so a plain comment cannot hide a meaningful one right behind
 * it. Only whitespace and code runs are merged.
 */
export class Out {
  segs: Seg[] = [];
  private readonly meaningful: (text: string) => boolean;
  constructor(meaningful: (text: string) => boolean) {
    this.meaningful = meaningful;
  }
  push(kind: Seg['kind'], text: string, opts: { eol?: boolean; meaningful?: boolean } = {}): void {
    if (text === '') return;
    if (kind === 'comment') {
      const m = opts.meaningful === true || this.meaningful(text);
      this.segs.push({
        kind,
        text,
        ...(m ? { meaningful: true as const } : {}),
        ...(opts.eol === true ? { eol: true as const } : {}),
      });
      return;
    }
    const last = this.segs.at(-1);
    if (last !== undefined && last.kind === kind && (kind === 'ws' || kind === 'code')) {
      last.text += text;
    } else this.segs.push({ kind, text });
  }
}
