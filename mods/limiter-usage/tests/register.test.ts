import { expect, mock, test } from 'claude-code/testing'

const windows = [
  { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-10T00:00:00.000Z' },
  { kind: 'seven_day', percentUsed: 84, resetsAt: '2026-10-10T03:00:00.000Z' },
]
const context = { window: 1000000, tokens: 1000, percent: 0 }
// The kit resolves paths on the host it runs on, so a POSIX expectation is compared drive-free.
const posix = (path: string | undefined) => (path ?? '').replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
const echo = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
}

test('a measurement writes figures only, to the Windows default path', async ($, on) => {
  echo(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\fixture', COMPUTERNAME: 'FIXTUREPC' })
  const clock = mock.clock(on, { now: 1791600000000 })
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => { writes.push(e); return { value: undefined } })

  await $.session.measure({ context, rateLimits: windows, changed: ['rateLimits'] })

  expect(writes).toHaveLength(1)
  expect(writes[0]?.path).toBe('C:\\Users\\fixture\\.local\\share\\Limiter\\claude-usage.json')
  const written = JSON.parse(writes[0]?.text ?? '{}')
  expect(written).toEqual({
    schemaVersion: 1,
    source: 'claude-code-mod',
    host: 'FIXTUREPC',
    observedAt: clock.now(),
    rateLimits: windows,
  })
  expect(writes[0]?.text).not.toContain('token')
})

test('LIMITER_USAGE_FILE overrides the path and HOME serves Linux', async ($, on) => {
  echo(on)
  mock.env(on, { HOME: '/root', HOSTNAME: 'server', LIMITER_USAGE_FILE: '/srv/limiter/server-claude-usage.json' })
  mock.clock(on, { now: 5 })
  const writes: { path: string }[] = []
  on('fs.write', (_$, e) => { writes.push(e); return { value: undefined } })

  await $.session.measure({ context, rateLimits: windows, changed: ['rateLimits'] })

  expect(posix(writes[0]?.path)).toBe('/srv/limiter/server-claude-usage.json')
})

test('without an exported HOSTNAME the host comes from /etc/hostname', async ($, on) => {
  echo(on)
  mock.env(on, { HOME: '/root' })
  mock.clock(on, { now: 7 })
  const writes: { text: string }[] = []
  on('fs.write', (_$, e) => { writes.push(e); return { value: undefined } })
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('hostname') ? 'Server\n' : '' }))

  await $.session.measure({ context, rateLimits: windows, changed: ['rateLimits'] })

  expect(JSON.parse(writes[0]?.text ?? '{}').host).toBe('Server')
})

test('an empty reading never overwrites the file', async ($, on) => {
  echo(on)
  mock.env(on, { HOME: '/home/fixture' })
  mock.clock(on)
  const writes: unknown[] = []
  on('fs.write', (_$, e) => { writes.push(e); return { value: undefined } })

  await $.session.measure({ context, rateLimits: [], changed: ['context'] })

  expect(writes).toHaveLength(0)
})

test('session start writes what the engine already knows', async ($, on) => {
  echo(on)
  mock.env(on, { HOME: '/home/fixture', HOSTNAME: 'box' })
  mock.clock(on, { now: 42 })
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => { writes.push(e); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: windows } }))

  await $.session.start({ cwd: '/home/fixture', surface: null, isInteractive: false })

  expect(writes).toHaveLength(1)
  expect(posix(writes[0]?.path)).toBe('/home/fixture/.local/share/Limiter/claude-usage.json')
  expect(JSON.parse(writes[0]?.text ?? '{}').rateLimits).toEqual(windows)
})

test('a failed write is swallowed and the chain continues', async ($, on) => {
  echo(on)
  mock.env(on, { HOME: '/home/fixture' })
  mock.clock(on)
  on('fs.write', () => ({ deny: 'disk full' }))

  const result = await $.session.measure({ context, rateLimits: windows, changed: ['rateLimits'] })

  expect(result.changed).toEqual(['rateLimits'])
})
