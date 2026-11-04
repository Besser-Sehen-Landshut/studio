/**
 * A refusal that only means "not now": a busy lock, an item the plan does not hold right now, a
 * hold on the queue. `tick` lists it under `held` and tries again on the next tick; every other
 * error is an error. The message reads as before for the commands that throw it.
 */
export class HeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeldError';
  }
}
