# 从本机 .env 生成 Cloud Agent Secrets 对照表，并打开环境设置页。
# 在 Windows 项目根目录运行：
#   powershell -ExecutionPolicy Bypass -File scripts/sync-local-env-to-cloud.ps1
#
# 默认读取：D:\Work\Github_pros\Agent_Design\.env
# 或指定路径：powershell ... -EnvPath "D:\path\to\.env"

param(
  [string]$EnvPath = "D:\Work\Github_pros\Agent_Design\.env",
  [string]$EnvironmentUrl = "https://cursor.com/dashboard/cloud-agents/environments/e/d8cb50c8-a5a9-11f1-a7d1-d6b4613131ce"
)

if (-not (Test-Path -LiteralPath $EnvPath)) {
  Write-Error "找不到 .env：$EnvPath"
  Write-Host "用法：powershell -File scripts/sync-local-env-to-cloud.ps1 -EnvPath '你的\.env路径'"
  exit 1
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
Write-Host "环境设置：$EnvironmentUrl"
Write-Host ""
Write-Host "在 Secrets 里添加【同名】变量（名称必须与下面 Key 完全一致）："
Write-Host ""

foreach ($e in $entries) {
  $masked = if ($e.Key -match 'KEY|TOKEN|SECRET|PASSWORD') { "***" } else { $e.Value }
  Write-Host ("  {0,-28} = {1}" -f $e.Key, $masked)
}

Write-Host ""
Write-Host "打开浏览器到环境设置页…"
Start-Process $EnvironmentUrl

Write-Host ""
Write-Host "填好后，在 Cloud Agent 对话里回复「已配置」。" -ForegroundColor Green
Write-Host "新 Agent 会通过 scripts/cloud-sync-env.sh 自动写入工作区 .env。"
Write-Host ""
