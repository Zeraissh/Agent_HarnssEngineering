# 全板拐角整形:度数为 2 的走线拐点(无 via/焊盘)且非"八向 45° 干净角" → 优先改八向 L 形(两段 45° 倍数),
# 否则倒 45° 斜角。逐遍收敛(通常 3 遍);焊盘入口 <0.4mm 的微折可能残留(视觉不可见)。
# 用法: python mitre.py <pcb> [--dry]
import math
import sys
from collections import defaultdict

import pcbnew

from kit_common import CLR, MM, World, pt_box_dist, pt_seg_dist, refill_and_save

PCB = sys.argv[1]
DRY = "--dry" in sys.argv
board = pcbnew.LoadBoard(PCB)
world = World(board)
segs = []  # (item, ax, ay, bx, by, halfw, net, layer)
for t in board.GetTracks():
    if t.GetClass() != "PCB_VIA":
        s, e = t.GetStart(), t.GetEnd()
        segs.append((t, s.x / 1e6, s.y / 1e6, e.x / 1e6, e.y / 1e6, t.GetWidth() / 2e6, t.GetNetname(),
                     "B" if t.GetLayer() == pcbnew.B_Cu else "F"))
via_pts = [(w[0], w[1], w[5]) for w in world.wires if w[6] == "V"]
pad_pts = [((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for b in world.pads]


def seg_legal(ax, ay, bx, by, net, layer, half, skip):
    L = math.hypot(bx - ax, by - ay)
    n = max(2, int(L / 0.05))
    for k in range(n + 1):
        px, py = ax + (bx - ax) * k / n, ay + (by - ay) * k / n
        if not world.in_board(px, py) or world.in_keepout(px, py, layer, half):
            return False
        for b in world.pads:
            if b[4] == net:
                continue
            need = half + (0.5 if b[5] else CLR)
            if (b[5] or layer == "F") and pt_box_dist(px, py, b[:4]) < need:
                return False
        for vx, vy, vn in via_pts:
            if vn != net and math.hypot(px - vx, py - vy) < half + 0.3 + CLR:
                return False
        for si, s in enumerate(segs):
            if si in skip or s[6] == net or s[7] != layer:
                continue
            if pt_seg_dist(px, py, s[1], s[2], s[3], s[4]) < half + s[5] + CLR:
                return False
    return True


def key(x, y):
    return (round(x, 3), round(y, 3))


def unit(dx, dy):
    L = math.hypot(dx, dy)
    return (dx / L, dy / L) if L else (0, 0)


def is_oct(dx, dy):
    a = (math.degrees(math.atan2(dy, dx)) + 360) % 45
    return min(a, 45 - a) < 0.5


node = defaultdict(list)
for i, s in enumerate(segs):
    node[(s[6], s[7], key(s[1], s[2]))].append(i)
    node[(s[6], s[7], key(s[3], s[4]))].append(i)
occupied = set(key(*p) for p in pad_pts) | set(key(vx, vy) for vx, vy, _ in via_pts)
stats = defaultdict(int)
plans, used = [], set()
for (net, layer, k), idxs in node.items():
    if len(idxs) != 2 or k in occupied:
        continue
    i, j = idxs
    if i in used or j in used:
        continue
    si, sj = segs[i], segs[j]
    bx, by = k
    ax, ay = (si[3], si[4]) if key(si[1], si[2]) == k else (si[1], si[2])
    cx, cy = (sj[3], sj[4]) if key(sj[1], sj[2]) == k else (sj[1], sj[2])
    u1, u2 = unit(bx - ax, by - ay), unit(cx - bx, cy - by)
    dot = max(-1, min(1, u1[0] * u2[0] + u1[1] * u2[1]))
    turn = round(math.degrees(math.acos(dot)))
    stats[turn] += 1
    clean = ((turn <= 1) or (abs(turn - 45) <= 1)) and is_oct(*u1) and is_oct(*u2)
    if clean:
        continue
    if DRY:
        print("  bad corner %-8s %s turn=%d at (%.2f,%.2f)" % (net, layer, turn, bx, by))
    half, skip = si[5], {i, j}
    cand = []
    dx, dy = cx - ax, cy - ay
    adx, ady = abs(dx), abs(dy)
    if adx > 1e-6 and ady > 1e-6 and abs(adx - ady) > 1e-6:
        m = min(adx, ady)
        sx, sy = (1 if dx > 0 else -1), (1 if dy > 0 else -1)
        p1 = (ax + sx * m, ay + sy * m)
        p2 = (cx - sx * m, ay) if adx > ady else (ax, cy - sy * m)
        cand += [[(ax, ay), p1, (cx, cy)], [(ax, ay), p2, (cx, cy)]]
    elif is_oct(dx, dy) and (adx > 1e-6 or ady > 1e-6):
        cand.append([(ax, ay), (cx, cy)])
    for d in (0.6, 0.45, 0.3):
        la, lc = math.hypot(bx - ax, by - ay), math.hypot(cx - bx, cy - by)
        if la < d * 1.6 or lc < d * 1.6:
            continue
        cand.append([(ax, ay), (bx - u1[0] * d, by - u1[1] * d), (bx + u2[0] * d, by + u2[1] * d), (cx, cy)])
    chosen = None
    for path in cand:
        if all(math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6 or seg_legal(p[0], p[1], q[0], q[1], net, layer, half, skip)
               for p, q in zip(path, path[1:])):
            chosen = path; break
    if chosen:
        used |= {i, j}
        plans.append(([i, j], [(p[0], p[1], q[0], q[1]) for p, q in zip(chosen, chosen[1:]) if math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6], net, layer, half))
print("corner turn stats:", dict(sorted(stats.items())))
print("plans:", len(plans))
if DRY:
    sys.exit(0)
for rm, news, net, layer, half in plans:
    for i in rm:
        board.Remove(segs[i][0])
for rm, news, net, layer, half in plans:
    ni = board.FindNet(net)
    for ax, ay, bx, by in news:
        tr = pcbnew.PCB_TRACK(board)
        tr.SetStart(pcbnew.VECTOR2I(MM(ax), MM(ay))); tr.SetEnd(pcbnew.VECTOR2I(MM(bx), MM(by)))
        tr.SetLayer(pcbnew.B_Cu if layer == "B" else pcbnew.F_Cu)
        tr.SetWidth(MM(half * 2)); tr.SetNet(ni)
        board.Add(tr)
refill_and_save(board, PCB)
print("applied", len(plans), "corner fixes")
