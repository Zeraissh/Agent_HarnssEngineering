# freerouting 2.3.0 headless 一盘:DSN → SES → 导入临时板 → DRC 计数 → 惯例审计
# 用法: .\run_freerouting.ps1 -Dsn x.dsn -BasePcb unrouted.kicad_pcb -OutPcb routed.kicad_pcb [-Java ...] [-Jar ...] [-Is prioritized|sequential|random] [-Us greedy|global] [-Passes 400]
# 前提:JRE ≥ 25(2.3.0 class 版本 69);目录下不能有同名 *.rules(会弹"导入已存规则?"确认框而阻塞);
#       user_data_path 里放 freerouting.json(见 freerouting.template.json:gui.enabled=false、neckdown 关、fanout 关、单线程)。
# 结论备忘:-is/-us 只影响优化阶段,主布线结果确定;DSN 注入 autoroute_settings 层代价在 headless 会 0 网可布——别用。
param(
  [Parameter(Mandatory=$true)][string]$Dsn,
  [Parameter(Mandatory=$true)][string]$BasePcb,
  [Parameter(Mandatory=$true)][string]$OutPcb,
  [string]$Java = 'D:\Work\tools\freerouting\jre\jdk-25.0.4+7-jre\bin\java.exe',
  [string]$Jar = 'D:\Work\tools\freerouting\freerouting-2.3.0.jar',
  [string]$UserData = 'D:\Work\tools\freerouting\userdata',
  [string]$Is = 'prioritized',
  [string]$Us = 'greedy',
  [int]$Passes = 400,
  [string]$Py = 'D:\KiCad\bin\python.exe'
)
$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot
$env:Path = 'D:\KiCad\bin;' + $env:Path
if (-not (Test-Path (Join-Path $UserData 'freerouting.json'))) {
  New-Item -ItemType Directory -Force $UserData | Out-Null
  Copy-Item (Join-Path $kit 'freerouting.template.json') (Join-Path $UserData 'freerouting.json')
}
$rules = [System.IO.Path]::ChangeExtension($Dsn, '.rules')
if (Test-Path $rules) { Write-Host "WARN: sibling rules file exists -> renaming to .rules.bak (would trigger a blocking dialog)"; Move-Item $rules ($rules + '.bak') -Force }
$ses = [System.IO.Path]::ChangeExtension($OutPcb, '.ses')
$t0 = Get-Date
$log = & $Java -jar $Jar --user_data_path="$UserData" -de "$Dsn" -do "$ses" -mp $Passes -mt 1 -is $Is -us $Us -l en 2>&1 | Out-String
$secs = [int]((Get-Date) - $t0).TotalSeconds
$m = [regex]::Match($log, 'Auto-routing stage completed:.*?\((\d+) unrouted and (\d+) violations\)')
$unr = if ($m.Success) { $m.Groups[1].Value } else { '?' }
$vio = if ($m.Success) { $m.Groups[2].Value } else { '?' }
Write-Host ("freerouting {0}s | unrouted={1} violations={2}" -f $secs, $unr, $vio)
if (-not (Test-Path $ses)) { Write-Host 'NO SES produced'; Write-Host $log; exit 2 }
& $Py (Join-Path $kit 'import_ses.py') $BasePcb $ses $OutPcb
$rpt = [System.IO.Path]::ChangeExtension($OutPcb, '.drc.rpt')
if (Test-Path ([System.IO.Path]::ChangeExtension($OutPcb, '.kicad_sch'))) { kicad-cli pcb drc --schematic-parity --exit-code-violations -o $rpt $OutPcb | Out-Null } else { kicad-cli pcb drc --exit-code-violations -o $rpt $OutPcb | Out-Null }
$cats = @{}
foreach ($l in (Get-Content $rpt)) { if ($l -match '^\[([a-z_0-9]+)\]') { $cats[$Matches[1]] = 1 + [int]$cats[$Matches[1]] } }
Write-Host ('DRC: ' + (($cats.GetEnumerator() | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value }) -join ', '))
& $Py (Join-Path $kit 'audit_routing.py') $OutPcb
