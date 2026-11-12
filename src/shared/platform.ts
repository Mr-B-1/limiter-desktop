// Machine types from winnt.h, as IsWow64Process2 reports them.
export const MACHINE_ARM64 = 0xaa64;
export const MACHINE_AMD64 = 0x8664;
export const DOWNLOAD_PAGE = 'https://github.com/Mr-B-1/limiter-desktop/releases/latest';

// The x64 build crashes under Windows' x64 emulation on ARM64 PCs when it moves its desktop-parented window,
// so an x64 process on an ARM64 PC is the wrong download and must say so instead of starting.
export function wrongBuildForPc(processArch: string, nativeMachine: number | null): boolean {
  return processArch === 'x64' && nativeMachine === MACHINE_ARM64;
}
