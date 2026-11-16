/**
 * One supersession gate for a long-running path: whoever began last owns every write.
 *
 * Comparing a run against "the controller currently in a ref" protects a run replaced by a *newer
 * search*, but not one invalidated from outside — changing the engine set mid-run left the old
 * fetch in flight and its results landed on top of the new selection. An epoch makes staleness a
 * property of the run itself, so any trigger can supersede it, and aborting alone cannot let a
 * write through when an engine ignores the signal.
 */

export interface ActiveRun {
  controller: AbortController;
  /** the epoch this run owns; every run gets a new one */
  epoch: number;
  /** false once anything newer began or the run was superseded: this run must not write */
  isCurrent: () => boolean;
}

export class RunGuard {
  private epoch = 0;
  private current: ActiveRun | null = null;

  /** Start a run, aborting whatever is in flight so its late answers cannot land. */
  begin(): ActiveRun {
    this.current?.controller.abort();
    const epoch = ++this.epoch;
    const controller = new AbortController();
    const run: ActiveRun = { controller, epoch, isCurrent: () => this.epoch === epoch };
    this.current = run;
    return run;
  }

  /**
   * Invalidate whatever is in flight without starting a run — what an engine-set change, a preset
   * change or a cancel should call. Returns false when nothing was running.
   */
  supersede(): boolean {
    const running = this.current;
    if (!running || running.controller.signal.aborted) return false;
    // every existing run is stale from here, whether or not it is the one being aborted
    this.epoch += 1;
    running.controller.abort();
    return true;
  }

  /** the active run's signal is aborted; nothing running reads as not aborted */
  get aborted(): boolean {
    return Boolean(this.current?.controller.signal.aborted);
  }

  /** a run exists and has not been aborted */
  get running(): boolean {
    return this.current !== null && !this.aborted;
  }
}
