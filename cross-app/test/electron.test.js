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

  it('一键启动接线：先探已有宿主再自拉起，退出必收进程树，attach 模式不杀别人的宿主', () => {
    const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
    expect(main).toContain("require('./host-launcher.cjs')");
    expect(main).toContain('probeHealthy'); // 老工作流（宿主已在跑）保持直连
    expect(main).toContain('resolveHostEntry');
    expect(main).toContain("app.on('will-quit'");
    expect(main).toContain('stopHostTree'); // 关窗即收树，不留僵尸 node
    // 退出闸门：quitting 先无条件置位（封死启动窗口期关窗留孤儿宿主的微任务缝），
    // attach 模式 hostChild 恒为 null → 不杀别人的宿主
    expect(main).toMatch(/quitting = true;\s*\n\s*if \(!hostChild\) return;/);
    expect(main).toMatch(/if \(quitting\) throw new Error/); // spawn 前同步块内的竞态防线
    // 加载页被正式页顶掉的 ERR_ABORTED 不是失败——锁整句含 return，
    // 只锁 token 的话"判了不早退"的变异（正好还原真机抓到的缺陷本体）会绿
    expect(main).toMatch(/if \(error && error\.code === 'ERR_ABORTED'\) return;/);
    // 收树在途的二次 quit（macOS 连按 Cmd+Q）必须拦下等 app.exit，
    // 放行默认退出会跳过 SIGKILL 升级与残留告警
    expect(main).toMatch(/if \(cleanup\) \{[\s\S]{0,300}?event\.preventDefault\(\);/);
    // 子进程死亡 ≠ 界面坏死：探活误判场景下窗口连的原宿主仍健康，
    // 错误页覆盖前必须先复核 harnessHref
    expect(main).toContain('probeHealthy(harnessHref)');
  });

  it('宿主入口清掉壳注入的 ELECTRON_RUN_AS_NODE，不让它透传进 bash 子命令', () => {
    const serve = readFileSync(join(root, '..', 'ui', 'serve.ts'), 'utf8');
    expect(serve).toContain('delete process.env.ELECTRON_RUN_AS_NODE');
  });

  it('host-launcher 是纯 Node 模块：不依赖 electron，才能做真实行为测试', () => {
    const launcher = readFileSync(join(root, 'electron', 'host-launcher.cjs'), 'utf8');
    expect(launcher).not.toContain("require('electron')");
  });

  it('桌面工作目录只能经原生目录选择器授权，并作为宿主白名单注入', () => {
    const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
    expect(main).toContain("properties: ['openDirectory', 'createDirectory']");
    expect(main).toContain('AGENT_UI_WORKDIR: workspaceState.selected');
    expect(main).toContain('AGENT_UI_WORKDIRS: workspaceState.directories.join(path.delimiter)');
    expect(main).toContain('workspaceStore.saveWorkspaceState');
    expect(main).not.toMatch(/ipcMain|ipcRenderer/);
    expect(main).toMatch(/if \(!clean\) \{[\s\S]{0,200}?hostChild = child;/);
  });

  it('发布脚本先做签名门禁，builder 携带自包含的生产宿主', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
    expect(pkg.scripts['desktop:dist']).toContain('require-signing.mjs');
    expect(builder).toMatch(/asar:\s*true/);
    expect(builder).not.toMatch(/^\s*-\s+dist\s*$/m);
    expect(builder).toMatch(/from:\s*\.host-runtime\/app/);
    expect(builder).toMatch(/to:\s*harness/);
    expect(main).toContain("app.isPackaged ? path.join(process.resourcesPath, 'harness')");
  });

  it('Android 禁止明文 HTTP，移动端生产连接必须走 HTTPS', () => {
    const config = readFileSync(join(root, 'capacitor.config.ts'), 'utf8');
    expect(config).toMatch(/androidScheme:\s*'https'/);
    expect(config).toMatch(/cleartext:\s*false/);
  });
});
