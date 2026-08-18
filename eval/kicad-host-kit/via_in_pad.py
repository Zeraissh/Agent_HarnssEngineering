# via-in-pad 体检 + 迁移建议:找出压在 SMD 焊盘上的 via(不塞孔时有吸锡风险),为每个给出焊盘旁最近的合法新位
# (via 不压任何焊盘 ≥margin;对他网净空按 kit 规则;焊盘中心→新位的 F 直连段合法;B 侧:GND 落主池,他网给出旧位→新位的 B 短接段是否合法)。
# 只报告不改板;用 edit_tracks.py 按建议落地。用法: python via_in_pad.py <pcb> [--margin 0.15] [--r 2.0]
import math
import sys

import pcbnew

from kit_common import CLR, HALF, VIA_R, World, main_pour_tester, pt_box_dist

PCB = sys.argv[1]
MARGIN, R = 0.15, 2.0
for i, a in enumerate(sys.argv):
    if a == "--margin":
        MARGIN = float(sys.argv[i + 1])
    if a == "--r":
        R = float(sys.argv[i + 1])
board = pcbnew.LoadBoard(PCB)
world = World(board)
in_main = main_pour_tester(board)
smd = [(fp.GetReference() + "-" + str(p.GetNumber()), p) for fp in board.GetFootprints() for p in fp.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD]
vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
btracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK" and t.GetLayer() == pcbnew.B_Cu]


def pad_box(p):
    bb = p.GetBoundingBox()
    return (bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6)


def clear_of_all_pads(x, y):
    for _, p in smd:
        if pt_box_dist(x, y, pad_box(p)) < VIA_R + MARGIN:
            return False
    return True


def seg_free(ax, ay, bx, by, net, layer):
    L = math.hypot(bx - ax, by - ay)
    n = max(2, int(L / 0.05))
    for k in range(n + 1):
        qx, qy = ax + (bx - ax) * k / n, ay + (by - ay) * k / n
        near_pad_end = math.hypot(qx - ax, qy - ay) < 0.3
        if not world.free_wires(qx, qy, layer, net, HALF):
            return False
        if not near_pad_end and not world.free_pads(qx, qy, layer, net, HALF):
            return False
    return True


hits = []
for v in vias:
    vp = v.GetPosition(); vx, vy = vp.x / 1e6, vp.y / 1e6
    for name, p in smd:
        if p.GetNetname() != v.GetNetname():
            continue
        if v.GetEffectiveShape(pcbnew.F_Cu).Collide(p.GetEffectiveShape(pcbnew.F_Cu)):
            hits.append((v, name, p))
print("via-in-pad hits:", len(hits))
for v, name, p in hits:
    vp = v.GetPosition(); vx, vy = vp.x / 1e6, vp.y / 1e6
    net = v.GetNetname()
    pc = p.GetPosition(); px, py = pc.x / 1e6, pc.y / 1e6
    drill_in = p.GetEffectivePolygon(pcbnew.F_Cu).Collide(vp, int(v.GetDrillValue() / 2))
    attached_b = [t for t in btracks if t.GetNetname() == net and (
        math.hypot(t.GetStart().x - vp.x, t.GetStart().y - vp.y) < 1e4 or math.hypot(t.GetEnd().x - vp.x, t.GetEnd().y - vp.y) < 1e4)]
    print("== via %s (%.3f,%.3f) on %s pad center (%.3f,%.3f) drill-in-pad=%s attachedB=%d" % (net, vx, vy, name, px, py, drill_in, len(attached_b)))
    # 临时把该 via 从世界里摘掉(它是自身网,via_ok 不受影响;但同网 wires 不阻挡)
    cands = []
    g = 0.125
    steps = int(R / g)
    for i in range(-steps, steps + 1):
        for j in range(-steps, steps + 1):
            x, y = round(px + i * g, 4), round(py + j * g, 4)
            d = math.hypot(x - px, y - py)
            if d > R or d < 0.3:
                continue
            if not clear_of_all_pads(x, y):
                continue
            if not world.via_ok(x, y, net):
                continue
            if not world.free_at(x, y, "F", net, HALF) or not world.free_at(x, y, "B", net, HALF):
                continue
            if not seg_free(px, py, x, y, net, "F"):
                continue
            if net == "GND":
                bside = in_main(x, y)
            else:
                bside = seg_free(vx, vy, x, y, net, "B") if attached_b else True
            if not bside:
                continue
            ang = abs(math.degrees(math.atan2(y - py, x - px))) % 90
            octo = min(ang, 90 - ang) < 1 or abs(ang - 45) < 1
            cands.append((0 if octo else 1, d, x, y))
    cands.sort()
    for o, d, x, y in cands[:6]:
        print("   candidate (%.3f,%.3f) dist %.2f %s" % (x, y, d, "45°/90° from pad" if o == 0 else ""))
    if not cands:
        print("   no candidate within %.1fmm" % R)
