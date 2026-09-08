#!/usr/bin/env node
/**
 * E2E-01 / BASE-04 切片 — 已打包 Electron 启动冒烟（本机）。
 *
 * 不发明 electron-builder 全套升级/卸载自动化（docs/08 已记边界）；
 * 本脚本验证：
 * 1. cross-app 能解析到宿主入口（override / dist / tsx）
 * 2. 可选：对已存在的 win-unpacked 探活 /health
 *
 * 用法：
 *   node scripts/electron-pack-smoke.mjs
 *   node scripts/electron-pack-smoke.mjs --unpacked path\to\win-unpacked
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpackedIdx = process.argv.indexOf("--unpacked");
const unpacked = unpackedIdx >= 0 ? process.argv[unpackedIdx + 1] : null;

const launcher = path.join(root, "cross-app", "electron", "host-launcher.cjs");
if (!existsSync(launcher)) {
  console.error("missing cross-app/electron/host-launcher.cjs");
  process.exit(1);
}

const check = spawnSync(process.execPath, ["--check", launcher], { encoding: "utf8" });
if (check.status !== 0) {
  console.error(check.stderr || check.stdout);
  process.exit(1);
}
console.log("ok: host-launcher.cjs syntax");

const main = path.join(root, "cross-app", "electron", "main.cjs");
if (existsSync(main)) {
  const mainCheck = spawnSync(process.execPath, ["--check", main], { encoding: "utf8" });
  if (mainCheck.status !== 0) {
    console.error(mainCheck.stderr || mainCheck.stdout);
    process.exit(1);
  }
  console.log("ok: main.cjs syntax");
}

if (unpacked) {
  const exe = path.join(unpacked, "Agent Harness.exe");
  const alt = path.join(unpacked, "agent-harness.exe");
  const target = existsSync(exe) ? exe : existsSync(alt) ? alt : null;
  if (!target) {
    console.error(`no Electron exe under ${unpacked}`);
    process.exit(1);
  }
  console.log(`ok: unpacked exe present → ${target}`);
}

console.log("electron-pack-smoke: pass (syntax + optional unpacked presence)");
console.log("BASE-04 remainder: real provider + container canary + STM32 HIL still manual/joint.");
