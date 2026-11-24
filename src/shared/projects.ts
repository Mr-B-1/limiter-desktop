// Shapes for the per-project ranking shown in the Claude and Codex details panels; no Node imports, the renderer bundles this too.
export const WORKSPACE_ROOT_LABEL = 'workspace root';
export const CODEX_APP_LABEL = 'Codex app folder';
export const OUTSIDE_LABEL = 'outside workspace';
export const TOP_ROWS = 5;

// workspace is the folder whose first-level folders are the projects; null groups usage by each session's own folder name.
export interface ProjectRoots { workspace: string | null; codexApp: string; }
export interface ProjectRow { name: string; share: number; units: number; tokens: number; }
export interface ProjectCoverage { files: number; read: number; skipped: number; unreadable: number; withoutTokens: number; malformedLines: number; sessions: number; }
export interface ProjectsView {
  rows: ProjectRow[];
  // Milliseconds, [start, end); end is null for a rolling window with no known reset.
  window: { start: number; end: number | null };
  coverage: ProjectCoverage | null;
  status: 'ok' | 'degraded';
  totalUnits: number;
  totalTokens: number;
}

// The projects folder is a user setting (Settings, Projects folder); the Codex app folder hangs off the home folder.
export function defaultRoots(home: string, workspace: string | null = null): ProjectRoots {
  return { workspace, codexApp: home.replace(/[\\/]+$/, '') + '\\Documents\\Codex' };
}
function normalize(value: string): string {
  return value.replaceAll('/', '\\').replace(/[\\]+$/, '');
}
// Windows drive and UNC paths share a case-insensitive identity; display names keep their original spelling.
export function projectKey(cwd: unknown, name: string): string {
  return typeof cwd === 'string' && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd) ? name.toLowerCase() : name;
}
// With a projects folder, a project is its first-level folder and the two outside rows keep totals honest.
// Without one, each session counts under its own folder name, so a fresh install ranks something useful.
export function projectLabel(cwd: unknown, roots: ProjectRoots): string {
  if (typeof cwd !== 'string' || !cwd) return OUTSIDE_LABEL;
  const folder = normalize(cwd);
  const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd);
  const comparable = (value: string) => windows ? value.toLowerCase() : value;
  const key = comparable(folder);
  if (roots.workspace) {
    const workspace = comparable(normalize(roots.workspace));
    if (key === workspace) return WORKSPACE_ROOT_LABEL;
    if (key.startsWith(workspace + '\\')) return folder.slice(workspace.length + 1).split('\\')[0] || WORKSPACE_ROOT_LABEL;
  }
  const codexApp = comparable(normalize(roots.codexApp));
  if (key === codexApp || key.startsWith(codexApp + '\\')) return CODEX_APP_LABEL;
  if (roots.workspace) return OUTSIDE_LABEL;
  return folder.split('\\').filter(Boolean).pop() || OUTSIDE_LABEL;
}
