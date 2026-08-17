# 定点返工路由:恢复 restore.json 里的连接(顶层优先,B 步代价 ×b_cost),纯计算 → actions.json
# 用法: python route_repair.py <pcb> [b_cost=4.0] [--deep]
# restore.json: [{"net":..,"len":..,"ends":[[x,y],[x,y]|"DIVE"]}, ...]  (DIVE=下潜入主 GND 池打针)
import json
import math
import sys

import pcbnew

from kit_common import (HALF, World, actions_path, astar, fine_verify, main_pour_tester, restore_path, simplify)

PCB = sys.argv[1]
B_COST = float(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else 4.0
IT = 1400000 if "--deep" in sys.argv else 350000
board = pcbnew.LoadBoard(PCB)
world = World(board)
in_main = main_pour_tester(board)
restore = json.load(open(restore_path(PCB)))
restore.sort(key=lambda r: -r.get("len", 0))
actions, bad = [], []
for r in restore:
    net, ends = r["net"], r["ends"]
    a = tuple(ends[0])
    routed = 0
    for e in ends[1:]:
        tgt = "DIVE" if e == "DIVE" else tuple(e)
        path = astar(world, a, tgt, net, HALF, B_COST, 60000 if tgt == "DIVE" else IT, in_main)
        if path is None:
            bad.append("%s %s->%s" % (net, a, e)); continue
        pts = simplify(path)
        full = [(a[0], a[1], "F")] + pts + ([] if tgt == "DIVE" else [(e[0], e[1], "F")])
        if not fine_verify(world, full, net):
            bad.append("%s %s->%s (verify)" % (net, a, e)); continue
        actions.append({"net": net, "pts": [[q[0], q[1], q[2]] for q in full]})
        world.register(full, net)
        routed += 1
    bl = sum(math.hypot(q2[0] - q1[0], q2[1] - q1[1]) for act in actions if act["net"] == net
             for q1, q2 in zip(act["pts"], act["pts"][1:]) if q1[2] == "B" and q2[2] == "B")
    print("%-9s restored %d/%d  new B length %.1fmm" % (net, routed, len(ends) - 1, bl))
    sys.stdout.flush()
json.dump(actions, open(actions_path(PCB), "w"))
print("actions:", len(actions), "| failed:", bad)
