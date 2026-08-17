# 案例 #11 开发板版 PCB 重建(示例):官方库封装 + 基线网表(42 网)+ 摆位表 → 空板 + 板框 + 网类
# 这是"宿主 pcbnew 重建管线"的范本:执行者改 8000 行文件会写坏,宿主用结构化 API 从网表重建永远干净。
# 用法: python case11_build_devboard.py <baseline.net> <out.kicad_pcb> [libroot]
# 摆位 = 最终交付版(v6-DEVBOARD-JLC-drc0):SW1/C7/D1/R1 为丝印让道后的位置。
import re
import sys

import pcbnew

NETLIST, OUT = sys.argv[1], sys.argv[2]
LIBROOT = sys.argv[3] if len(sys.argv) > 3 else r"D:\KiCad\share\kicad\footprints"
EXPECT_NETS = 42

PARTS = {  # ref: (lib, footprint, x, y, rot, value)
    "U1": ("Package_QFP", "LQFP-48_7x7mm_P0.5mm", 25, 20, 0, "STM32L151CCT6"),
    "C1": ("Capacitor_SMD", "C_0603_1608Metric", 28, 27.6, 90, "100nF"),
    "C2": ("Capacitor_SMD", "C_0603_1608Metric", 31.8, 17.5, 90, "100nF"),
    "C3": ("Capacitor_SMD", "C_0603_1608Metric", 22.5, 14, 0, "100nF"),
    "C4": ("Capacitor_SMD", "C_0603_1608Metric", 18.6, 13.6, 90, "100nF"),
    "C5": ("Capacitor_SMD", "C_0603_1608Metric", 28, 30.9, 90, "1uF"),
    "C6": ("Capacitor_SMD", "C_0603_1608Metric", 16.4, 13.0, 90, "100nF"),
    "C7": ("Capacitor_SMD", "C_0603_1608Metric", 40.8, 15.6, 0, "4.7uF"),
    "C8": ("Capacitor_SMD", "C_0603_1608Metric", 26, 8, 0, "100nF"),
    "C9": ("Capacitor_SMD", "C_0603_1608Metric", 8.5, 20.5, 90, "18pF"),
    "C10": ("Capacitor_SMD", "C_0603_1608Metric", 17.4, 19.5, 90, "18pF"),
    "C11": ("Capacitor_SMD", "C_0603_1608Metric", 8, 17, 90, "12pF"),
    "C12": ("Capacitor_SMD", "C_0603_1608Metric", 16.4, 16.1, 90, "12pF"),
    "Y1": ("Crystal", "Crystal_SMD_5032-2Pin_5.0x3.2mm", 13, 20.5, 0, "8MHz"),
    "Y2": ("Crystal", "Crystal_SMD_3215-2Pin_3.2x1.5mm", 13, 17, 0, "32.768kHz"),
    "D1": ("LED_SMD", "LED_0603_1608Metric", 43, 28.9, 90, "LED"),
    "R1": ("Resistor_SMD", "R_0603_1608Metric", 43, 31.9, 90, "330"),
    "J1": ("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical", 9.5, 24.5, 90, "BOOT0"),
    "J2": ("Connector_PinHeader_2.54mm", "PinHeader_1x05_P2.54mm_Vertical", 47.46, 15, 0, "SWD"),
    "SW1": ("Button_Switch_SMD", "SW_SPST_TL3342", 41.3, 11.0, 0, "NRST"),
    "J3": ("Connector_PinHeader_2.54mm", "PinHeader_1x19_P2.54mm_Vertical", 2.14, 38.1, 90, "UP"),
    "J4": ("Connector_PinHeader_2.54mm", "PinHeader_1x19_P2.54mm_Vertical", 47.86, 2.54, 270, "DOWN"),
}
BOARD_MM = (50, 40)

text = open(NETLIST, encoding="utf-8").read()
pin2net, netnames = {}, []
for m in re.finditer(r'\(net\s+\(code "\d+"\)\s+\(name "([^"]+)"\)(.*?)(?=\(net\s+\(code|\Z)', text, re.S):
    name = m.group(1)
    if name == "/":
        continue
    netnames.append(name)
    for node in re.finditer(r'\(node\s+\(ref "([^"]+)"\)\s+\(pin "([^"]+)"\)', m.group(2)):
        pin2net[(node.group(1), node.group(2))] = name
print("nets:", len(netnames), "pin-bindings:", len(pin2net))
if len(netnames) != EXPECT_NETS:
    print("FATAL: expected %d nets, got %d" % (EXPECT_NETS, len(netnames))); sys.exit(1)

board = pcbnew.CreateEmptyBoard()
netinfo = {}
for name in sorted(netnames):
    ni = pcbnew.NETINFO_ITEM(board, name)
    board.Add(ni)
    netinfo[name] = ni

unbound = []
for ref, (lib, fpname, x, y, rot, value) in PARTS.items():
    fp = pcbnew.FootprintLoad(LIBROOT + "\\" + lib + ".pretty", fpname)
    if fp is None:
        print("FATAL: footprint load failed:", lib, fpname); sys.exit(1)
    fp.SetFPID(pcbnew.LIB_ID(lib, fpname))
    fp.SetReference(ref)
    fp.SetValue(value)
    fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y)))
    fp.SetOrientationDegrees(rot)
    board.Add(fp)
    for pad in fp.Pads():
        key = (ref, str(pad.GetNumber()))
        if key in pin2net:
            pad.SetNet(netinfo[pin2net[key]])
        elif str(pad.GetNumber()):
            unbound.append(key)
print("unbound pads:", unbound)


def edge(x1, y1, x2, y2):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(x1), pcbnew.FromMM(y1)))
    s.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(x2), pcbnew.FromMM(y2)))
    s.SetLayer(pcbnew.Edge_Cuts)
    s.SetWidth(pcbnew.FromMM(0.1))
    board.Add(s)


W, H = BOARD_MM
edge(0, 0, W, 0); edge(W, 0, W, H); edge(W, H, 0, H); edge(0, H, 0, 0)

ds = board.GetDesignSettings()
nc = ds.m_NetSettings.GetDefaultNetclass()
nc.SetClearance(pcbnew.FromMM(0.2))
nc.SetTrackWidth(pcbnew.FromMM(0.25))
nc.SetViaDiameter(pcbnew.FromMM(0.6))
nc.SetViaDrill(pcbnew.FromMM(0.3))
pcbnew.SaveBoard(OUT, board)
b2 = pcbnew.LoadBoard(OUT)
print("reload:", "OK" if b2 else "FAILED", "| footprints:", len(b2.GetFootprints()), "| nets:", b2.GetNetCount())
