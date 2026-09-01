#!/usr/bin/env bash
# 把 Cloud Agent 注入的环境变量（Secrets 同名）写成工作区 .env。
# 本地开发用 .env；云端用 Dashboard Secrets → 进程环境变量 → 本脚本落盘。
#
# 只打印变量【名】和命中计数，绝不打印值。
# 一个 Secret 都没拿到时必须吵出来：静默成功过一次，代价是把"Secrets 填在了
# 另一个环境上"误判成"脚本没跑"——两种故障的现场看起来一模一样。
set -euo pipefail

if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  printf '[cloud-sync-env] 需要 bash 4+（当前 %s），跳过。云端镜像满足此要求；\n' "${BASH_VERSION:-未知}"
  printf '[cloud-sync-env] 本地 macOS 自带 bash 3.2，请直接手工维护 .env。\n'
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.env"
DEFAULTS="$ROOT/.env.cloud"
SCHEMAS=("$ROOT/.env.example" "$ROOT/.env.production.example" "$DEFAULTS")
CREDENTIAL_KEYS=(ANTHROPIC_API_KEY OPENAI_API_KEY)

log() { printf '[cloud-sync-env] %s\n' "$*"; }

join_names() {
  if [[ "$#" -eq 0 ]]; then
    printf '无'
  else
    printf '%s' "$1"
    shift
    printf ', %s' "$@"
  fi
}

# 本项目已声明的变量名。示例文件里【注释态】的声明同样算数：.env.example
# 除两个 API key 外全是注释行，只认未注释行会把 ANTHROPIC_BASE_URL / AGENT_MODEL
# 这类同名 Secret 静默丢掉。
declared_keys() {
  local file
  for file in "${SCHEMAS[@]}"; do
    [[ -f "$file" ]] || continue
    # 一律过 awk：文件末尾缺换行时 sed 会原样保留，下一个来源就被粘成同一行
    sed -n 's/^[[:space:]]*#*[[:space:]]*\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$file" | awk 'NF'
  done
  # 逃生口：示例文件没收录的变量名，逗号分隔
  if [[ -n "${AGENT_CLOUD_ENV_EXTRA_KEYS:-}" ]]; then
    tr ',' '\n' <<<"$AGENT_CLOUD_ENV_EXTRA_KEYS" | awk '{ gsub(/[[:space:]]/, ""); if ($0 != "") print }'
  fi
}

# 值一律带引号落盘，并挑一个值里没出现过的引号字符：Node 的 --env-file 解析器
# 不认引号内转义，裸值又会被 # 和行尾空白改写语义。
quote_value() {
  local value="$1"
  local quote
  for quote in "'" '"' '`'; do
    if [[ "$value" != *"$quote"* ]]; then
      printf '%s%s%s' "$quote" "$value" "$quote"
      return 0
    fi
  done
  return 1
}

mapfile -t KEYS < <(declared_keys | awk 'NF && !seen[$0]++')

declare -A VALUES=()
declare -A ORIGIN=()

# 1) 非敏感默认（.env.cloud，可提交）
if [[ -f "$DEFAULTS" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    VALUES["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
    ORIGIN["${BASH_REMATCH[1]}"]="default"
  done <"$DEFAULTS"
fi

# 2) 同名环境变量（Secrets）覆盖默认。逐键落 map 而非追加两遍，
#    "后写覆盖前写"是 dotenv 实现细节，不该拿它当契约。
for key in "${KEYS[@]}"; do
  value="${!key:-}"
  [[ -n "$value" ]] || continue
  VALUES["$key"]="$value"
  ORIGIN["$key"]="secret"
done

tmp="$(mktemp)"
chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT

default_names=()
secret_names=()
unquotable_names=()

# 空关联数组下 printf '%s\n' "${!VALUES[@]}" 会吐出一个空行，
# 空键名再进数组下标就是 bad array subscript
if [[ "${#VALUES[@]}" -gt 0 ]]; then
  while IFS= read -r key; do
    if quoted="$(quote_value "${VALUES[$key]}")"; then
      printf '%s=%s\n' "$key" "$quoted" >>"$tmp"
      if [[ "${ORIGIN[$key]}" == "secret" ]]; then
        secret_names+=("$key")
      else
        default_names+=("$key")
      fi
    else
      # 单引号、双引号、反引号同时出现——无法安全落盘，宁可缺席也不写坏 .env
      unquotable_names+=("$key")
    fi
  done < <(printf '%s\n' "${!VALUES[@]}" | sort)
fi

log "已声明变量 ${#KEYS[@]} 个；.env.cloud 默认 ${#default_names[@]} 项：$(join_names "${default_names[@]}")"
log "Secrets 命中 ${#secret_names[@]} 项：$(join_names "${secret_names[@]}")"
if [[ "${#unquotable_names[@]}" -gt 0 ]]; then
  log "跳过 ${#unquotable_names[@]} 项（值里同时含 ' \" \` 三种引号，无法安全落盘）：$(join_names "${unquotable_names[@]}")"
fi

preserved=0
if [[ "${#secret_names[@]}" -eq 0 && -f "$OUT" ]]; then
  # 没有任何 Secret 时不覆盖已有 .env：那可能是手工写的，只含默认项的重写等于清空凭据
  preserved=1
  log "未命中 Secret，保留现有 $OUT 不动（凭据以该文件为准）"
elif [[ ! -s "$tmp" ]]; then
  log "没有任何变量可写，未生成 $OUT"
else
  mv "$tmp" "$OUT"
  chmod 600 "$OUT"
  trap - EXIT
  log "已写入 $OUT（0600）"
fi

have_credential=0
for key in "${CREDENTIAL_KEYS[@]}"; do
  if [[ -n "${VALUES[$key]:-}" ]]; then
    have_credential=1
  fi
  # 保留了别人写的 .env 时，凭据在那份文件里而不在本次的 map 里，
  # 照着 map 报警就是误报
  if [[ "$preserved" -eq 1 ]] && grep -qE "^[[:space:]]*${key}=[\"'\`]?[^\"'\`[:space:]]" "$OUT"; then
    have_credential=1
  fi
done

if [[ "$have_credential" -eq 0 ]]; then
  log "警告：$(join_names "${CREDENTIAL_KEYS[@]}") 一个都没拿到，npm run doctor 会报 credential_present: no。"
  log "  1) Secrets 必须配在【本 Agent 实际启动的那个环境】上。Agent 面板右侧 Environment"
  log "     卡片里的环境 ID 才是生效的那个；配到旧环境上不会注入。"
  log "  2) Secrets 只在【新 Agent 启动时】注入，改完必须重开一个 Agent 才生效。"
  log "  3) 变量名要与本地 .env 完全同名（区分大小写）。"
fi
