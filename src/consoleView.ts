/**
 * A view of the shared Octave session's Command Window: the HTML Command Window (webview) or the raw
 * terminal. The session manager broadcasts everything to all attached views, so they show the same history.
 */
export interface ConsoleView {
  /** A command the session sends on the user's behalf (shown as `>> code`). */
  echoCommand(display: string): void;
  /** Octave output. */
  writeOutput(text: string, stream: 'out' | 'err'): void;
  /** Octave waits for the next command ('more': a continuation line). */
  showPrompt(kind: 'ready' | 'more' | 'debug'): void;
  /** A command started running. */
  setBusy(): void;
  /**
   * The running command waits for a line on stdin (`source`: input, yes_or_no or pause). Its prompt text, if
   * any, has already been written as output.
   */
  requestInput(source: string): void;
  /** A line typed in another view answered an input request (Octave does not echo stdin). */
  echoInput(text: string): void;
  /** clc / home: clear the view. */
  clearScreen(): void;
  /** An informational line (session started, exited, ...). */
  info(text: string): void;
  /** The Octave process has gone away: forget the prompt and input state. */
  resetInput(): void;
}
