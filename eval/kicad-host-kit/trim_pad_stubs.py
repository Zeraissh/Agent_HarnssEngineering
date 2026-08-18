# 删"焊盘内桩"/"via 内桩":两端都落在同一焊盘铜皮内(留 margin,防止把唯一入线削成擦边)或同一同网 via 焊环内的走线段
# ——焊盘/via 本身提供连通,段是纯冗余(自动布线器/切角遗留的 0.004–0.5mm 微段)。
# 用法: python trim_pad_stubs.py <pcb> [--dry] [--margin 0.12] [--no-vias]
#   --margin: 端点须深入焊盘边界 ≥margin 才算"在焊盘内"(v7 核查:C1-1 的 45° 入线被当桩删掉,剩余段只剩 0.03mm 擦焊盘圆角)
import math
import sys

import pcbnew

PCB = sys.argv[1]
DRY = "--dry" in sys.argv
MARGIN = 0.12
VIAS = "--no-vias" not in sys.argv
for i, a in enumerate(sys.argv):
    if a == "--margin":
        MARGIN = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)
M = pcbnew.FromMM(MARGIN)


def deep_inside(pad, p):
    """点在焊盘内且四邻(±margin)也在焊盘内 ≈ 距边界 ≥ margin。"""
    if not pad.HitTest(p):
        return False
    for dx, dy in ((M, 0), (-M, 0), (0, M), (0, -M)):
        if not pad.HitTest(pcbnew.VECTOR2I(p.x + dx, p.y + dy)):
            return False
    return True


pads = [(fp.GetReference(), pad) for fp in board.GetFootprints() for pad in fp.Pads()]
vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
victims = []
for t in board.GetTracks():
    if t.GetClass() != "PCB_TRACK":
        continue
    s, e = t.GetStart(), t.GetEnd()
    hit = None
    for ref, pad in pads:
        if pad.GetNetname() != t.GetNetname() or not pad.IsOnLayer(t.GetLayer()):
            continue
        if deep_inside(pad, s) and deep_inside(pad, e):
            hit = ref + "-" + str(pad.GetNumber()); break
    if hit is None and VIAS:
        for v in vias:
            if v.GetNetname() != t.GetNetname():
                continue
            c = v.GetPosition(); r = v.GetWidth(pcbnew.F_Cu) / 2 - M
            if math.hypot(s.x - c.x, s.y - c.y) <= r and math.hypot(e.x - c.x, e.y - c.y) <= r:
                hit = "via(%.3f,%.3f)" % (c.x / 1e6, c.y / 1e6); break
    if hit:
        victims.append((t, hit, s, e))
for t, name, s, e in victims:
    print("stub in %-16s %-9s (%.3f,%.3f)-(%.3f,%.3f) len=%.3f" % (name, t.GetNetname(), s.x / 1e6, s.y / 1e6, e.x / 1e6, e.y / 1e6, t.GetLength() / 1e6))
if not DRY:
    for t, *_ in victims:
        board.Remove(t)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(PCB, board)
print("stubs %s: %d" % ("found" if DRY else "removed", len(victims)))
