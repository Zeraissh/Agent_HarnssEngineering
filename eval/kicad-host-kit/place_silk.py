# 丝印位号自动安置:对给定 ref 逐个试候选位(围绕器件的环 × 角度 × 0/90°),几何净空(焊盘/走线/via/他人丝印/板级标注/板边)取首个合法位
# 用法: python place_silk.py <pcb> REF,REF,... [--size 0.85,1.0] [--thick 0.15]
import math
import sys

import pcbnew

from kit_common import MM

PCB = sys.argv[1]
REFS = sys.argv[2].split(",")
SIZE = (0.85, 1.0)
THICK = 0.15
for i, a in enumerate(sys.argv):
    if a == "--size":
        SIZE = tuple(float(v) for v in sys.argv[i + 1].split(","))
    if a == "--thick":
        THICK = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)
eb = board.GetBoardEdgesBoundingBox()
BX0, BY0, BX1, BY1 = eb.GetLeft() / 1e6 + 0.7, eb.GetTop() / 1e6 + 0.7, eb.GetRight() / 1e6 - 0.7, eb.GetBottom() / 1e6 - 0.7
pads, tracks, silks = [], [], []
for fp in board.GetFootprints():
    for pad in fp.Pads():
        bb = pad.GetBoundingBox()
        pads.append((bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6))
    for it in fp.GraphicalItems():
        if it.GetLayer() == pcbnew.F_SilkS:
            bb = it.GetBoundingBox()
            silks.append((fp.GetReference(), bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6))
    if fp.GetReference() not in REFS:
        bb = fp.Reference().GetBoundingBox()
        silks.append((fp.GetReference() + ":ref", bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6))
for d in board.GetDrawings():
    if isinstance(d, pcbnew.PCB_TEXT) and d.GetLayer() == pcbnew.F_SilkS:
        bb = d.GetBoundingBox()
        silks.append(("@text", bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6))
for t in board.GetTracks():
    if t.GetClass() == "PCB_VIA":
        p = t.GetPosition()
        tracks.append((p.x / 1e6 - 0.3, p.y / 1e6 - 0.3, p.x / 1e6 + 0.3, p.y / 1e6 + 0.3))
    elif t.GetLayer() == pcbnew.F_Cu:
        s, e = t.GetStart(), t.GetEnd()
        hw = t.GetWidth() / 2e6
        tracks.append((min(s.x, e.x) / 1e6 - hw, min(s.y, e.y) / 1e6 - hw, max(s.x, e.x) / 1e6 + hw, max(s.y, e.y) / 1e6 + hw))


def overlap(a, b, m):
    return not (a[2] + m < b[0] or b[2] + m < a[0] or a[3] + m < b[1] or b[3] + m < a[1])


def legal(box, me):
    if box[0] < BX0 or box[1] < BY0 or box[2] > BX1 or box[3] > BY1:
        return False
    if any(overlap(box, p, 0.08) for p in pads) or any(overlap(box, tr, 0.08) for tr in tracks):
        return False
    return not any(overlap(box, sb, 0.08) for owner, *sb in silks if owner != me)


placed, failed = [], []
for ref in REFS:
    fp = board.FindFootprintByReference(ref)
    if fp is None:
        failed.append(ref); continue
    txt = fp.Reference()
    c = fp.GetPosition()
    cx, cy = c.x / 1e6, c.y / 1e6
    fbb = fp.GetBoundingBox(False, False)
    rx, ry = fbb.GetWidth() / 2e6, fbb.GetHeight() / 2e6
    orig = txt.GetPosition()
    txt.SetTextSize(pcbnew.VECTOR2I(MM(SIZE[0]), MM(SIZE[1])))
    txt.SetTextThickness(MM(THICK))
    ok = False
    for rot in (0, 90):
        txt.SetTextAngleDegrees(rot)
        for ring in (0.5, 0.9, 1.4, 2.0, 2.8, 3.6, 4.5, 5.5, 6.5, 7.5, 9.0):
            for ang in range(0, 360, 15):
                a = math.radians(ang)
                txt.SetPosition(pcbnew.VECTOR2I(MM(cx + (rx + ring) * math.cos(a)), MM(cy + (ry + ring) * math.sin(a))))
                bb = txt.GetBoundingBox()
                box = (bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6)
                if legal(box, ref):
                    ok = True; silks.append((ref + ":ref", *box)); break
            if ok:
                break
        if ok:
            break
    (placed if ok else failed).append(ref)
    if not ok:
        txt.SetPosition(orig)
pcbnew.SaveBoard(PCB, board)
print("placed:", placed, "| failed (kept original position; no clean spot within 9mm — silk over F.Cu tracks counts as dirty here):", failed)
