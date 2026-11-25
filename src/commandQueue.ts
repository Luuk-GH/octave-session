/**
 * The order in which lines reach the Octave interpreter. No VS Code or process dependency, so it is unit-tested
 * directly (scripts/commandQueue.test.ts).
 *
 * Octave reads one line at a time from stdin and shows a prompt when it wants the next one, so exactly one line
 * may be "in flight": the next line is only sent once the interpreter has answered the current one with a prompt.
 * That is what keeps hidden queries (completion, help, the Workspace view) from interleaving with commands.
 *
 * - `command` and `query` jobs run in FIFO order, after everything queued before them.
 * - `background` jobs (completion pop-ups, help tooltips) are only accepted when the interpreter is at a prompt
 *   and no command is running or queued. Otherwise they are refused at once instead of waiting behind a run of
 *   unknown length. They may wait behind other hidden queries, which are short.
 */
export type JobKind = 'command' | 'query' | 'background';

export interface Job {
  kind: JobKind;
  line: string;
}

export class CommandQueue<J extends Job> {
  private readonly pending: J[] = [];
  private inFlight: J | undefined;
  private open = false;  // the interpreter is at a prompt that accepts input

  /** `send` writes a job's line to the interpreter; it is called at most once per job, one job at a time. */
  constructor(private readonly send: (job: J) => void) {}

  /** The job whose line was sent and is waiting for its prompt. */
  get current(): J | undefined { return this.inFlight; }
  /** Jobs waiting to be sent (not counting the current one). */
  get waiting(): number { return this.pending.length; }
  /** Current plus waiting jobs. */
  get size(): number { return this.pending.length + (this.inFlight ? 1 : 0); }
  /** True when nothing is running or queued and the interpreter accepts input. */
  get idle(): boolean { return this.open && !this.inFlight && !this.pending.length; }
  /** True when the interpreter accepts input and no command (as opposed to a hidden query) is running or queued. */
  get commandFree(): boolean {
    return this.open && this.inFlight?.kind !== 'command' && !this.pending.some(j => j.kind === 'command');
  }

  /**
   * Queue a job. Returns false (and does not keep the job) for a background job that cannot run right away;
   * the caller then reports it as skipped.
   */
  push(job: J): boolean {
    if (job.kind === 'background' && !this.commandFree) { return false; }
    this.pending.push(job);
    this.pump();
    return true;
  }

  /**
   * The interpreter showed a prompt (or became ready for the first time, with `open` true). Returns the job
   * that this prompt finished, if any, and sends the next job. `open` is false when the prompt does not take
   * new commands (e.g. the interpreter is shutting down). `beforeNext` runs after the current job is finished
   * (no longer counted in `size`) and before the next one is sent.
   */
  prompt(open = true, beforeNext?: (done: J | undefined) => void): J | undefined {
    const done = this.inFlight;
    this.inFlight = undefined;
    this.open = open;
    // Listeners of the finished job (and of the prompt) run before the next line goes out.
    beforeNext?.(done);
    this.pump();
    return done;
  }

  /** Drop the jobs that have not been sent yet (e.g. after an interrupt). Returns them. */
  cancelWaiting(): J[] {
    return this.pending.splice(0);
  }

  /** Drop everything, including the current job (the interpreter is gone). Returns them, current first. */
  cancelAll(): J[] {
    const all = this.inFlight ? [this.inFlight, ...this.pending] : [...this.pending];
    this.inFlight = undefined;
    this.pending.length = 0;
    this.open = false;
    return all;
  }

  private pump(): void {
    if (this.inFlight || !this.open) { return; }
    const next = this.pending.shift();
    if (!next) { return; }
    this.inFlight = next;
    this.send(next);
  }
}
