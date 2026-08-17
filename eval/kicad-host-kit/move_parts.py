# 挪件(两阶段防 SWIG 毒化)。用法:
#   python move_parts.py <pcb> rip  REF:x,y,rot [REF:x,y,rot ...]   → 删掉与被挪件焊盘相接的走线段并存盘
#   python move_parts.py <pcb> move REF:x,y,rot [...]                → 单独进程移动封装
# 之后用 rework_loop.ps1 收口(拆冲突→清悬空→按 DRC 未连接对重连→切角)。
import sys

import pcbnew

from kit_common import MM, refill_and_save

PCB, stage = sys.argv[1], sys.argv[2]
MOVES = {}
for spec in sys.argv[3:]:
    ref, rest = spec.split(":")
    x, y, rot = [float(v) for v in rest.split(",")]
    MOVES[ref] = (x, y, rot)
board = pcbnew.LoadBoard(PCB)
if stage == "rip":
    boxes = []
    for fp in board.GetFootprints():
        if fp.GetReference() in MOVES:
            for pad in fp.Pads():
                bb = pad.GetBoundingBox()
                boxes.append((bb.GetLeft() / 1e6 - 0.05, bb.GetTop() / 1e6 - 0.05, bb.GetRight() / 1e6 + 0.05, bb.GetBottom() / 1e6 + 0.05))

    def inb(x, y):
        return any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes)
    victims = []
    for t in board.GetTracks():
        if t.GetClass() != "PCB_TRACK":
            continue
        s, e = t.GetStart(), t.GetEnd()
        if inb(s.x / 1e6, s.y / 1e6) or inb(e.x / 1e6, e.y / 1e6):
            victims.append(t)
    for t in victims:
        board.Remove(t)
    pcbnew.SaveBoard(PCB, board)
    print("pad-touching segments removed:", len(victims))
else:
    for fp in board.GetFootprints():
        if fp.GetReference() in MOVES:
            x, y, rot = MOVES[fp.GetReference()]
            fp.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
            fp.SetOrientationDegrees(rot)
    refill_and_save(board, PCB)
    print("moved:", sorted(MOVES))
