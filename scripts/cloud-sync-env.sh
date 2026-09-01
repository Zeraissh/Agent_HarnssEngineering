#!/usr/bin/env bash
# 把 Cloud Agent 注入的环境变量（Secrets 同名）写成工作区 .env。
# 本地开发用 .env；云端用 Dashboard Secrets → 进程环境变量 → 本脚本落盘。
# 不打印密钥；缺省键跳过。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/.env.example"
OUT="$ROOT/.env"

if [[ ! -f "$EXAMPLE" ]]; then
  exit 0
fi

tmp="$(mktemp)"
chmod 600 "$tmp"

# 1) 非敏感默认（.env.cloud，可提交）
if [[ -f "$ROOT/.env.cloud" ]]; then
  grep -E '^[A-Z][A-Z0-9_]*=' "$ROOT/.env.cloud" >>"$tmp" || true
fi

# 2) Secrets 同名环境变量覆盖默认
while IFS= read -r line; do
  # 只处理 KEY= 行（忽略注释与空行）
  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
    continue
  fi
  key="${BASH_REMATCH[1]}"
  val="${!key:-}"
  if [[ -n "$val" ]]; then
    printf '%s=%s\n' "$key" "$val" >>"$tmp"
  fi
done <"$EXAMPLE"

if [[ -s "$tmp" ]]; then
  mv "$tmp" "$OUT"
  chmod 600 "$OUT"
else
  rm -f "$tmp"
  # 无 Secret 时不删已有 .env（避免误清空手工文件）
fi
