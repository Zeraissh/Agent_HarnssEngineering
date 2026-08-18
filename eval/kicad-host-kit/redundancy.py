# 同网冗余布线分析:按网建图(焊盘/走线/via 为节点,端点重合为边),报 ①完全重复段/共线重叠段 ②环路(冗余并行路径)③同网平行贴走
# 注意:环路判定按坐标合并端点,不区分层——同坐标异层且无 via 的巧合会误报一次(案例 #11 +3V3 (31.848,18.152))
# 用法: python redundancy.py <pcb> [--net NRST,...] [--par-gap 0.9] [--par-len 2.0] [--cross]
import math
import sys
from collections import defaultdict

import pcbnew

PCB = sys.argv[1]
ONLY = None
PAR_GAP, PAR_LEN = 0.9, 2.0
CROSS = "--cross" in sys.argv   # 也报跨层(F 压 B)的同网平行
for i, a in enumerate(sys.argv):
    if a == "--net":
        ONLY = set(sys.argv[i + 1].split(","))
    if a == "--par-gap":
        PAR_GAP = float(sys.argv[i + 1])
    if a == "--par-len":
        PAR_LEN = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)


def key(x, y):
    return (round(x, 3), round(y, 3))


nets = defaultdict(lambda: {"segs": [], "vias": [], "pads": []})
for t in board.GetTracks():
    n = t.GetNetname()
    if ONLY and n not in ONLY:
        continue
    if t.GetClass() == "PCB_VIA":
        p = t.GetPosition()
        nets[n]["vias"].append((p.x / 1e6, p.y / 1e6))
    else:
        s, e = t.GetStart(), t.GetEnd()
        nets[n]["segs"].append(((s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6), "B" if t.GetLayer() == pcbnew.B_Cu else "F"))
for fp in board.GetFootprints():
    for pad in fp.Pads():
        n = pad.GetNetname()
        if ONLY and n not in ONLY:
            continue
        if n in nets:
            p = pad.GetPosition()
            nets[n]["pads"].append((p.x / 1e6, p.y / 1e6, fp.GetReference() + "-" + str(pad.GetNumber())))


def seg_dist(a, b, c, d):
    """两线段最近距离(近似:端点到对方线段距离的最小值)"""
    def pt(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    return min(pt(*a, *c, *d), pt(*b, *c, *d), pt(*c, *a, *b), pt(*d, *a, *b))


total_loops = total_par = total_dup = 0
for n in sorted(nets):
    d = nets[n]
    segs = d["segs"]
    if not segs:
        continue
    # 图:节点 = 端点坐标(via 与 pad 中心也是节点);边 = 线段。同点位于两层的 via 把 F/B 端点合一(坐标相同即同节点)
    parent = {}

    def find(u):
        while parent.setdefault(u, u) != u:
            parent[u] = parent[parent[u]]; u = parent[u]
        return u

    def union(u, v):
        ru, rv = find(u), find(v)
        if ru == rv:
            return False
        parent[rv] = ru
        return True
    # 焊盘:把落在焊盘内的端点合到焊盘节点(端点在焊盘中心 0.6mm 内视为接触同一焊盘)
    pad_nodes = [(key(x, y), (x, y), nm) for x, y, nm in d["pads"]]

    def canon(pt):
        for k, (px, py), nm in pad_nodes:
            if math.hypot(pt[0] - px, pt[1] - py) < 0.6:
                return k
        return key(*pt)
    # 完全重复段(同层同坐标)与共线重叠段
    seen, dups, colin = {}, [], []
    for i, (a, b, lay) in enumerate(segs):
        k = (lay,) + tuple(sorted([key(*a), key(*b)]))
        if k in seen:
            dups.append((lay, a, b))
        else:
            seen[k] = i
    for i in range(len(segs)):
        a, b, la = segs[i]
        va = (b[0] - a[0], b[1] - a[1]); La = math.hypot(*va)
        if La < 0.3:
            continue
        for j in range(i + 1, len(segs)):
            c, e, lb = segs[j]
            if la != lb:
                continue
            vb = (e[0] - c[0], e[1] - c[1]); Lb = math.hypot(*vb)
            if Lb < 0.3:
                continue
            cosang = abs(va[0] * vb[0] + va[1] * vb[1]) / (La * Lb)
            if cosang < 0.9999:
                continue
            # 共线:c 到直线 ab 距离 < 0.03
            ux, uy = va[0] / La, va[1] / La
            dist_c = abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux)
            if dist_c > 0.03:
                continue
            pa = sorted([0.0, La])
            pb = sorted([(c[0] - a[0]) * ux + (c[1] - a[1]) * uy, (e[0] - a[0]) * ux + (e[1] - a[1]) * uy])
            ov = min(pa[1], pb[1]) - max(pa[0], pb[0])
            if ov > 0.3:
                colin.append((round(ov, 2), la, a, b, c, e))
    loops = []
    for a, b, lay in segs:
        u, v = canon(a), canon(b)
        if u == v:
            loops.append(("self-loop/stub-in-pad", a, b, lay)); continue
        if not union(u, v):
            loops.append(("cycle", a, b, lay))
    # 平行贴走:同层、同网、近似平行、间距 < PAR_GAP、重叠投影长度 > PAR_LEN
    pars = []
    for i in range(len(segs)):
        a, b, la = segs[i]
        va = (b[0] - a[0], b[1] - a[1]); La = math.hypot(*va)
        if La < 0.5:
            continue
        for j in range(i + 1, len(segs)):
            c, e, lb = segs[j]
            if la != lb and not CROSS:
                continue
            vb = (e[0] - c[0], e[1] - c[1]); Lb = math.hypot(*vb)
            if Lb < 0.5:
                continue
            cosang = abs(va[0] * vb[0] + va[1] * vb[1]) / (La * Lb)
            if cosang < 0.985:  # ~10° 内算平行
                continue
            g = seg_dist(a, b, c, e)
            if g > PAR_GAP or g < 0.05:
                continue
            # 投影重叠长度
            ux, uy = va[0] / La, va[1] / La
            pa = sorted([0.0, La])
            pb = sorted([(c[0] - a[0]) * ux + (c[1] - a[1]) * uy, (e[0] - a[0]) * ux + (e[1] - a[1]) * uy])
            ov = min(pa[1], pb[1]) - max(pa[0], pb[0])
            if ov > PAR_LEN:
                pars.append((round(ov, 1), round(g, 2), la + ("/" + lb if la != lb else ""), a, b, c, e))
    if loops or pars or dups or colin:
        print("== %s  segs=%d vias=%d pads=%d" % (n, len(segs), len(d["vias"]), len(d["pads"])))
        for lay, a, b in dups:
            print("   [DUPLICATE] %s (%.3f,%.3f)-(%.3f,%.3f)" % (lay, *a, *b))
        for ov, lay, a, b, c, e in colin:
            print("   [collinear-overlap %.2fmm] %s (%.3f,%.3f)-(%.3f,%.3f) & (%.3f,%.3f)-(%.3f,%.3f)" % (ov, lay, *a, *b, *c, *e))
        for kind, a, b, lay in loops:
            print("   [%s] %s (%.3f,%.3f)-(%.3f,%.3f)" % (kind, lay, *a, *b))
        for ov, g, lay, a, b, c, e in sorted(pars, reverse=True):
            print("   [parallel] %s overlap=%.1fmm gap=%.2f  (%.2f,%.2f)-(%.2f,%.2f) || (%.2f,%.2f)-(%.2f,%.2f)" % (lay, ov, g, *a, *b, *c, *e))
        total_loops += len(loops); total_par += len(pars); total_dup += len(dups) + len(colin)
print("TOTAL: cycle/self-loop segs=%d  parallel pairs=%d  duplicate/collinear=%d" % (total_loops, total_par, total_dup))
