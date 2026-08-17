# 底层走线"跑道"分析:按网把 B.Cu 段按端点连通性成串,报长度/包围盒(找切池元凶)。用法: python bruns.py <pcb>
import math
import sys
from collections import defaultdict

import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
segs = defaultdict(list)
for t in board.GetTracks():
    if t.GetClass() == "PCB_TRACK" and t.GetLayer() == pcbnew.B_Cu:
        s, e = t.GetStart(), t.GetEnd()
        segs[t.GetNetname()].append(((s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6)))


def key(p):
    return (round(p[0], 3), round(p[1], 3))


runs = []
for net, lst in segs.items():
    parent = list(range(len(lst)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    idx = defaultdict(list)
    for i, (a, b) in enumerate(lst):
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
        L = sum(math.hypot(lst[i][1][0] - lst[i][0][0], lst[i][1][1] - lst[i][0][1]) for i in g)
        pts = [lst[i][0] for i in g] + [lst[i][1] for i in g]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        runs.append((L, net, len(g), (min(xs), min(ys), max(xs), max(ys))))
runs.sort(reverse=True)
print("B runs:", len(runs), "total B length %.1fmm" % sum(r[0] for r in runs))
for L, net, n, bb in runs[:15]:
    print("  %6.1fmm  %-9s segs=%2d  bbox=(%.1f,%.1f)-(%.1f,%.1f)" % (L, net, n, *bb))
