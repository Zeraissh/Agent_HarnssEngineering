# 铺铜孤岛:数量/面积/位置(校准:量产 WR350 底层 GND 单一轮廓;AT 主块 + 1.8mm² 碎片)。用法: python islands.py <pcb>
import sys

import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
for z in board.Zones():
    if z.GetIsRuleArea():
        continue
    for lay in (pcbnew.B_Cu, pcbnew.F_Cu):
        if not z.IsOnLayer(lay):
            continue
        polys = z.GetFilledPolysList(lay)
        info = []
        for i in range(polys.OutlineCount()):
            o = polys.Outline(i)
            bb = o.BBox()
            info.append((abs(o.Area()) / 1e12, bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6))
        info.sort(reverse=True)
        print("zone %s layer %s: outlines=%d" % (z.GetNetname(), board.GetLayerName(lay), polys.OutlineCount()))
        for a, x0, y0, x1, y1 in info[:10]:
            print("   %8.1f mm2  bbox=(%.1f,%.1f)-(%.1f,%.1f)" % (a, x0, y0, x1, y1))
