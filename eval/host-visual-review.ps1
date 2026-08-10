# 宿主视觉复核工具包 —— PowerShell 5.1
#
# 背景（2026-08-10）：VLM 端点未就绪（DeepSeek 不认图、kimi 被代理挡），
# verifier 的眼睛暂由宿主（Claude）承担。此脚本一键产出宿主复核所需的
# 全部材料：双判官退出码 + 网表 + 原理图 PDF（宿主可直读）+ 板 3D 渲染 PNG
# + 顶底层 SVG。宿主跑完后逐张亲读，按 kicad 包核查方法第 6 条的证据等级
# 出结论（可数事实 → 缺陷；观感 → 建议）。
#
# 用法: .\eval\host-visual-review.ps1 <工作目录> <工程名(不带扩展名)>
param(
  [Parameter(Mandatory=$true)][string]$Workdir,
  [Parameter(Mandatory=$true)][string]$Name
)
$ErrorActionPreference = 'Stop'
$env:Path = 'D:\KiCad\bin;' + $env:Path
Set-Location $Workdir

$sch = "$Name.kicad_sch"
$pcb = "$Name.kicad_pcb"
New-Item -ItemType Directory -Force preview | Out-Null

Write-Host '== ERC =='
kicad-cli sch erc --exit-code-violations $sch -o "$env:TEMP\hvr-erc.rpt" | Out-Null
Write-Host "ERC exit: $LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\hvr-erc.rpt" | Select-Object -First 30 }

Write-Host '== DRC (+parity) =='
kicad-cli pcb drc --schematic-parity --exit-code-violations $pcb -o "$env:TEMP\hvr-drc.rpt" | Out-Null
Write-Host "DRC exit: $LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\hvr-drc.rpt" | Select-Object -First 40 }

Write-Host '== 导出宿主复核材料 =='
kicad-cli sch export netlist $sch --output "preview\$Name.net" | Out-Null
kicad-cli sch export pdf $sch --output "preview\schematic.pdf" | Out-Null
kicad-cli sch export svg -o preview\ $sch | Out-Null
kicad-cli pcb export svg -o preview\pcb-top.svg --layers "F.Cu,Edge.Cuts,F.Silkscreen" $pcb | Out-Null
kicad-cli pcb export svg -o preview\pcb-bottom.svg --layers "B.Cu,Edge.Cuts,B.Silkscreen" $pcb | Out-Null
kicad-cli pcb render -o preview\board-3d.png $pcb | Out-Null
kicad-cli pcb render -o preview\board-3d-back.png --side back $pcb | Out-Null

Get-ChildItem preview | Select-Object Name, Length
Write-Host ''
Write-Host '宿主待办：Read preview\schematic.pdf 与 board-3d*.png，按清单核——'
Write-Host '  ① 文本/标签与符号、导线、彼此是否重叠；② 元件是否越板框、连接器是否贴边；'
Write-Host '  ③ 丝印参考号是否可读；④ 板面积相对元件规模是否经济。'
