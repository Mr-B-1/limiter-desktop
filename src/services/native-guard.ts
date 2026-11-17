// SetParent, SetWindowLongPtr, SetWindowPos and WindowFromPoint can make Windows send messages to our own window, and
// Electron turns those messages into JS events while the call is still running on koffi's own call stack. A koffi call
// started from such an event begins at the top of that same stack and overwrites the running call (the x64 crash
// fixed in 0.7.0). Wrap message-sending calls in send(); every other desktop call checks ready() first and throws.
export class NativeGuard {
  private depth = 0;
  get sending(): boolean { return this.depth > 0; }
  send<T>(call: () => T): T {
    this.depth++;
    try { return call(); } finally { this.depth--; }
  }
  ready(): void {
    if (this.depth > 0) throw new Error('Desktop call made from inside a window message');
  }
}
