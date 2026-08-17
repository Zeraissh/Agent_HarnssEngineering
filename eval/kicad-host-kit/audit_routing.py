# 布线惯例审计(判据先写,任何布线结果过同一份体检单)。判据来源:docs/reference/l151-production-board-conventions.md
# 用法: python audit_routing.py <pcb> [--xtal x0,y0,x1,y1] [--xtal-nets OSC_IN,OSC_OUT,...]
import math
import sys
from collections import Counter, defaultdict

import pcbnew

PCB = sys.argv[1]
XTAL_BOX = None
XTAL_NETS = {"OSC_IN", "OSC_OUT", "OSC32_IN", "OSC32_OUT", "GND"}
for i, a in enumerate(sys.argv):
    if a == "--xtal":
        XTAL_BOX = tuple(float(v) for v in sys.argv[i + 1].split(","))
    if a == "--xtal-nets":
        XTAL_NETS = set(sys.argv[i + 1].split(",")) | {"GND"}
board = pcbnew.LoadBoard(PCB)
verdicts = []


def ok(cond, name, detail):
    verdicts.append((cond, name, detail))


tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
lay_len = defaultdict(float)
longest_b = (0.0, "")
b_by_net = defaultdict(float)
dirstat = defaultdict(Counter)
intruders = set()
for t in tracks:
    s, e = t.GetStart(), t.GetEnd()
    L = math.hypot(e.x - s.x, e.y - s.y) / 1e6
    lname = board.GetLayerName(t.GetLayer())
    lay_len[lname] += L
    if t.GetLayer() == pcbnew.B_Cu:
        b_by_net[t.GetNetname()] += L
        if L > longest_b[0]:
            longest_b = (L, t.GetNetname())
    dx, dy = abs(e.x - s.x), abs(e.y - s.y)
    if dx or dy:
        ang = math.degrees(math.atan2(dy, dx))
        dirstat[lname]["H" if ang < 5 else ("V" if ang > 85 else ("45" if 40 < ang < 50 else "odd"))] += 1
    if XTAL_BOX:
        for px, py in ((s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6)):
            if XTAL_BOX[0] <= px <= XTAL_BOX[2] and XTAL_BOX[1] <= py <= XTAL_BOX[3] and t.GetNetname() not in XTAL_NETS:
                intruders.add(t.GetNetname())
f_len, b_len = lay_len.get("F.Cu", 0.0), lay_len.get("B.Cu", 0.0)
ok(b_len <= 0.4 * max(f_len, 1e-9), "底层走线量(≤顶层40%)", "F=%.1fmm B=%.1fmm ratio=%.2f" % (f_len, b_len, b_len / max(f_len, 1e-9)))
ok(longest_b[0] <= 15.0, "最长底层单段(≤15mm)", "%.1fmm on %s" % longest_b)
ratio = len(vias) / max(len(tracks), 1)
ok(len(vias) <= 80 and ratio <= 0.35, "via 经济性(≤80 且 ≤0.35/段)", "vias=%d tracks=%d ratio=%.2f" % (len(vias), len(tracks), ratio))
if XTAL_BOX:
    ok(not intruders, "晶振区无无关信号", "intruders=%s" % (sorted(intruders) or "none"))
islands = None
for z in board.Zones():
    if z.GetIsRuleArea():
        continue
    try:
        islands = z.GetFilledPolysList(pcbnew.B_Cu).OutlineCount()
    except Exception as e:
        islands = "n/a(%s)" % e
ok(islands == 1, "GND 池单一连通(孤岛=0)", "outline count=%s" % islands)
widths = Counter(round(t.GetWidth() / 1e6, 2) for t in tracks)
vsz = Counter((round(v.GetWidth(pcbnew.F_Cu) / 1e6, 2), round(v.GetDrillValue() / 1e6, 2)) for v in vias)
ok(all(w >= 0.25 for w in widths), "线宽 ≥0.25", "widths=%s" % dict(widths))
ok(all(k == (0.6, 0.3) for k in vsz), "via 0.6/0.3", "vias=%s" % dict(vsz))
dirs = {l: {k: "%d(%.0f%%)" % (n, 100 * n / max(sum(c.values()), 1)) for k, n in c.most_common()} for l, c in dirstat.items()}
print("== 布线惯例审计:", PCB)
for cond, name, detail in verdicts:
    print("  [%s] %s — %s" % ("PASS" if cond else "FAIL", name, detail))
print("  [info] 走向:", dirs)
print("  [info] 底层按网:", {k: round(v, 1) for k, v in sorted(b_by_net.items(), key=lambda kv: -kv[1])[:8]})
fails = [n for c, n, _ in verdicts if not c]
print("RESULT:", "ALL PASS" if not fails else "FAIL: " + ", ".join(fails))
