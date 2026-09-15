/**
 * 飞书入站隧道说明书。只打印命令，不拉起 cloudflared，不对外裸开整站。
 * 不读、不印 ENCRYPT_KEY / webhook。
 */
import {
  formatImTunnelInstructions,
  resolveImPublicBase,
} from "../src/notify.js";

const rawPort = Number(process.env.AGENT_UI_PORT ?? process.env.PORT ?? 4173);
const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : 4173;

process.stdout.write(
  formatImTunnelInstructions({
    port,
    publicBase: resolveImPublicBase(process.env),
  }),
);
