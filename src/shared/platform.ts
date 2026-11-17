// Machine types from winnt.h, as IsWow64Process2 reports them.
export const MACHINE_ARM64 = 0xaa64;
export const MACHINE_AMD64 = 0x8664;
export const DOWNLOAD_PAGE = 'https://github.com/Mr-B-1/limiter-desktop/releases/latest';

// An x64 process on an ARM64 PC runs under Windows' x64 emulation, which the release checks never test (the x64 smoke
// runs on a real x64 runner), so it points the user to the native ARM64 download instead of starting.
export function wrongBuildForPc(processArch: string, nativeMachine: number | null): boolean {
  return processArch === 'x64' && nativeMachine === MACHINE_ARM64;
}

// Windows time zone IDs that the bundled ICU cannot map yet. Windows added British Columbia Standard Time for BC's move to
// permanent UTC-7 in November 2026; on a PC set to it, ICU reports no time zone and formats every time an hour early in UTC-8.
const WINDOWS_ZONES: Record<string, string> = { 'British Columbia Standard Time': 'America/Vancouver' };

// The zone to show times in: ICU's own answer when it has one, else the mapped Windows zone, else undefined (ICU's default).
// The Windows lookup is a function so a PC whose zone ICU already knows never pays for it.
export function displayTimeZone(icuZone: string | undefined, windowsZoneId: () => string | null): string | undefined {
  if (icuZone && icuZone !== 'Etc/Unknown') return icuZone;
  const id = windowsZoneId();
  return id ? WINDOWS_ZONES[id] : undefined;
}

// Reads the zone ID from `reg query ...\TimeZoneInformation /v TimeZoneKeyName` output.
export function parseRegZone(output: string): string | null {
  return /TimeZoneKeyName\s+REG_SZ\s+(.+?)\s*$/m.exec(output)?.[1] ?? null;
}
