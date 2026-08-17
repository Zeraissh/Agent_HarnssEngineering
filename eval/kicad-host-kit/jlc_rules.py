# 嘉立创口径:板级最小约束 + 丝印线宽 ≥0.15(含库件线段——对"嵌入库件冻结"的有意例外,只动线宽) + 丝印文字字高 1.0/线 0.15 + 阻焊桥 0.10
# 用法: python jlc_rules.py <pcb> [--clearance 0.152] [--no-lib-silk]
import sys

import pcbnew

from kit_common import MM

PCB = sys.argv[1]
CLR = 0.152
for i, a in enumerate(sys.argv):
    if a == "--clearance":
        CLR = float(sys.argv[i + 1])
LIB_SILK = "--no-lib-silk" not in sys.argv
board = pcbnew.LoadBoard(PCB)
ds = board.GetDesignSettings()
ds.m_MinClearance = MM(CLR)
ds.m_TrackMinWidth = MM(CLR)
ds.m_ViasMinSize = MM(0.5)
ds.m_MinThroughDrill = MM(0.3)
ds.m_ViasMinAnnularWidth = MM(0.075)
ds.m_HoleToHoleMin = MM(0.25)
ds.m_CopperEdgeClearance = MM(0.3)
ds.m_HoleClearance = MM(0.25)
ds.m_MinSilkTextHeight = MM(1.0)
ds.m_MinSilkTextThickness = MM(0.15)
if hasattr(ds, "m_SolderMaskMinWidth"):
    ds.m_SolderMaskMinWidth = MM(0.10)
n_lines = n_txt = 0
for fp in board.GetFootprints():
    if LIB_SILK:
        for it in fp.GraphicalItems():
            if it.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
                try:
                    if it.GetWidth() < MM(0.15):
                        it.SetWidth(MM(0.15)); n_lines += 1
                except Exception:
                    pass
    for f in (fp.Reference(), fp.Value()):
        if f.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            if f.GetTextHeight() < MM(1.0):
                f.SetTextSize(pcbnew.VECTOR2I(MM(0.85), MM(1.0))); n_txt += 1
            if f.GetTextThickness() < MM(0.15):
                f.SetTextThickness(MM(0.15))
for d in board.GetDrawings():
    if isinstance(d, pcbnew.PCB_TEXT) and d.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
        if d.GetTextHeight() < MM(1.0):
            d.SetTextSize(pcbnew.VECTOR2I(MM(0.85), MM(1.0))); n_txt += 1
        if d.GetTextThickness() < MM(0.15):
            d.SetTextThickness(MM(0.15))
pcbnew.SaveBoard(PCB, board)
print("JLC rules set; silk lines widened:", n_lines, "| texts resized:", n_txt)
