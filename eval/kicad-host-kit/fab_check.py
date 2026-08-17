# 工艺校验:板级最小约束 / 网类 / 实物统计(线宽、过孔环宽、丝印线宽字高、最小孔径),对照板厂能力表。用法: python fab_check.py <pcb>
import json
import os
import sys
from collections import Counter

import pcbnew

PCB = sys.argv[1]
board = pcbnew.LoadBoard(PCB)
ds = board.GetDesignSettings()
pro = os.path.splitext(PCB)[0] + ".kicad_pro"
print("== 板级最小约束  (存放在 %s%s)" % (os.path.basename(pro), "" if os.path.exists(pro) else " —— 不存在!读到的是 KiCad 默认值;快照必须连 .kicad_pro 一起拷"))
for name in ("m_MinClearance", "m_TrackMinWidth", "m_ViasMinSize", "m_MinThroughDrill", "m_ViasMinAnnularWidth",
             "m_HoleToHoleMin", "m_CopperEdgeClearance", "m_HoleClearance", "m_SilkClearance", "m_MinSilkTextHeight",
             "m_MinSilkTextThickness", "m_SolderMaskMinWidth"):
    if hasattr(ds, name):
        print("  %-24s %.3f mm" % (name, getattr(ds, name) / 1e6))
try:
    d = ds.m_NetSettings.GetDefaultNetclass()
    print("== 默认网类 clr=%.3f trk=%.3f via=%.2f/%.2f" % (d.GetClearance() / 1e6, d.GetTrackWidth() / 1e6, d.GetViaDiameter() / 1e6, d.GetViaDrill() / 1e6))
except Exception as e:
    print("== 网类读取:", e)
tw, vs, sw, th = Counter(), Counter(), Counter(), Counter()
for t in board.GetTracks():
    if t.GetClass() == "PCB_VIA":
        dd, h = t.GetWidth(pcbnew.F_Cu) / 1e6, t.GetDrillValue() / 1e6
        vs[(round(dd, 2), round(h, 2), round((dd - h) / 2, 3))] += 1
    else:
        tw[round(t.GetWidth() / 1e6, 3)] += 1
for fp in board.GetFootprints():
    for it in fp.GraphicalItems():
        if it.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            try:
                sw[round(it.GetWidth() / 1e6, 3)] += 1
            except Exception:
                pass
    for f in (fp.Reference(), fp.Value()):
        if f.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS) and f.IsVisible():
            th[(round(f.GetTextHeight() / 1e6, 2), round(f.GetTextThickness() / 1e6, 3))] += 1
for d in board.GetDrawings():
    if isinstance(d, pcbnew.PCB_TEXT) and d.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
        th[(round(d.GetTextHeight() / 1e6, 2), round(d.GetTextThickness() / 1e6, 3))] += 1
minhole = min((p.GetDrillSize().x / 1e6 for fp in board.GetFootprints() for p in fp.Pads() if p.GetDrillSize().x > 0), default=None)
print("== 实物统计")
print("  线宽:", dict(tw))
print("  过孔 (外径,孔径,环宽)×数:", dict(vs))
print("  丝印线段线宽×数:", dict(sw))
print("  丝印文字(字高,线宽)×数:", dict(th))
print("  最小 THT 孔径: %s mm" % minhole)
print("== 参照(嘉立创 2 层 1oz,2026-08 官网): 线宽/距 ≥0.10;过孔 0.3 孔+≥0.45 外径标准价;PTH 环 ≥0.20;"
      "过孔孔距 0.20/焊盘孔距 0.45;铜到边 ≥0.20;丝印线 ≥0.15、字高 ≥1.0;阻焊桥 ≥0.10")
