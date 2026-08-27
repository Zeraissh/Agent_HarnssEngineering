import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const directories = [];

export function makeTmpDir() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-store-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop(), { recursive: true, force: true });
});
