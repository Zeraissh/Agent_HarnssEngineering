# DRC 驱动的返工循环:拆冲突 → 逐轮清悬空 → 未连接对→恢复清单 → 返工路由 → 落板 → 切角 → DRC;最多 N 轮
# 用法: powershell -File rework_loop.ps1 -Pcb <board.kicad_pcb> [-MaxRounds 4] [-BCost 4.0] [-Deep]
param(
  [Parameter(Mandatory=$true)][string]$Pcb,
  [int]$MaxRounds = 4,
  [double]$BCost = 4.0,
  [switch]$Deep,
  [string]$Python = 'D:\KiCad\bin\python.exe',
  [string]$KicadBin = 'D:\KiCad\bin'
)
$kit = $PSScriptRoot
$env:Path = "$KicadBin;" + $env:Path
$work = if ($env:KIT_WORK) { $env:KIT_WORK } else { Join-Path (Split-Path $Pcb -Parent) '_kit' }
New-Item -ItemType Directory -Force $work | Out-Null
# 有同名 .kicad_sch 才校验原理图一致性(否则 kicad-cli 每次打印"无法获取原理图网表"噪音)
$parity = if (Test-Path ([System.IO.Path]::ChangeExtension($Pcb, '.kicad_sch'))) { '--schematic-parity' } else { $null }
function Drc($tag) {
  $rpt = Join-Path $work "drc-$tag.rpt"
  if ($parity) { kicad-cli pcb drc $parity --exit-code-violations -o $rpt $Pcb | Out-Null } else { kicad-cli pcb drc --exit-code-violations -o $rpt $Pcb | Out-Null }
  $cats = @{}
  foreach ($l in (Get-Content $rpt)) { if ($l -match '^\[([a-z_0-9]+)\]') { $cats[$Matches[1]] = 1 + [int]$cats[$Matches[1]] } }
  $summary = ($cats.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value }) -join ' '
  Write-Host ("[{0}] {1}" -f $tag, $summary)
  return @{ cats = $cats; rpt = $rpt }
}
$deepArg = if ($Deep) { '--deep' } else { '' }
for ($round = 1; $round -le $MaxRounds; $round++) {
  Write-Host "=== round $round ==="
  $r = Drc "r$round-a"
  $conf = [int]$r.cats['shorting_items'] + [int]$r.cats['clearance'] + [int]$r.cats['hole_clearance'] + [int]$r.cats['solder_mask_bridge']
  if ($conf -gt 0) { & $Python "$kit\rip_conflicts.py" $Pcb $r.rpt 2>$null | Select-String 'removed' }
  for ($k = 1; $k -le 12; $k++) {
    $r = Drc "r$round-d$k"
    $nd = [int]$r.cats['track_dangling'] + [int]$r.cats['via_dangling']
    if ($nd -eq 0) { break }
    & $Python "$kit\clean_dangling.py" $Pcb $r.rpt 2>$null | Out-Null
  }
  $r = Drc "r$round-u"
  if ([int]$r.cats['unconnected_items'] -eq 0) { Write-Host 'no unconnected'; break }
  & $Python "$kit\restore_from_drc.py" $Pcb $r.rpt 2>$null | Select-String 'entries'
  & $Python "$kit\route_repair.py" $Pcb $BCost $deepArg 2>$null | Select-String -Pattern 'restored|failed'
  & $Python "$kit\apply_actions.py" $Pcb 2>$null | Select-String 'applied'
  & $Python "$kit\mitre.py" $Pcb 2>&1 | Select-String -Pattern 'applied'
}
$r = Drc 'final'
