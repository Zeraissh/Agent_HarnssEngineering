# kicad_audit: routing-convention audit for a 2-layer board (read-only).
# Criteria come from docs/reference/l151-production-board-conventions.md (calibrated on production boards):
#   1. bottom layer is a reference plane: B.Cu track length <= 40% of F.Cu
#   2. longest single B.Cu segment <= 15 mm (longer runs cut the plane and need justification)
#   3. via economy: <= 80 vias and <= 0.35 via/track-segment
#   4. no unrelated nets inside crystal zones (crystal footprint bbox + 1.0 mm margin, any layer)
#   5. GND pour on B.Cu is one connected outline (production reference: single outline)
#   6. track width >= 0.25 mm; 7. vias 0.6/0.3 mm
# usage: audit_routing.py <pcb> [--json]
import json
import math
import sys
from collections import Counter, defaultdict

import pcbnew

PCB = sys.argv[1]
AS_JSON = "--json" in sys.argv
board = pcbnew.LoadBoard(PCB)
if board is None:
    print("ERROR: board failed to load"); sys.exit(2)

checks = []
def check(ok, name, detail):
    checks.append({"pass": bool(ok), "name": name, "detail": detail})

tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]

# crystal zones: footprints whose reference starts with Y or whose footprint name contains "Crystal"
xtal_boxes = []
for fp in board.GetFootprints():
    ref = fp.GetReference()
    fpid = str(fp.GetFPID().GetLibItemName())
    if ref.upper().startswith("Y") or "crystal" in fpid.lower():
        bb = fp.GetBoundingBox(False, False)
        nets = {p.GetNetname() for p in fp.Pads()}
        xtal_boxes.append((ref, bb.GetLeft() / 1e6 - 1.0, bb.GetTop() / 1e6 - 1.0,
                           bb.GetRight() / 1e6 + 1.0, bb.GetBottom() / 1e6 + 1.0, nets))

lay_len = defaultdict(float)
longest_b = (0.0, "")
b_by_net = defaultdict(float)
dirstat = defaultdict(Counter)
intruders = defaultdict(set)
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
        k = "H" if ang < 5 else ("V" if ang > 85 else ("45" if 40 < ang < 50 else "odd"))
        dirstat[lname][k] += 1
    for ref, x0, y0, x1, y1, nets in xtal_boxes:
        for px, py in ((s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6)):
            if x0 <= px <= x1 and y0 <= py <= y1 and t.GetNetname() not in nets and t.GetNetname() != "GND":
                intruders[ref].add(t.GetNetname())

f_len = lay_len.get("F.Cu", 0.0)
b_len = lay_len.get("B.Cu", 0.0)
ratio = b_len / max(f_len, 1e-9)
check(ratio <= 0.40, "bottom_is_plane(B<=40%F)", "F=%.1fmm B=%.1fmm ratio=%.2f" % (f_len, b_len, ratio))
check(longest_b[0] <= 15.0, "longest_B_segment(<=15mm)", "%.1fmm on %s" % longest_b)
vratio = len(vias) / max(len(tracks), 1)
check(len(vias) <= 80 and vratio <= 0.35, "via_economy(<=80,<=0.35/seg)",
      "vias=%d tracks=%d ratio=%.2f" % (len(vias), len(tracks), vratio))
check(not intruders, "no_foreign_nets_in_crystal_zone",
      "intruders=%s" % ({k: sorted(v) for k, v in intruders.items()} or "none"))

islands = None
island_areas = []
for z in board.Zones():
    if z.GetIsRuleArea() or z.GetNetname() != "GND" or not z.IsOnLayer(pcbnew.B_Cu):
        continue
    try:
        polys = z.GetFilledPolysList(pcbnew.B_Cu)
        islands = polys.OutlineCount()
        island_areas = sorted([abs(polys.Outline(i).Area()) / 1e12 for i in range(islands)], reverse=True)
    except Exception as e:
        islands = "n/a(%s)" % e
if islands is None:
    check(False, "gnd_pour_single_outline", "no GND zone on B.Cu")
else:
    check(islands == 1, "gnd_pour_single_outline",
          "outlines=%s areas_mm2=%s" % (islands, [round(a, 1) for a in island_areas[:6]]))

widths = Counter(round(t.GetWidth() / 1e6, 2) for t in tracks)
vsz = Counter((round(v.GetWidth(pcbnew.F_Cu) / 1e6, 2), round(v.GetDrillValue() / 1e6, 2)) for v in vias)
check(all(w >= 0.25 for w in widths), "track_width>=0.25", "widths=%s" % dict(widths))
check(all(k == (0.6, 0.3) for k in vsz), "via_0.6/0.3", "vias=%s" % {("%s/%s" % k): n for k, n in vsz.items()})

dirs = {l: {k: "%d(%.0f%%)" % (n, 100 * n / max(sum(c.values()), 1)) for k, n in c.most_common()} for l, c in dirstat.items()}
top_b = {k: round(v, 1) for k, v in sorted(b_by_net.items(), key=lambda kv: -kv[1])[:8]}
fails = [c["name"] for c in checks if not c["pass"]]
result = {"pcb": PCB, "checks": checks, "directions": dirs, "bottom_by_net": top_b,
          "all_pass": not fails, "fails": fails}
if AS_JSON:
    print(json.dumps(result, ensure_ascii=False))
else:
    print("== routing convention audit:", PCB)
    for c in checks:
        print("  [%s] %s -- %s" % ("PASS" if c["pass"] else "FAIL", c["name"], c["detail"]))
    print("  [info] directions:", dirs)
    print("  [info] bottom length by net:", top_b)
    print("RESULT:", "ALL PASS" if not fails else "FAIL: " + ", ".join(fails))
