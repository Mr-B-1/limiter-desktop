import type { Register, SessionRateLimit } from 'claude-code'

// Limiter's Claude row is exact only while Claude Code tells it the account's own
// plan windows. The desktop Code tab never runs the status line, so this mod takes
// the same figures from the engine (`$.session.usage()`, pushed on every
// `session.measure`) and writes them where Limiter looks. Figures only: no token,
// no transcript text, no session id ever reaches the file.

export const SCHEMA_VERSION = 1
export const DEFAULT_RELATIVE_PATH = '.local/share/Limiter/claude-usage.json'

type Engine = Parameters<Parameters<Register>[0]>[2] extends (...args: infer A) => unknown
  ? A[0]
  : never

type Snapshot = {
  schemaVersion: typeof SCHEMA_VERSION
  source: 'claude-code-mod'
  host: string
  observedAt: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

// Keep only the three documented fields of each window, so nothing else can leak.
export function pick(limits: readonly SessionRateLimit[]): Snapshot['rateLimits'] {
  return limits
    .filter(limit => typeof limit.kind === 'string' && Number.isFinite(limit.percentUsed))
    .map(limit => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      ...(typeof limit.resetsAt === 'string' ? { resetsAt: limit.resetsAt } : {}),
    }))
}

async function outputPath($: Engine): Promise<string | null> {
  const configured = await $.env.get('LIMITER_USAGE_FILE')
  if (configured) return configured
  // USERPROFILE on Windows, HOME elsewhere; the path sits outside AppData on purpose,
  // because a process started inside an MSIX package has AppData redirected.
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return null
  const separator = home.includes('\\') ? '\\' : '/'
  return home.replace(/[\\/]+$/, '') + separator + DEFAULT_RELATIVE_PATH.split('/').join(separator)
}

async function hostName($: Engine): Promise<string> {
  const fromEnv = (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME'))
  if (fromEnv) return fromEnv
  // A Linux shell keeps HOSTNAME unexported, so a headless session has to read the file.
  try {
    const name = (await $.fs.read('/etc/hostname')).trim()
    if (name) return name.slice(0, 64)
  } catch { /* Not a Linux host, or the file is unreadable. */ }
  return 'unknown'
}

async function save($: Engine, limits: readonly SessionRateLimit[]): Promise<void> {
  const rateLimits = pick(limits)
  // An empty reading says nothing; an earlier session's figures stay in the file.
  if (rateLimits.length === 0) return
  const path = await outputPath($)
  if (!path) return
  const snapshot: Snapshot = {
    schemaVersion: SCHEMA_VERSION,
    source: 'claude-code-mod',
    host: await hostName($),
    observedAt: await $.clock.now(),
    rateLimits,
  }
  try {
    await $.fs.write(path, JSON.stringify(snapshot) + '\n')
  } catch (error) {
    // A failed write must never stop the session; Limiter shows the last good file as stale.
    $.ui.log(`limiter-usage: could not write ${path}: ${error instanceof Error ? error.message : 'unknown error'}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await save($, usage.rateLimits)
    return next(e)
  })

  // Fires after each main-thread turn and whenever a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    await save($, e.rateLimits)
    return next(e)
  })
}
