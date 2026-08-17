# kicad-host-kit 公共库:世界模型(焊盘/走线/via/规则区)、几何净空、八向 A*、动作落板。
# 依赖 KiCad 自带 python(pcbnew SWIG):D:\KiCad\bin\python.exe <script> ...
import heapq
import json
import math
import os
import sys

import pcbnew

GRID = 0.125          # 与 QFP 0.5mm 引脚栅位对齐(0.1 会永远差 0.05 踩不进巷道——案例 #11 实测)
W = 0.25              # 默认线宽
HALF = W / 2
VIA_D, VIA_R, VIA_DRILL = 0.6, 0.3, 0.3
CLR = 0.2005          # 与 0.2 网类间距贴平的合法值
MM = pcbnew.FromMM


def work_dir(pcb_path):
    d = os.environ.get("KIT_WORK") or os.path.join(os.path.dirname(os.path.abspath(pcb_path)), "_kit")
    os.makedirs(d, exist_ok=True)
    return d


def restore_path(pcb_path):
    return os.path.join(work_dir(pcb_path), "restore.json")


def actions_path(pcb_path):
    return os.path.join(work_dir(pcb_path), "actions.json")


def load_world(board):
    """返回 (pad_boxes, wires, keepouts, bbox)。pad_boxes: (x0,y0,x1,y1,net,is_tht);
    wires: (ax,ay,bx,by,halfw,net,layer 'F'|'B'|'V'); keepouts: (x0,y0,x1,y1,layer)。"""
    pads, wires, keepouts = [], [], []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            p = pad.GetPosition()
            sz = pad.GetSize(pcbnew.F_Cu)
            w, h = sz.x / 1e6, sz.y / 1e6
            if int(round(pad.GetOrientationDegrees())) % 180 in (90, -90):
                w, h = h, w
            cx, cy = p.x / 1e6, p.y / 1e6
            pads.append((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, pad.GetNetname(),
                         pad.GetAttribute() != pcbnew.PAD_ATTRIB_SMD))
    for t in board.GetTracks():
        if t.GetClass() == "PCB_VIA":
            p = t.GetPosition()
            wires.append((p.x / 1e6, p.y / 1e6, p.x / 1e6, p.y / 1e6, t.GetWidth(pcbnew.F_Cu) / 2e6, t.GetNetname(), "V"))
        else:
            s, e = t.GetStart(), t.GetEnd()
            wires.append((s.x / 1e6, s.y / 1e6, e.x / 1e6, e.y / 1e6, t.GetWidth() / 2e6, t.GetNetname(),
                          "B" if t.GetLayer() == pcbnew.B_Cu else "F"))
    for z in board.Zones():
        if z.GetIsRuleArea() and z.GetDoNotAllowTracks():
            bb = z.GetBoundingBox()
            keepouts.append((bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6,
                             "B" if z.IsOnLayer(pcbnew.B_Cu) else "F"))
    eb = board.GetBoardEdgesBoundingBox()
    bbox = (eb.GetLeft() / 1e6, eb.GetTop() / 1e6, eb.GetRight() / 1e6, eb.GetBottom() / 1e6)
    return pads, wires, keepouts, bbox


def pad_map(board):
    """(ref, pinnum) -> (x, y, net);以及细长焊盘的逃逸桩尖 (ref,pin) -> (x,y)。"""
    pos, stub = {}, {}
    for fp in board.GetFootprints():
        c = fp.GetPosition()
        for pad in fp.Pads():
            p = pad.GetPosition()
            sz = pad.GetSize(pcbnew.F_Cu)
            w, h = sz.x / 1e6, sz.y / 1e6
            if int(round(pad.GetOrientationDegrees())) % 180 in (90, -90):
                w, h = h, w
            cx, cy = p.x / 1e6, p.y / 1e6
            key = (fp.GetReference(), str(pad.GetNumber()))
            pos[key] = (cx, cy, pad.GetNetname())
            if max(w, h) / max(0.01, min(w, h)) > 2:  # 细长焊盘(QFP):沿长轴向体外逃逸
                dx, dy = p.x - c.x, p.y - c.y
                if w > h:
                    stub[key] = (cx + (1 if dx >= 0 else -1) * (w / 2 + 0.55), cy)
                else:
                    stub[key] = (cx, cy + (1 if dy >= 0 else -1) * (h / 2 + 0.55))
    return pos, stub


def pt_seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def pt_box_dist(px, py, b):
    return math.hypot(max(b[0] - px, 0, px - b[2]), max(b[1] - py, 0, py - b[3]))


class World:
    """净空查询;wires 可增量登记(register)。"""

    def __init__(self, board):
        self.pads, self.wires, self.keepouts, self.bbox = load_world(board)
        x0, y0, x1, y1 = self.bbox
        self.inner = (x0 + 0.8, y0 + 0.8, x1 - 0.8, y1 - 0.8)

    def in_board(self, px, py):
        return self.inner[0] <= px <= self.inner[2] and self.inner[1] <= py <= self.inner[3]

    def in_keepout(self, px, py, layer, half):
        for k in self.keepouts:
            if k[4] == layer and k[0] - half - 0.2 <= px <= k[2] + half + 0.2 and k[1] - half - 0.2 <= py <= k[3] + half + 0.2:
                return True
        return False

    def free_pads(self, px, py, layer, net, half):
        if not self.in_board(px, py):
            return False
        for b in self.pads:
            if b[5]:
                if b[4] == net:
                    continue
                if pt_box_dist(px, py, b[:4]) < half + 0.5:
                    return False
            elif layer == "F":
                if b[4] == net:
                    continue
                if pt_box_dist(px, py, b[:4]) < half + CLR:
                    return False
        return True

    def free_wires(self, px, py, layer, net, half):
        for w in self.wires:
            if w[6] == "V":
                if w[5] != net and pt_seg_dist(px, py, w[0], w[1], w[2], w[3]) < half + w[4] + CLR:
                    return False
            elif w[6] == layer and w[5] != net:
                if pt_seg_dist(px, py, w[0], w[1], w[2], w[3]) < half + w[4] + CLR:
                    return False
        return True

    def free_at(self, px, py, layer, net, half):
        return (not self.in_keepout(px, py, layer, half)) and self.free_pads(px, py, layer, net, half) and self.free_wires(px, py, layer, net, half)

    def via_ok(self, px, py, net):
        for b in self.pads:
            if b[5]:
                cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                if math.hypot(px - cx, py - cy) < 0.95:  # 孔距
                    return False
                if b[4] != net and pt_box_dist(px, py, b[:4]) < VIA_R + 0.55:
                    return False
            elif b[4] != net and pt_box_dist(px, py, b[:4]) < VIA_R + CLR:
                return False
        for w in self.wires:
            if w[6] == "V":
                if math.hypot(px - w[0], py - w[1]) < 0.9:
                    return False
            elif w[5] != net and pt_seg_dist(px, py, w[0], w[1], w[2], w[3]) < VIA_R + w[4] + CLR:
                return False
        return True

    def register(self, full, net, half=HALF):
        for i in range(len(full) - 1):
            p1, p2 = full[i], full[i + 1]
            if p1[2] != p2[2]:
                self.wires.append((p1[0], p1[1], p1[0], p1[1], VIA_R, net, "V"))
            else:
                self.wires.append((p1[0], p1[1], p2[0], p2[1], half, net, p1[2]))


def astar(world, a, b, net, half=HALF, b_cost=4.0, it_cap=350000, main_pour=None):
    """两层八向 A*。b='DIVE' 时目标为"任意 B 层且落在 main_pour(x,y)->bool 判定的主池内"的点。
    返回 [(x,y,layer),...] 或 None。端点 0.3mm 内只豁免焊盘净空,永不豁免走线净空。"""
    dive = (b == "DIVE")

    def snap(v):
        return round(v / GRID) * GRID
    start = (snap(a[0]), snap(a[1]), "F")
    goal = None if dive else (snap(b[0]), snap(b[1]))
    openq = [(0, 0, start, None)]
    came, gbest = {}, {start: 0}
    D = GRID
    DIRS = [(D, 0), (-D, 0), (0, D), (0, -D), (D, D), (D, -D), (-D, D), (-D, -D)]
    it = 0
    while openq and it < it_cap:
        it += 1
        f, g, cur, prev = heapq.heappop(openq)
        if cur in came:
            continue
        came[cur] = prev
        if dive:
            reached = cur[2] == "B" and main_pour is not None and main_pour(cur[0], cur[1])
        else:
            reached = abs(cur[0] - goal[0]) < 1e-9 and abs(cur[1] - goal[1]) < 1e-9 and cur[2] == "F"
        if reached:
            path = [cur]
            while came[path[-1]] is not None:
                path.append(came[path[-1]])
            return list(reversed(path))
        x, y, lay = cur
        mult = b_cost if lay == "B" else 1.0
        for dx, dy in DIRS:
            nxt = (round(x + dx, 4), round(y + dy, 4), lay)
            if nxt in came:
                continue
            near_end = (lay == "F" and (math.hypot(nxt[0] - a[0], nxt[1] - a[1]) < 0.3 or
                                        (not dive and math.hypot(nxt[0] - b[0], nxt[1] - b[1]) < 0.3)))
            if near_end:
                if not world.free_wires(nxt[0], nxt[1], lay, net, half):
                    continue
            elif not world.free_at(nxt[0], nxt[1], lay, net, half):
                continue
            if dx and dy:  # 对角步中点也须合法(防切角穿越)
                mx, my = x + dx / 2, y + dy / 2
                if not world.free_wires(mx, my, lay, net, half):
                    continue
                if not near_end and not world.free_pads(mx, my, lay, net, half):
                    continue
            ng = g + GRID * (1.41421356 if dx and dy else 1.0) * mult
            if nxt not in gbest or ng < gbest[nxt] - 1e-9:
                gbest[nxt] = ng
                h = 0.0 if dive else (max(abs(nxt[0] - goal[0]), abs(nxt[1] - goal[1])) + 0.414 * min(abs(nxt[0] - goal[0]), abs(nxt[1] - goal[1])))
                heapq.heappush(openq, (ng + h, ng, nxt, cur))
        other = "B" if lay == "F" else "F"
        nxt = (x, y, other)
        if nxt not in came and world.via_ok(x, y, net) and world.free_at(x, y, other, net, half):
            ng = g + 1.5
            if nxt not in gbest or ng < gbest[nxt] - 1e-9:
                gbest[nxt] = ng
                h = 0.0 if dive else (max(abs(x - goal[0]), abs(y - goal[1])) + 0.414 * min(abs(x - goal[0]), abs(y - goal[1])))
                heapq.heappush(openq, (ng + h, ng, nxt, cur))
    return None


def simplify(path):
    def sgn(v):
        return 0 if abs(v) < 1e-9 else (1 if v > 0 else -1)
    out = [path[0]]
    for i in range(1, len(path) - 1):
        a, b, c = out[-1], path[i], path[i + 1]
        if b[2] != a[2] or c[2] != b[2] or (sgn(b[0] - a[0]), sgn(b[1] - a[1])) != (sgn(c[0] - b[0]), sgn(c[1] - b[1])):
            out.append(path[i])
    out.append(path[-1])
    return out


def fine_verify(world, full, net, half=HALF):
    """落地前 0.02mm 细采样复检(端点 0.3 内只豁免焊盘)。"""
    for i in range(len(full) - 1):
        p1, p2 = full[i], full[i + 1]
        if p1[2] != p2[2]:
            continue
        L = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        n = max(2, int(L / 0.02))
        for k in range(n + 1):
            qx = p1[0] + (p2[0] - p1[0]) * k / n
            qy = p1[1] + (p2[1] - p1[1]) * k / n
            near = math.hypot(qx - full[0][0], qy - full[0][1]) < 0.3 or math.hypot(qx - full[-1][0], qy - full[-1][1]) < 0.3
            if not world.free_wires(qx, qy, p1[2], net, half):
                return False
            if not near and not world.free_pads(qx, qy, p1[2], net, half):
                return False
    return True


def main_pour_tester(board, netname="GND", margin=0.45):
    """返回 f(x,y)->bool:点(含四向 margin)是否落在该网 B.Cu 铺铜的最大轮廓内。"""
    polys, idx = None, -1
    for z in board.Zones():
        if z.GetIsRuleArea() or z.GetNetname() != netname:
            continue
        ps = z.GetFilledPolysList(pcbnew.B_Cu)
        best = -1
        for i in range(ps.OutlineCount()):
            a = abs(ps.Outline(i).Area())
            if a > best:
                best, idx = a, i
        polys = ps
    if polys is None:
        return lambda x, y: False

    def f(px, py):
        for dx, dy in ((0, 0), (margin, 0), (-margin, 0), (0, margin), (0, -margin)):
            if not polys.Contains(pcbnew.VECTOR2I(int((px + dx) * 1e6), int((py + dy) * 1e6)), idx):
                return False
        return True
    return f


def apply_actions(board, actions, width=W):
    """actions: [{"net":..,"pts":[[x,y,layer],...]}] → 落轨迹/via。返回 (n_tracks, n_vias)。"""
    n_tr = n_via = 0
    for a in actions:
        ni = board.FindNet(a["net"])
        pts = a["pts"]
        for i in range(len(pts) - 1):
            (ax, ay, la), (bx, by, lb) = pts[i], pts[i + 1]
            if la != lb:
                v = pcbnew.PCB_VIA(board)
                v.SetPosition(pcbnew.VECTOR2I(MM(ax), MM(ay)))
                v.SetWidth(MM(VIA_D)); v.SetDrill(MM(VIA_DRILL))
                v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                v.SetNet(ni)
                board.Add(v); n_via += 1
                continue
            if abs(ax - bx) < 1e-9 and abs(ay - by) < 1e-9:
                continue
            tr = pcbnew.PCB_TRACK(board)
            tr.SetStart(pcbnew.VECTOR2I(MM(ax), MM(ay)))
            tr.SetEnd(pcbnew.VECTOR2I(MM(bx), MM(by)))
            tr.SetLayer(pcbnew.F_Cu if la == "F" else pcbnew.B_Cu)
            tr.SetWidth(MM(width))
            tr.SetNet(ni)
            board.Add(tr); n_tr += 1
    return n_tr, n_via


def refill_and_save(board, path):
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(path, board)


def drc_items(report_path):
    """解析 kicad-cli drc 文本报告 → [(kind, [(x,y,desc), ...]), ...]"""
    import re
    lines = open(report_path, encoding="utf-8").read().split("\n")
    out = []
    for i, l in enumerate(lines):
        m = re.match(r"^\[([a-z_0-9]+)\]", l)
        if not m:
            continue
        items = []
        for j in range(i + 1, min(i + 4, len(lines))):
            mm = re.search(r"@\(([\d.]+) mm, ([\d.]+) mm\): (.*)$", lines[j])
            if mm:
                items.append((float(mm.group(1)), float(mm.group(2)), mm.group(3)))
        out.append((m.group(1), items))
    return out
