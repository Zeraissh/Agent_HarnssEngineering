# B.Cu 整层 GND 铺铜(单一大池,不缝合——缝合是布线之后的事;先池后线是"底层=参考面"的量产口径)
# 用法: python pour_gnd.py <pcb> [--rect x0,y0,x1,y1] [--net GND] [--layer B] [--clearance 0.3] [--minw 0.25]
# 不给 --rect 时按板框包围盒内缩 0.5mm。幂等:同名(net+layer)的旧池先删。
import sys

import pcbnew

from kit_common import MM

PCB = sys.argv[1]
NET, LAYER, CLR, MINW, RECT = "GND", "B", 0.3, 0.25, None
for i, a in enumerate(sys.argv):
    if a == "--rect":
        RECT = [float(v) for v in sys.argv[i + 1].split(",")]
    if a == "--net":
        NET = sys.argv[i + 1]
    if a == "--layer":
        LAYER = sys.argv[i + 1]
    if a == "--clearance":
        CLR = float(sys.argv[i + 1])
    if a == "--minw":
        MINW = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)
layer = pcbnew.B_Cu if LAYER.upper().startswith("B") else pcbnew.F_Cu
net = board.FindNet(NET)
assert net is not None, "net not found: " + NET
if RECT is None:
    eb = board.GetBoardEdgesBoundingBox()
    RECT = [eb.GetLeft() / 1e6 + 0.5, eb.GetTop() / 1e6 + 0.5, eb.GetRight() / 1e6 - 0.5, eb.GetBottom() / 1e6 - 0.5]
for z in list(board.Zones()):
    if not z.GetIsRuleArea() and z.GetLayer() == layer and z.GetNetname() == NET:
        board.Remove(z)
zone = pcbnew.ZONE(board)
zone.SetLayer(layer)
zone.SetNet(net)
o = zone.Outline()
o.NewOutline()
x0, y0, x1, y1 = RECT
for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
    o.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
zone.SetLocalClearance(MM(CLR))
zone.SetMinThickness(MM(MINW))
zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
zone.SetZoneName("%s_%s_plane" % (NET, LAYER.upper()))
board.Add(zone)
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(PCB, board)
print("pour added:", NET, LAYER, RECT)
