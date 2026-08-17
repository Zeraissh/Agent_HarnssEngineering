# 写 restore.json。用法: python add_restore.py <pcb> [--append] NET:REF-PIN:REF-PIN | NET:REF-PIN:DIVE | NET:x,y:x,y
import json
import sys

import pcbnew

from kit_common import pad_map, restore_path

PCB = sys.argv[1]
board = pcbnew.LoadBoard(PCB)
pads, _ = pad_map(board)
restore = []
if "--append" in sys.argv:
    try:
        restore = json.load(open(restore_path(PCB)))
    except Exception:
        restore = []


def pt(tok):
    if "," in tok:
        x, y = tok.split(","); return [float(x), float(y)]
    r, pn = tok.split("-"); return list(pads[(r, pn)][:2])


for spec in sys.argv[2:]:
    if spec.startswith("--"):
        continue
    net, a, b = spec.split(":")
    ea = pt(a)
    eb = "DIVE" if b == "DIVE" else pt(b)
    restore.append({"net": net, "len": 99.0, "ends": [ea, eb]})
    print("added", net, ea, "->", eb)
json.dump(restore, open(restore_path(PCB), "w"))
print("restore entries:", len(restore))
