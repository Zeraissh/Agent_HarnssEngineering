# 导出 Specctra DSN(供 freerouting)。用法: python export_dsn.py <pcb> [out.dsn]
# 导出内容:GND 铺铜 → (plane GND ...);规则区 → wire_keepout;网类线宽/间距 → rule。
# 不要在 DSN 里手工注入 autoroute_settings(层代价等):headless 下会导致 0 网可布(案例 #11 实测)。
import os
import sys

import pcbnew

PCB = sys.argv[1]
DSN = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(PCB)[0] + ".dsn"
board = pcbnew.LoadBoard(PCB)
ok = pcbnew.ExportSpecctraDSN(board, DSN)
print("DSN export:", ok, DSN)
