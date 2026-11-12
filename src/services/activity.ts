// Pauses network reads while nobody is at the PC: idle past the threshold, or the screen locked.
export const IDLE_SECONDS = 5 * 60;

export class ActivityGate {
  private idle = false;
  private locked = false;
  constructor(private readonly idleSeconds: () => number, private readonly onIdle: () => void, private readonly onActive: () => void, private readonly threshold = IDLE_SECONDS) {}
  get paused(): boolean { return this.idle; }
  lock(): void { this.locked = true; this.tick(); }
  unlock(): void { this.locked = false; this.tick(); }
  // Called on a timer; only a transition fires a callback, so a long idle costs nothing.
  tick(): void {
    const idle = this.locked || this.idleSeconds() >= this.threshold;
    if (idle === this.idle) return;
    this.idle = idle;
    if (idle) this.onIdle(); else this.onActive();
  }
}
