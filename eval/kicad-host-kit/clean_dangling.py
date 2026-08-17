# 按 DRC 报告的 track_dangling / via_dangling 条目精确删除,重填铺铜(逐轮调用可剥掉整条死枝)
# 用法: python clean_dangling.py <pcb> <drc.rpt>
import math
import re
import sys

import pcbnew

from kit_common import drc_items, refill_and_save

PCB, RPT = sys.argv[1], sys.argv[2]
board = pcbnew.LoadBoard(PCB)
tr, vi = [], []
for kind, items in drc_items(RPT):
    if kind == "track_dangling":
        for x, y, desc in items:
            m = re.search(r"Track \[([^\]]+)\] on (\w\.Cu), length ([\d.]+) mm", desc)
            if m:
                tr.append((x, y, m.group(1), m.group(2), float(m.group(3)))); break
    elif kind == "via_dangling":
        for x, y, desc in items:
            m = re.search(r"Via \[([^\]]+)\]", desc)
            if m:
                vi.append((x, y, m.group(1))); break
removed = 0
for t in list(board.GetTracks()):
    if t.GetClass() == "PCB_VIA":
        p = t.GetPosition()
        for x, y, net in vi:
            if t.GetNetname() == net and math.hypot(p.x / 1e6 - x, p.y / 1e6 - y) < 0.05:
                board.Remove(t); removed += 1; break
        continue
    s, e = t.GetStart(), t.GetEnd()
    L = math.hypot(e.x - s.x, e.y - s.y) / 1e6
    lay = board.GetLayerName(t.GetLayer())
    for x, y, net, tl, tL in tr:
        if t.GetNetname() != net or lay != tl or abs(L - tL) > 0.02:
            continue
        if math.hypot(s.x / 1e6 - x, s.y / 1e6 - y) < 0.05 or math.hypot(e.x / 1e6 - x, e.y / 1e6 - y) < 0.05:
            board.Remove(t); removed += 1; break
refill_and_save(board, PCB)
print("removed dangling items:", removed)
