# 删走线中段的"灰尘段"(长度 < maxlen 的度数-2 微段):删掉它,并把一侧邻段的端点挪到另一端,使链保持连通。
# 只处理两端各恰有一条同网同层邻段、且不在焊盘/via 上的微段(那些由 trim_pad_stubs 管)。
# 用法: python trim_dust.py <pcb> [--max 0.05] [--dry]
import math
import sys
from collections import defaultdict

import pcbnew

PCB = sys.argv[1]
DRY = "--dry" in sys.argv
MAXLEN = 0.05
for i, a in enumerate(sys.argv):
    if a == "--max":
        MAXLEN = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)


def key(p):
    return (round(p.x / 1e6, 3), round(p.y / 1e6, 3))


tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
at = defaultdict(list)  # (net, layer, point) -> [tracks]
for t in tracks:
    at[(t.GetNetname(), t.GetLayer(), key(t.GetStart()))].append(t)
    at[(t.GetNetname(), t.GetLayer(), key(t.GetEnd()))].append(t)
pads = [pad for fp in board.GetFootprints() for pad in fp.Pads()]
vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]


def on_pad_or_via(p, net):
    for pad in pads:
        if pad.GetNetname() == net and pad.HitTest(p):
            return True
    for v in vias:
        if v.GetNetname() == net and math.hypot(p.x - v.GetPosition().x, p.y - v.GetPosition().y) <= v.GetWidth(pcbnew.F_Cu) / 2:
            return True
    return False


done, plans = set(), []
for t in tracks:
    if t.GetLength() / 1e6 >= MAXLEN or t.GetLength() == 0:
        continue
    net, lay = t.GetNetname(), t.GetLayer()
    s, e = t.GetStart(), t.GetEnd()
    ns = [u for u in at[(net, lay, key(s))] if u is not t]
    ne = [u for u in at[(net, lay, key(e))] if u is not t]
    if len(ns) != 1 or len(ne) != 1 or on_pad_or_via(s, net) or on_pad_or_via(e, net):
        continue
    if id(ns[0]) in done or id(ne[0]) in done:
        continue
    plans.append((t, ns[0], s, e))
    done.add(id(t)); done.add(id(ns[0]))
for t, nb, s, e in plans:
    print("dust %-9s (%.3f,%.3f)-(%.3f,%.3f) len=%.3f -> neighbor end moved to (%.3f,%.3f)" % (
        t.GetNetname(), s.x / 1e6, s.y / 1e6, e.x / 1e6, e.y / 1e6, t.GetLength() / 1e6, e.x / 1e6, e.y / 1e6))
if not DRY:
    for t, nb, s, e in plans:
        if key(nb.GetStart()) == key(s):
            nb.SetStart(e)
        else:
            nb.SetEnd(e)
        board.Remove(t)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(PCB, board)
print("dust segments %s: %d" % ("found" if DRY else "removed", len(plans)))
