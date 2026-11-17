import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseRegZone } from '../shared/platform.js';

// Reads the Windows time zone ID from the registry. reg.exe is called by its full path so PATH cannot substitute another
// program; it runs once at start-up, and only on a PC whose zone ICU cannot name.
export function windowsZoneId(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const output = execFileSync(reg, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation', '/v', 'TimeZoneKeyName'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return parseRegZone(output);
  } catch (error) {
    console.error('Could not read the Windows time zone; times use the default zone', error);
    return null;
  }
}
