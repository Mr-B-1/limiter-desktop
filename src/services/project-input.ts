import { createHash, type Hash } from 'node:crypto';
import path from 'node:path';

// Only the explicit local verification request records which bytes produced the displayed project totals.
export interface ProjectInputFile {
  key: string;
  byteLimit: number;
  mtimeMs: number;
  encoding: 'plain' | 'zstd';
  sha256: string;
}

export function projectInputFile(file: string, byteLimit: number, mtimeMs: number, digest: Hash): ProjectInputFile {
  const absolute = path.resolve(file).replaceAll('\\', '/');
  const key = createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex');
  return { key, byteLimit, mtimeMs, encoding: file.endsWith('.zst') ? 'zstd' : 'plain', sha256: digest.digest('hex') };
}
