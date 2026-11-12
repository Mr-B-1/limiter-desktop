// Machine types from winnt.h, as IsWow64Process2 reports them.
export const MACHINE_ARM64 = 0xaa64;
export const MACHINE_AMD64 = 0x8664;
export const DOWNLOAD_PAGE = 'https://github.com/Mr-B-1/limiter-desktop/releases/latest';

// An x64 process on an ARM64 PC runs under Windows' x64 emulation, which the release checks never test (the x64 smoke
// runs on a real x64 runner), so it points the user to the native ARM64 download instead of starting (B 2026-11-11).
export function wrongBuildForPc(processArch: string, nativeMachine: number | null): boolean {
  return processArch === 'x64' && nativeMachine === MACHINE_ARM64;
}
