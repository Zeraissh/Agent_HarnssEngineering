# 排针引脚丝印标注(蓝药丸式)+ 板名。标注表来自 JSON:
#   {"labels":[{"text":"PA0","x":9.76,"y":36.4,"rot":90,"h":"L"}, ...],
#    "texts":[{"text":"L151-DEV v1","x":6,"y":8.5,"rot":0,"h":"L","size":1.2,"width":1.0,"thick":0.18}]}
# 幂等:先删同名(在表内)的板级 F.SilkS 文本再写。用法: python silk_labels.py <pcb> <labels.json>
import json
import sys

import pcbnew

from kit_common import MM

PCB, SPEC = sys.argv[1], sys.argv[2]
spec = json.load(open(SPEC, encoding="utf-8"))
board = pcbnew.LoadBoard(PCB)
names = {e["text"] for e in spec.get("labels", [])} | {e["text"] for e in spec.get("texts", [])}
for d in list(board.GetDrawings()):
    if isinstance(d, pcbnew.PCB_TEXT) and d.GetLayer() == pcbnew.F_SilkS and d.GetText() in names:
        board.Remove(d)
H = {"L": pcbnew.GR_TEXT_H_ALIGN_LEFT, "R": pcbnew.GR_TEXT_H_ALIGN_RIGHT, "C": pcbnew.GR_TEXT_H_ALIGN_CENTER}
n = 0
for e in spec.get("labels", []) + spec.get("texts", []):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(e["text"])
    t.SetLayer(pcbnew.F_SilkS)
    t.SetPosition(pcbnew.VECTOR2I(MM(e["x"]), MM(e["y"])))
    t.SetTextSize(pcbnew.VECTOR2I(MM(e.get("width", 0.85)), MM(e.get("size", 1.0))))
    t.SetTextThickness(MM(e.get("thick", 0.15)))
    t.SetTextAngleDegrees(e.get("rot", 0))
    t.SetHorizJustify(H[e.get("h", "L")])
    t.SetVertJustify(pcbnew.GR_TEXT_V_ALIGN_CENTER)
    board.Add(t); n += 1
pcbnew.SaveBoard(PCB, board)
print("labels written:", n)
