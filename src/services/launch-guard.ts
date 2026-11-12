import koffi from 'koffi';
import path from 'node:path';

// A process started from inside an MSIX package (the Claude or Codex desktop apps) inherits the package
// container, and Windows then redirects its AppData writes into that package's private store.
const APPMODEL_ERROR_NO_PACKAGE = 15700;
type PackageQuery = (length: number[], name: null) => number;
let getCurrentPackageFullName: PackageQuery | null = null;
try {
  getCurrentPackageFullName = koffi.load('kernel32.dll').func('int32_t __stdcall GetCurrentPackageFullName(_Inout_ uint32_t*, void*)') as unknown as PackageQuery;
} catch { getCurrentPackageFullName = null; }

export function insidePackage(query: typeof getCurrentPackageFullName = getCurrentPackageFullName): boolean {
  if (!query) return false;
  try {
    // With no buffer the call answers only whether a package identity exists.
    return query([0], null) !== APPMODEL_ERROR_NO_PACKAGE;
  } catch { return false; }
}
// A Claude Code or Codex session marks every child it starts; on Windows those children can inherit the app's AppData
// redirection even when GetCurrentPackageFullName reports no package identity (measured 2026-10-09).
const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'];
export function startedByAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_MARKERS.some(name => typeof env[name] === 'string' && env[name] !== '');
}
export function startupShortcut(appData: string | undefined | null = process.env.APPDATA ?? null): string | null {
  return appData ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Limiter.lnk') : null;
}
// Arguments meant for a running instance are kept; a plain launch is handed to Explorer, which starts it outside the package.
export function relayArgs(argv: readonly string[]): string[] {
  return argv.filter(arg => arg === '--quit' || arg === '--diagnose' || arg.startsWith('--claude-'));
}
