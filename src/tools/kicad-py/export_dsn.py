# kicad_autoroute step 1: export Specctra DSN from a .kicad_pcb via KiCad's bundled python (pcbnew).
# usage: export_dsn.py <pcb> <dsn>
import sys

import pcbnew

pcb, dsn = sys.argv[1], sys.argv[2]
board = pcbnew.LoadBoard(pcb)
if board is None:
    print("ERROR: board failed to load"); sys.exit(2)
ok = pcbnew.ExportSpecctraDSN(board, dsn)
print("dsn_export_ok=%s" % bool(ok))
sys.exit(0 if ok else 3)
