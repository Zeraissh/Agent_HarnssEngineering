# 拆除切池的底层长跑道:按网/连通性成串,长度 ≥ minlen 且不在保留名单 → 删段(+孤 via),记录待恢复端点对
# 用法: python rip_runs.py <pcb> [minlen=15] [keep=NET,NET]
# 注意:孤 via 清理只针对被拆的网(它们的 via 若不再有 B 段端点即删)。**勿把 GND 放进被拆网**——
#      GND 缝合 via 天生无 B 段,会被误删(案例 #11 踩过)。
import json
import math
import sys
from collections import defaultdict

import pcbnew

from kit_common import restore_path

PCB = sys.argv[1]
MINLEN = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
KEEP = set(sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] else set()
KEEP.add("GND")
board = pcbnew.LoadBoard(PCB)


def key(p):
    return (round(p[0], 3), round(p[1], 3))


bsegs = defaultdict(list)
for t in board.GetTracks():
    if t.GetClass() == "PCB_TRACK" and t.GetLayer() == pcbnew.B_Cu:
        s, e = t.GetStart(), t.GetEnd()
        bsegs[t.GetNetname()].append((t, (s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6)))
to_remove, restore = [], []
for net, lst in bsegs.items():
    if net in KEEP:
        continue
    parent = list(range(len(lst)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    idx = defaultdict(list)
    for i, (_, a, b) in enumerate(lst):
        idx[key(a)].append(i); idx[key(b)].append(i)
    for members in idx.values():
        for m in members[1:]:
            ra, rb = find(members[0]), find(m)
            if ra != rb:
                parent[rb] = ra
    groups = defaultdict(list)
    for i in range(len(lst)):
        groups[find(i)].append(i)
    for g in groups.values():
        L = sum(math.hypot(lst[i][2][0] - lst[i][1][0], lst[i][2][1] - lst[i][1][1]) for i in g)
        if L < MINLEN:
            continue
        deg = defaultdict(int)
        for i in g:
            deg[key(lst[i][1])] += 1; deg[key(lst[i][2])] += 1
        ends = [k for k, d in deg.items() if d == 1] or list(deg.keys())[:2]
        to_remove += [lst[i][0] for i in g]
        restore.append({"net": net, "len": round(L, 1), "ends": [list(e) for e in ends]})
        print("rip %-9s %5.1fmm ends=%s" % (net, L, ends))
for t in to_remove:
    board.Remove(t)
remaining = defaultdict(set)
for t in board.GetTracks():
    if t.GetClass() == "PCB_TRACK" and t.GetLayer() == pcbnew.B_Cu:
        s, e = t.GetStart(), t.GetEnd()
        remaining[t.GetNetname()].add(key((s.x / 1e6, s.y / 1e6)))
        remaining[t.GetNetname()].add(key((e.x / 1e6, e.y / 1e6)))
ripped = {r["net"] for r in restore}
vr = 0
for t in list(board.GetTracks()):
    if t.GetClass() == "PCB_VIA" and t.GetNetname() in ripped:
        p = t.GetPosition()
        if key((p.x / 1e6, p.y / 1e6)) not in remaining[t.GetNetname()]:
            board.Remove(t); vr += 1
pcbnew.SaveBoard(PCB, board)
json.dump(restore, open(restore_path(PCB), "w"))
print("removed segs:", len(to_remove), "vias:", vr, "| connections to restore:", len(restore))
