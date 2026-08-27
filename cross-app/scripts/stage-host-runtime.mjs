import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crossRoot = resolve(here, '..');
const repoRoot = resolve(crossRoot, '..');
const stageRoot = join(crossRoot, '.host-runtime');
const appRoot = join(stageRoot, 'app');
if (relative(crossRoot, stageRoot).startsWith('..')) throw new Error(`Unsafe staging path: ${stageRoot}`);

const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('host:stage must be launched through npm so npm_execpath is available');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, stdio: 'inherit', windowsHide: true,
});
runNpm(['run', 'build'], repoRoot);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(appRoot, { recursive: true });
for (const name of ['package.json', 'package-lock.json']) cpSync(join(repoRoot, name), join(appRoot, name));
cpSync(join(repoRoot, 'dist'), join(appRoot, 'dist'), { recursive: true });
runNpm(['ci', '--omit=dev', '--ignore-scripts'], appRoot);

const required = [
  'dist/ui/serve.js',
  'dist/ui/history-backup.js',
  'node_modules/@anthropic-ai/sdk/package.json',
  'node_modules/openai/package.json',
];
for (const name of required) {
  if (!existsSync(join(appRoot, name))) throw new Error(`Desktop host runtime missing: ${name}`);
}
for (const forbidden of ['node_modules/vitest', 'node_modules/typescript', 'node_modules/tsx']) {
  if (existsSync(join(appRoot, forbidden))) throw new Error(`Desktop host runtime contains dev dependency: ${forbidden}`);
}
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
writeFileSync(join(stageRoot, 'manifest.json'), `${JSON.stringify({ version: rootPackage.version, required }, null, 2)}\n`);
console.log(`Desktop host runtime staged at ${appRoot}`);
