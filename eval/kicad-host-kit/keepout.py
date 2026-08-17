# 规则区(禁走线)——给自动布线器"划红线"的手段:晶振本体下方 B.Cu 禁线 + F.Cu 围栏挡他网穿越
# 用法: python keepout.py <pcb> NAME:LAYER:x0,y0,x1,y1 [NAME:LAYER:...]   LAYER=F|B ; --clear 先删全部同名规则区
# 例(案例 #11): xtal_no_bcu_tracks:B:6.5,14.8,15.8,22.6 xtal_fence_bottom:F:6.5,22.7,15.6,23.4
# 注意:freerouting 把规则区导出为 wire_keepout,会照做;via 不禁(SetDoNotAllowVias False)——晶振 GND 缝合还要 via。
import sys

import pcbnew

from kit_common import MM

PCB = sys.argv[1]
specs = [a for a in sys.argv[2:] if not a.startswith("--")]
board = pcbnew.LoadBoard(PCB)
names = {s.split(":")[0] for s in specs}
if "--clear" in sys.argv:
    for z in list(board.Zones()):
        if z.GetIsRuleArea() and z.GetZoneName() in names:
            board.Remove(z)
for s in specs:
    name, layer, box = s.split(":")
    x0, y0, x1, y1 = [float(v) for v in box.split(",")]
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    z.SetLayer(pcbnew.B_Cu if layer.upper().startswith("B") else pcbnew.F_Cu)
    z.SetDoNotAllowTracks(True)
    z.SetDoNotAllowVias(False)
    if hasattr(z, "SetDoNotAllowZoneFills"):
        z.SetDoNotAllowZoneFills(False)
    z.SetDoNotAllowPads(False)
    z.SetDoNotAllowFootprints(False)
    o = z.Outline()
    o.NewOutline()
    for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
        o.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
    z.SetZoneName(name)
    board.Add(z)
pcbnew.SaveBoard(PCB, board)
print("rule areas:", [s.split(":")[0] for s in specs])
