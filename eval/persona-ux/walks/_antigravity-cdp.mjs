import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { chromeUserDataDirFlag, resolveChromeUserDataDir } from "../resolve-chrome-profile.mjs";

const PORT = 9258;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = resolveChromeUserDataDir({ name: "antigravity-walk" });
const OUT = "d:\\Work\\Github_pros\\Agent_Design\\eval\\persona-ux\\walks";
const STATE = `${OUT}/_antigravity-cdp-state.json`;
const URL = "http://127.0.0.1:4173/#walk=antigravity";

const cmd = process.argv[2] || "help";

async function waitPort(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      return version;
    } catch {
      await sleep(250);
    }
  }
  return null;
}

async function listPages() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function connectPage() {
  const targets = await listPages();
  const page =
    targets.find((t) => t.type === "page" && t.url.includes("walk=antigravity")) ||
    targets.find((t) => t.type === "page" && t.url.includes("4173")) ||
    targets.find((t) => t.type === "page");
  if (!page) throw new Error(`no page: ${JSON.stringify(targets)}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await send("Page.enable");
  await send("Runtime.enable");
  return { ws, send, page };
}

async function evalExpr(send, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error" };
  }
  return r.result?.value;
}

async function shot(send, name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = `${OUT}/${name}`;
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
}

if (cmd === "launch") {
  await mkdir(PROFILE, { recursive: true });
  const already = await waitPort(800);
  if (!already) {
    const chrome = spawn(
      CHROME,
      [
        `--remote-debugging-port=${PORT}`,
        chromeUserDataDirFlag(PROFILE),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--window-size=1440,960",
        URL,
      ],
      { detached: true, stdio: "ignore" },
    );
    chrome.unref();
    await writeFile(STATE, JSON.stringify({ pid: chrome.pid, port: PORT, url: URL }, null, 2));
  }
  const version = await waitPort(20000);
  if (!version) throw new Error("chrome debug port never came up");
  const { ws, send, page } = await connectPage();
  if (!page.url.includes("walk=antigravity")) {
    await send("Page.navigate", { url: URL });
    await sleep(2500);
  } else {
    await sleep(800);
  }
  const title = await evalExpr(send, "document.title");
  console.log(JSON.stringify({ ok: true, title, url: page.url, already: !!already }, null, 2));
  ws.close();
  process.exit(0);
}

if (cmd === "eval") {
  const expression = process.argv[3];
  if (!expression) throw new Error("eval needs expression");
  const { ws, send } = await connectPage();
  const value = await evalExpr(send, expression);
  console.log(JSON.stringify(value, null, 2));
  ws.close();
  process.exit(0);
}

if (cmd === "shot") {
  const name = process.argv[3] || `_antigravity-${Date.now()}.png`;
  const { ws, send } = await connectPage();
  const file = await shot(send, name);
  console.log(JSON.stringify({ ok: true, file }, null, 2));
  ws.close();
  process.exit(0);
}

if (cmd === "nav") {
  const url = process.argv[3] || URL;
  const { ws, send } = await connectPage();
  await send("Page.navigate", { url });
  await sleep(Number(process.argv[4] || 2000));
  const title = await evalExpr(send, "document.title + ' ' + location.href");
  console.log(JSON.stringify({ ok: true, title }, null, 2));
  ws.close();
  process.exit(0);
}

if (cmd === "file") {
  const expression = await readFile(process.argv[3], "utf8");
  const { ws, send } = await connectPage();
  const value = await evalExpr(send, expression);
  console.log(JSON.stringify(value, null, 2));
  ws.close();
  process.exit(0);
}

console.log("usage: launch | eval <js> | file <path> | shot <name> | nav [url] [waitMs]");
process.exit(cmd === "help" ? 0 : 1);
