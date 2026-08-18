# 逐网布线统计:段数/via 数/F 与 B 长度/绕行比(走线总长 ÷ 焊盘最小生成树长)。绕行比大的网 = 值得看图的候选。
# 用法: python net_stats.py <pcb> [--min-detour 1.5]
import math
import sys
from collections import defaultdict

import pcbnew

PCB = sys.argv[1]
MIN = 0.0
for i, a in enumerate(sys.argv):
    if a == "--min-detour":
        MIN = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)
st = defaultdict(lambda: {"segs": 0, "vias": 0, "F": 0.0, "B": 0.0, "pads": []})
for t in board.GetTracks():
    n = t.GetNetname()
    if t.GetClass() == "PCB_VIA":
        st[n]["vias"] += 1
    else:
        st[n]["segs"] += 1
        st[n]["F" if t.GetLayer() == pcbnew.F_Cu else "B"] += t.GetLength() / 1e6
for fp in board.GetFootprints():
    for pad in fp.Pads():
        n = pad.GetNetname()
        if n in st:
            p = pad.GetPosition()
            st[n]["pads"].append((p.x / 1e6, p.y / 1e6))


def mst_len(pts):
    if len(pts) < 2:
        return 0.0
    used = [pts[0]]; rest = list(pts[1:]); L = 0.0
    while rest:
        best = min(((math.hypot(a[0] - b[0], a[1] - b[1]), b) for a in used for b in rest), key=lambda x: x[0])
        L += best[0]; used.append(best[1]); rest.remove(best[1])
    return L


rows = []
for n, d in st.items():
    total = d["F"] + d["B"]
    m = mst_len(d["pads"])
    det = total / m if m > 0.5 else 0.0
    rows.append((det, n, d["segs"], d["vias"], d["F"], d["B"], m))
rows.sort(reverse=True)
print("%-9s %5s %4s %7s %7s %7s %6s" % ("net", "segs", "vias", "F_mm", "B_mm", "MST_mm", "detour"))
for det, n, s, v, F, B, m in rows:
    if det >= MIN:
        print("%-9s %5d %4d %7.1f %7.1f %7.1f %6.2f" % (n, s, v, F, B, m, det))
print("TOTAL segs=%d vias=%d F=%.1f B=%.1f" % (sum(r[2] for r in rows), sum(r[3] for r in rows), sum(r[4] for r in rows), sum(r[5] for r in rows)))
