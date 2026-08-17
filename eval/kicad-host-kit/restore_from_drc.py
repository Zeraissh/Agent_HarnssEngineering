# 把 DRC 报告的 unconnected_items 对转成 restore.json(端点=报告坐标;Zone 端 → DIVE)
# 用法: python restore_from_drc.py <pcb> <drc.rpt>
import json
import re
import sys

from kit_common import drc_items, restore_path

PCB, RPT = sys.argv[1], sys.argv[2]
restore = []
for kind, items in drc_items(RPT):
    if kind != "unconnected_items" or len(items) != 2:
        continue
    a, b = items
    net = None
    for it in items:
        m = re.search(r"\[([^\]]+)\]", it[2])
        if m:
            net = m.group(1); break
    if "Zone" in b[2]:
        restore.append({"net": net, "len": 99.0, "ends": [[a[0], a[1]], "DIVE"]})
    elif "Zone" in a[2]:
        restore.append({"net": net, "len": 99.0, "ends": [[b[0], b[1]], "DIVE"]})
    else:
        restore.append({"net": net, "len": 99.0, "ends": [[a[0], a[1]], [b[0], b[1]]]})
json.dump(restore, open(restore_path(PCB), "w"))
print("entries:", len(restore))
