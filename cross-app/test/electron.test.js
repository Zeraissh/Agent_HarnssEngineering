import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('production desktop shell', () => {
  it('始终加载当前 Harness 宿主，不再打包一份会漂移的旧 WebUI', () => {
    const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
    expect(main).toContain('AGENT_UI_URL');
    expect(main).toContain('loadURL');
    expect(main).not.toContain('loadFile(');
    expect(main).not.toContain("'..', 'dist', 'index.html'");
  });

  it('远程页面没有 Node/预加载桥，渲染器启用 sandbox 与上下文隔离', () => {
    const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).not.toMatch(/preload:/);
  });

  it('发布脚本先做签名门禁，builder 只装 Electron 外壳', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(pkg.scripts['desktop:dist']).toContain('require-signing.mjs');
    expect(builder).toMatch(/asar:\s*true/);
    expect(builder).not.toMatch(/^\s*-\s+dist\s*$/m);
  });

  it('Android 禁止明文 HTTP，移动端生产连接必须走 HTTPS', () => {
    const config = readFileSync(join(root, 'capacitor.config.ts'), 'utf8');
    expect(config).toMatch(/androidScheme:\s*'https'/);
    expect(config).toMatch(/cleartext:\s*false/);
  });
});
