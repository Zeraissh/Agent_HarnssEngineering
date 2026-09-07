/**
 * 把仓库 ui/public（唯一事实源）同步到 cross-app 根目录，供 Vite 打包
 * （浏览器 dev / Electron 外壳预览 / Capacitor webDir）与 vitest 使用。
 *
 * cross-app 不再手工维护这份静态副本——历史上它是 2025-08-13 的拷贝，
 * 已与 ui/public 严重漂移。现在由本脚本在 dev/build/test 前自动生成，
 * 产物路径已加入 cross-app/.gitignore，不进 git。
 *
 * 只用 node 内置 fs，零新依赖；Windows/macOS/Linux 通用。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crossRoot = resolve(here, '..');
const source = resolve(crossRoot, '..', 'ui', 'public');

// 同步清单：ui/public 里 Web UI 的全部静态入口（文件 + 整目录）。
const ENTRIES = ['index.html', 'app.js', 'styles.css', 'core', 'dom'];

if (!existsSync(source)) {
  throw new Error(`找不到 UI 事实源目录：${source}（应在仓库根下 ui/public）`);
}

let copied = 0;
for (const entry of ENTRIES) {
  const from = join(source, entry);
  const to = join(crossRoot, entry);
  if (!existsSync(from)) {
    throw new Error(`UI 事实源缺少必要条目：${from}`);
  }
  // 先删后拷：core/、dom/ 里被 ui/public 移除的旧文件不能残留在副本里。
  rmSync(to, { recursive: true, force: true });
  if (statSync(from).isDirectory()) mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  copied += 1;
}

console.log(`UI synced: ui/public → cross-app（${copied} 项：${ENTRIES.join(', ')}）`);
