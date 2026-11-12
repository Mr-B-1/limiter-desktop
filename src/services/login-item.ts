// Start with Windows uses Electron's per-user sign-in entry. The OS calls sit behind this adapter so tests and the packaged
// smoke never write a real Run value on the build machine.
export interface LoginItemOs {
  get(options: { path: string; args: string[]; name?: string }): { openAtLogin: boolean };
  set(options: { openAtLogin: boolean; path: string; args: string[]; name?: string }): void;
}
export class LoginItem {
  constructor(private readonly os: LoginItemOs, private readonly executable: string, private readonly name?: string) {}
  private target(): { path: string; args: string[]; name?: string } {
    return { path: this.executable, args: [], ...(this.name ? { name: this.name } : {}) };
  }
  enabled(): boolean {
    try { return this.os.get(this.target()).openAtLogin; } catch { return false; }
  }
  set(openAtLogin: boolean): void {
    this.os.set({ openAtLogin, ...this.target() });
    if (this.enabled() !== openAtLogin) throw new Error('Windows did not ' + (openAtLogin ? 'add' : 'remove') + ' the sign-in entry');
  }
}
// Used by the packaged smoke: remembers the requested state in memory only.
export function memoryLoginItemOs(): LoginItemOs & { calls: { openAtLogin: boolean; path: string }[] } {
  let state = false;
  const calls: { openAtLogin: boolean; path: string }[] = [];
  return {
    calls,
    get: () => ({ openAtLogin: state }),
    set: options => { calls.push({ openAtLogin: options.openAtLogin, path: options.path }); state = options.openAtLogin; }
  };
}
