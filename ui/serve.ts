/**
 * Web 宿主 launcher。
 *
 * 此前仓库里没有它——`createUiServer` 只被测试调用，案例文档说的
 * "可用 tsx <launcher> 起"其实指向一个不存在的文件。
 *
 * 环境变量：
 *   AGENT_UI_PORT / PORT   监听端口，默认 4173
 *   AGENT_UI_HOST          监听地址，默认 127.0.0.1
 *   AGENT_UI_WORKDIR       工作目录（工具圈禁根），默认 process.cwd()
 *   AGENT_PACK / AGENT_PRESET  领域包
 *   其余 AGENT_* 旋钮见 src/cli.ts 头部注释
 *
 * 默认只绑 127.0.0.1 是硬要求，不是保守：这个宿主能执行 bash、能批准写文件，
 * 对外暴露等于把一个可远程执行任意命令的入口挂到网上。要跨机访问请自己在前面
 * 放带认证的反向代理，而不是把 AGENT_UI_HOST 改成 0.0.0.0。
 */
import { createUiServer } from "./server.js";

const port = Number(process.env.AGENT_UI_PORT ?? process.env.PORT ?? 4173);
const host = process.env.AGENT_UI_HOST ?? "127.0.0.1";
const packName = process.env.AGENT_PACK ?? process.env.AGENT_PRESET;

const handle = createUiServer({
  ...(packName ? { packName } : {}),
  workdir: process.env.AGENT_UI_WORKDIR ?? process.cwd(),
});

handle.server.listen(port, host, () => {
  console.log(`Harness UI → http://${host}:${port}`);
  console.log(`  workdir: ${process.env.AGENT_UI_WORKDIR ?? process.cwd()}`);
  console.log(`  pack:    ${packName ?? "(none)"}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      `  ⚠ 正在监听 ${host}——该宿主可执行 bash 并批准写文件，请确认前面有认证代理`,
    );
  }
});

handle.server.on("error", (err) => {
  console.error(`UI server failed: ${err.message}`);
  process.exit(1);
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
