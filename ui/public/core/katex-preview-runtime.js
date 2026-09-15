/**
 * HTML 产物预览 iframe 内运行：先剥一层双转义分隔符，再交给 KaTeX auto-render。
 * 由服务端在整站 HTML 响应里注入（与 deck runtime 同族），旧稿不用自带渲染器。
 */
import { typesetDom } from "./math.js";

/**
 * 对预览根做一遍 typeset。iframe 注入时自动跑；单测可对指定节点再跑。
 * @param {ParentNode|null|undefined} root
 */
export function bootKatexPreviewRuntime(root) {
  const doc = root && "ownerDocument" in root ? root.ownerDocument : globalThis.document;
  const target = root && root.nodeType !== 9
    ? root
    : (doc?.body || doc?.documentElement || null);
  typesetDom(target);
}

if (!globalThis.__agentKatexHooked && globalThis.document) {
  globalThis.__agentKatexHooked = true;
  const go = () => bootKatexPreviewRuntime(document.body || document.documentElement);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
}
