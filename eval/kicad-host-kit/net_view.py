# 网络高亮示意图(宿主看图用):自绘 SVG——焊盘灰、F 走线淡红、B 走线淡蓝、via 灰圈;--net 指定的网加粗高亮
# (F 红 / B 蓝 / via 黑),铺铜孤岛轮廓可选叠加。输出 SVG 以 mm 为单位(viewBox=板框),可直接用 zoom.mjs 裁区放大。
# 用法: python net_view.py <pcb> <out.svg> [--net NRST,+3V3] [--box x0,y0,x1,y1] [--islands]
import sys

import pcbnew

PCB, OUT = sys.argv[1], sys.argv[2]
NETS, BOX, ISL = set(), None, False
for i, a in enumerate(sys.argv):
    if a == "--net":
        NETS = set(sys.argv[i + 1].split(","))
    if a == "--box":
        BOX = [float(v) for v in sys.argv[i + 1].split(",")]
    if a == "--islands":
        ISL = True
board = pcbnew.LoadBoard(PCB)
eb = board.GetBoardEdgesBoundingBox()
if BOX is None:
    BOX = [eb.GetLeft() / 1e6, eb.GetTop() / 1e6, eb.GetRight() / 1e6, eb.GetBottom() / 1e6]
x0, y0, x1, y1 = BOX
W, H = x1 - x0, y1 - y0
out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.2fmm" height="%.2fmm" viewBox="%.3f %.3f %.3f %.3f">' % (W, H, x0, y0, W, H),
       '<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="white"/>' % (x0, y0, W, H)]
if ISL:
    for z in board.Zones():
        if z.GetIsRuleArea():
            continue
        poly = z.GetFilledPolysList(z.GetLayer())
        for k in range(poly.OutlineCount()):
            o = poly.Outline(k)
            pts = " ".join("%.3f,%.3f" % (o.CPoint(j).x / 1e6, o.CPoint(j).y / 1e6) for j in range(o.PointCount()))
            out.append('<polygon points="%s" fill="#dbe9ff" stroke="#7fa8e0" stroke-width="0.05"/>' % pts)
for fp in board.GetFootprints():
    for pad in fp.Pads():
        p = pad.GetPosition(); sz = pad.GetSize(pcbnew.F_Cu)
        w, h = sz.x / 1e6, sz.y / 1e6
        if int(round(pad.GetOrientationDegrees())) % 180 in (90, -90):
            w, h = h, w
        hl = pad.GetNetname() in NETS
        out.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="%s" stroke="%s" stroke-width="0.03"/>' % (
            p.x / 1e6 - w / 2, p.y / 1e6 - h / 2, w, h, "#ffd27f" if hl else "#c8c8c8", "#b06000" if hl else "#909090"))
    r = fp.Reference(); rp = r.GetPosition()
    out.append('<text x="%.3f" y="%.3f" font-size="0.9" fill="#777" font-family="sans-serif">%s</text>' % (rp.x / 1e6, rp.y / 1e6, fp.GetReference()))
# 走线:先画非高亮,再画高亮
for pass_hl in (False, True):
    for t in board.GetTracks():
        hl = t.GetNetname() in NETS
        if hl != pass_hl:
            continue
        if t.GetClass() == "PCB_VIA":
            p = t.GetPosition()
            out.append('<circle cx="%.3f" cy="%.3f" r="%.3f" fill="%s" stroke="%s" stroke-width="0.05"/>' % (
                p.x / 1e6, p.y / 1e6, t.GetWidth(pcbnew.F_Cu) / 2e6, "#222" if hl else "#eee", "#000" if hl else "#999"))
        else:
            s, e = t.GetStart(), t.GetEnd()
            isB = t.GetLayer() == pcbnew.B_Cu
            col = ("#0040ff" if isB else "#e00000") if hl else ("#b8c8f0" if isB else "#f0b8b8")
            out.append('<line x1="%.3f" y1="%.3f" x2="%.3f" y2="%.3f" stroke="%s" stroke-width="%.3f" stroke-linecap="round" opacity="%s"/>' % (
                s.x / 1e6, s.y / 1e6, e.x / 1e6, e.y / 1e6, col, t.GetWidth() / 1e6, "1" if hl else "0.9"))
out.append("</svg>")
open(OUT, "w", encoding="utf-8").write("\n".join(out))
print("wrote", OUT, "box", BOX, "nets", sorted(NETS))
