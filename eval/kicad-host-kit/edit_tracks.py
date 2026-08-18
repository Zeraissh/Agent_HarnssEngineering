# 精确增删走线/via(按坐标),重填铺铜后存盘。给宿主做"外科手术"用——比 rip_net 全拆再重布更可控。
# 用法: python edit_tracks.py <pcb> <ops.json>
# ops.json: {"remove":[{"layer":"F|B|V","net":"NRST","a":[x,y],"b":[x,y]}, ...],   # 段按两端点(容差 0.02)匹配;via 只给 a
#            "add":[{"layer":"F|B","net":"NRST","a":[x,y],"b":[x,y],"width":0.25}, {"layer":"V","net":"NRST","a":[x,y]}]}
# 每条 remove 若匹配不到即报错退出(不做半截手术)。
import json
import math
import sys

import pcbnew

from kit_common import MM

PCB, OPS = sys.argv[1], sys.argv[2]
ops = json.load(open(OPS, encoding="utf-8"))
board = pcbnew.LoadBoard(PCB)
TOL = 0.02


def near(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL


victims = []
for r in ops.get("remove", []):
    found = None
    for t in board.GetTracks():
        if t.GetNetname() != r["net"]:
            continue
        if r["layer"] == "V":
            if t.GetClass() == "PCB_VIA":
                p = t.GetPosition()
                if near((p.x / 1e6, p.y / 1e6), r["a"]):
                    found = t; break
        else:
            if t.GetClass() == "PCB_TRACK" and t.GetLayer() == (pcbnew.B_Cu if r["layer"] == "B" else pcbnew.F_Cu):
                s, e = t.GetStart(), t.GetEnd()
                s, e = (s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6)
                if (near(s, r["a"]) and near(e, r["b"])) or (near(s, r["b"]) and near(e, r["a"])):
                    found = t; break
    if found is None:
        print("NOT FOUND:", r); sys.exit(2)
    victims.append(found)
for t in victims:
    board.Remove(t)
n_add = 0
for a in ops.get("add", []):
    net = board.FindNet(a["net"])
    assert net is not None, a["net"]
    if a["layer"] == "V":
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(MM(a["a"][0]), MM(a["a"][1])))
        v.SetWidth(MM(a.get("dia", 0.6))); v.SetDrill(MM(a.get("drill", 0.3)))
        v.SetViaType(pcbnew.VIATYPE_THROUGH); v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetNet(net); board.Add(v)
    else:
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pcbnew.VECTOR2I(MM(a["a"][0]), MM(a["a"][1])))
        t.SetEnd(pcbnew.VECTOR2I(MM(a["b"][0]), MM(a["b"][1])))
        t.SetWidth(MM(a.get("width", 0.25)))
        t.SetLayer(pcbnew.B_Cu if a["layer"] == "B" else pcbnew.F_Cu)
        t.SetNet(net); board.Add(t)
    n_add += 1
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(PCB, board)
print("removed:", len(victims), "added:", n_add)
