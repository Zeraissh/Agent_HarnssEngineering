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

# .env.cloud 里的非敏感默认项已经提交在仓库里，云端会自动拿到。
# 逐项比对后只报"还差哪几个"，免得把已覆盖的也当成待办重填一遍。
$cloudDefaults = @{}
$cloudPath = Join-Path $repoRoot ".env.cloud"
if (Test-Path -LiteralPath $cloudPath) {
  foreach ($line in Get-Content -LiteralPath $cloudPath -Encoding UTF8) {
    $trim = $line.Trim()
    if ($trim -eq "" -or $trim.StartsWith("#")) { continue }
    $eq = $trim.IndexOf("=")
    if ($eq -le 0) { continue }
    $cloudDefaults[$trim.Substring(0, $eq).Trim()] = $trim.Substring($eq + 1).Trim()
  }
}

Write-Host ""
Write-Host "=== 本机 .env → Cloud Secrets 对照（共 $($entries.Count) 项）===" -ForegroundColor Cyan
Write-Host "读取：$EnvPath"
Write-Host "仓库默认：$cloudPath（$($cloudDefaults.Count) 项，已提交，云端自动生效）"
Write-Host "环境设置：$EnvironmentUrl"
Write-Host ""

$todo = @()
foreach ($e in $entries) {
  $sensitive = $e.Key -match 'KEY|TOKEN|SECRET|PASSWORD'
  $masked = if ($sensitive) { "***" } else { $e.Value }
  if ($sensitive) {
    # 敏感值永远不进 .env.cloud，只能走 Secrets
    $state = "必须填 Secret"
    $color = "Yellow"
    $todo += $e.Key
  } elseif (-not $cloudDefaults.ContainsKey($e.Key)) {
    $state = "需填 Secret（.env.cloud 未收录）"
    $color = "Yellow"
    $todo += $e.Key
  } elseif ($cloudDefaults[$e.Key] -ne $e.Value) {
    $state = "需填 Secret（与仓库默认不同：$($cloudDefaults[$e.Key])）"
    $color = "Yellow"
    $todo += $e.Key
  } else {
    $state = "已在 .env.cloud，无需填"
    $color = "DarkGray"
  }
  Write-Host ("  {0,-28} = {1,-42} {2}" -f $e.Key, $masked, $state) -ForegroundColor $color
}

Write-Host ""
if ($todo.Count -eq 0) {
  Write-Host "无需填任何 Secret：本机 .env 的每一项都已由 .env.cloud 覆盖。" -ForegroundColor Green
} else {
  Write-Host "需要在 Secrets 里添加【同名】变量，共 $($todo.Count) 项：" -ForegroundColor Cyan
  Write-Host ("  " + ($todo -join ", "))
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
