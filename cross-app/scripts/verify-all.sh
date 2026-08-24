#!/usr/bin/env bash
# Agent Harness Console 一键全量自检脚本:
# 前端纯函数单测、Vite 构建、前端语法检查、
# Electron 主进程/预加载语法检查、Capacitor Android 同步、appId 一致性断言。
# 用法:在 cross-app 目录下执行  bash scripts/verify-all.sh
set -e

# 切换到脚本所在仓库根目录,保证相对路径稳定
cd "$(dirname "$0")/.."

echo '==> 1/7 npm test'
npm test

echo '==> 2/7 npm run build'
npm run build

echo '==> 3/7 node --check app.js'
node --check app.js

echo '==> 4/7 node --check electron/main.cjs && node --check electron/preload.cjs'
node --check electron/main.cjs
node --check electron/preload.cjs

echo '==> 5/7 npx cap sync android'
npx cap sync android

echo '==> 6/7 appId 一致性断言:electron-builder.yml 与 capacitor.config.ts 均须为 com.self.agentharness'
node -e 'const fs=require("node:fs");const yml=fs.readFileSync("electron-builder.yml","utf8");const ts=fs.readFileSync("capacitor.config.ts","utf8");const expected="com.self.agentharness";const ymlOk=yml.includes("appId: "+expected);const tsOk=ts.includes("appId: \u0027"+expected+"\u0027");if(!ymlOk||!tsOk){console.error("appId 一致性断言失败:electron-builder.yml 命中="+ymlOk+", capacitor.config.ts 命中="+tsOk);process.exit(1);}console.log("appId 一致性断言通过:两者均为 "+expected);'

echo '==> 7/7 verify-all 全部通过'
