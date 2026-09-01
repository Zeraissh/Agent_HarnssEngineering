# 从本机 .env 生成 Cloud Agent Secrets 对照表，并打开环境设置页。
# 在 Windows 项目根目录运行：
#   powershell -ExecutionPolicy Bypass -File scripts/sync-local-env-to-cloud.ps1
#
# 默认读取仓库根目录的 .env；或指定路径：
#   powershell ... -EnvPath "D:\path\to\.env"
#
# 环境 ID 不写死：Secrets 只对【Agent 实际启动的那个环境】生效，而环境会被
# 重建（每次 Setup 流程都会新建一个），写死的 ID 迟早指向没人用的旧环境。
# 从 Agent 面板右侧 Environment 卡片抄当前 ID：
#   powershell ... -EnvironmentId "91c7808d-a5ac-11f1-a7d1-d6b4613131ce"

param(
  [string]$EnvPath = "",
  [string]$EnvironmentId = ""
)

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $EnvPath) {
  $EnvPath = Join-Path $repoRoot ".env"
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  Write-Error "找不到 .env：$EnvPath"
  Write-Host "用法：powershell -File scripts/sync-local-env-to-cloud.ps1 -EnvPath '你的\.env路径'"
  exit 1
}

if ($EnvironmentId) {
  $EnvironmentUrl = "https://cursor.com/dashboard/cloud-agents/environments/e/$EnvironmentId"
} else {
  $EnvironmentUrl = "https://cursor.com/dashboard/cloud-agents/environments"
}

$lines = Get-Content -LiteralPath $EnvPath -Encoding UTF8
$entries = @()
foreach ($line in $lines) {
  $trim = $line.Trim()
  if ($trim -eq "" -or $trim.StartsWith("#")) { continue }
  $eq = $trim.IndexOf("=")
  if ($eq -le 0) { continue }
  $key = $trim.Substring(0, $eq).Trim()
  $val = $trim.Substring($eq + 1).Trim()
  if ($val.StartsWith('"') -and $val.EndsWith('"')) { $val = $val.Substring(1, $val.Length - 2) }
  if ($val.StartsWith("'") -and $val.EndsWith("'")) { $val = $val.Substring(1, $val.Length - 2) }
  if ($key -match '^[A-Z][A-Z0-9_]*$' -and $val) {
    $entries += [pscustomobject]@{ Key = $key; Value = $val }
  }
}

Write-Host ""
Write-Host "=== 本机 .env → Cloud Secrets 对照（共 $($entries.Count) 项）===" -ForegroundColor Cyan
Write-Host "读取：$EnvPath"
Write-Host "环境设置：$EnvironmentUrl"
Write-Host ""
Write-Host "在 Secrets 里添加【同名】变量（名称必须与下面 Key 完全一致）："
Write-Host ""

foreach ($e in $entries) {
  $masked = if ($e.Key -match 'KEY|TOKEN|SECRET|PASSWORD') { "***" } else { $e.Value }
  Write-Host ("  {0,-28} = {1}" -f $e.Key, $masked)
}

Write-Host ""
if (-not $EnvironmentId) {
  Write-Host "注意：没有指定 -EnvironmentId，打开的是环境【列表】页。" -ForegroundColor Yellow
  Write-Host "请对照 Agent 面板右侧 Environment 卡片里的环境 ID 选中同一个环境——" -ForegroundColor Yellow
  Write-Host "Secrets 配到别的环境上不会注入，云端只会看到 credential_present: no。" -ForegroundColor Yellow
  Write-Host ""
}

Write-Host "打开浏览器到环境设置页…"
Start-Process $EnvironmentUrl

Write-Host ""
Write-Host "填好后【重开一个 Cloud Agent】——Secrets 只在新 Agent 启动时注入，" -ForegroundColor Green
Write-Host "已经在跑的 Agent 不会拿到。" -ForegroundColor Green
Write-Host "新 Agent 启动时 scripts/cloud-sync-env.sh 会把它们写进工作区 .env，" -ForegroundColor Green
Write-Host "并在 start 日志里打印命中的变量名；npm run doctor 应显示 credential_present: yes。" -ForegroundColor Green
Write-Host ""
