/**
 * OPS-01 — schema 迁移 / 在途升级演练。
 *
 * 不 bump RUN_STATE_VERSION。只证明：当前 interrupted 档案可分类为 current；
 * 未来 version 必须 unsupported_version（不是 malformed），同 run 续跑读不到它。
 *
 * 用法：npm run ops:schema-migrate-drill
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDurableRunState } from "../ui/history.js";
import { initialRunState, transitionRunState } from "../src/run-state.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".ops-schema-drill");

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

let interrupted = transitionRunState(initialRunState("ops-inflight"), { type: "start" })!;
interrupted = transitionRunState(interrupted, { type: "interrupt" })!;

const currentPath = path.join(root, "v1-interrupted.json");
const futurePath = path.join(root, "v2-future.json");
await writeFile(currentPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");
await writeFile(futurePath, `${JSON.stringify({ ...interrupted, version: 2 }, null, 2)}\n`, "utf8");

const current = classifyDurableRunState(JSON.parse(await readFile(currentPath, "utf8")));
const future = classifyDurableRunState(JSON.parse(await readFile(futurePath, "utf8")));

if (!current.ok || current.reason !== "current") {
  console.error("v1 interrupted must classify as current", current);
  process.exit(1);
}
if (future.ok || future.reason !== "unsupported_version" || future.version !== 2) {
  console.error("v2 must fail-closed as unsupported_version (not malformed)", future);
  process.exit(1);
}

console.log("OPS-01 schema migrate drill ok");
console.log("  v1 interrupted → current (same-run resume may proceed if checkpoint exists)");
console.log("  v2 future      → unsupported_version (in-flight upgrade: refuse same-run resume)");
console.log(`  fixtures: ${root}`);
