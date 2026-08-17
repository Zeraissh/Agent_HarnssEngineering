# 按 DRC 报告拆除冲突走线/via(shorting_items/clearance/hole_clearance/solder_mask_bridge 条目中的 Track/Via)
# 用法: python rip_conflicts.py <pcb> <drc.rpt>
import math
import re
import sys

import pcbnew

from kit_common import drc_items

PCB, RPT = sys.argv[1], sys.argv[2]
board = pcbnew.LoadBoard(PCB)
tr, vi = [], []
for kind, items in drc_items(RPT):
    if kind not in ("shorting_items", "clearance", "hole_clearance", "solder_mask_bridge"):
        continue
    for x, y, desc in items:
        m = re.search(r"Track \[([^\]]+)\] on (\w\.Cu), length ([\d.]+) mm", desc)
        if m:
            tr.append((x, y, m.group(1), m.group(2), float(m.group(3))))
        m = re.search(r"Via \[([^\]]+)\]", desc)
        if m:
            vi.append((x, y, m.group(1)))
victims = []
for t in board.GetTracks():
    if t.GetClass() == "PCB_VIA":
        p = t.GetPosition()
        if any(t.GetNetname() == n and math.hypot(p.x / 1e6 - x, p.y / 1e6 - y) < 0.05 for x, y, n in vi):
            victims.append(t)
        continue
    s, e = t.GetStart(), t.GetEnd()
    L = math.hypot(e.x - s.x, e.y - s.y) / 1e6
    lay = board.GetLayerName(t.GetLayer())
    for x, y, net, tl, tL in tr:
        if t.GetNetname() == net and lay == tl and abs(L - tL) < 0.02 and (
                math.hypot(s.x / 1e6 - x, s.y / 1e6 - y) < 0.05 or math.hypot(e.x / 1e6 - x, e.y / 1e6 - y) < 0.05):
            victims.append(t); break
for t in victims:
    board.Remove(t)
pcbnew.SaveBoard(PCB, board)
print("conflict items removed:", len(victims))
