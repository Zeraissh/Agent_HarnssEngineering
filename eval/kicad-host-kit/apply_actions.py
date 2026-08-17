# 独立进程落板:读 actions.json → 轨迹+via → 重填铺铜 → 存盘。用法: python apply_actions.py <pcb> [actions.json]
import json
import sys

import pcbnew

from kit_common import actions_path, apply_actions, refill_and_save

PCB = sys.argv[1]
ACT = sys.argv[2] if len(sys.argv) > 2 else actions_path(PCB)
board = pcbnew.LoadBoard(PCB)
n_tr, n_via = apply_actions(board, json.load(open(ACT)))
refill_and_save(board, PCB)
print("applied tracks:", n_tr, "vias:", n_via)
