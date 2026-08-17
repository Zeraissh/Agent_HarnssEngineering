# 删指定坐标附近的 via。用法: python drop_via.py <pcb> NET x y [NET x y ...]
import math
import sys

import pcbnew

from kit_common import refill_and_save

PCB = sys.argv[1]
board = pcbnew.LoadBoard(PCB)
args = sys.argv[2:]
targets = [(args[i], float(args[i + 1]), float(args[i + 2])) for i in range(0, len(args), 3)]
removed = 0
for t in list(board.GetTracks()):
    if t.GetClass() != "PCB_VIA":
        continue
    p = t.GetPosition()
    for net, x, y in targets:
        if t.GetNetname() == net and math.hypot(p.x / 1e6 - x, p.y / 1e6 - y) < 0.1:
            board.Remove(t); removed += 1
refill_and_save(board, PCB)
print("vias removed:", removed)
