const MAX_CHARS = 64 * 1024;

/** The part of a terminal stream this reader needs (`process.stdin` fits). */
export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', fn: (chunk: string) => void): unknown;
  removeListener(event: 'data', fn: (chunk: string) => void): unknown;
}

/**
 * One line from a terminal without echo. Undefined when the input is no terminal or the user aborts
 * (Ctrl-C, Ctrl-D). Raw mode is always switched off again.
 */
export function readHiddenLine(
  prompt: string,
  input: HiddenInput,
  write: (s: string) => void,
): Promise<string | undefined> {
  if (!input.isTTY || !input.setRawMode) return Promise.resolve(undefined);
  write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve) => {
    let value = '';
    const done = (result: string | undefined) => {
      input.removeListener('data', onData);
      input.setRawMode?.(false);
      input.pause();
      write('\n');
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003' || ch === '\u0004') return done(undefined);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (value.length >= MAX_CHARS) return done(undefined);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}
