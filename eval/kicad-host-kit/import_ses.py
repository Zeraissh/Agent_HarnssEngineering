# 导入 SES → 重填铺铜 → 存盘。用法: python import_ses.py <base.kicad_pcb> <in.ses> <out.kicad_pcb>
import sys

import pcbnew

base, ses, out = sys.argv[1], sys.argv[2], sys.argv[3]
board = pcbnew.LoadBoard(base)
ok = pcbnew.ImportSpecctraSES(board, ses)
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(out, board)
b2 = pcbnew.LoadBoard(out)
tr = [t for t in b2.GetTracks() if t.GetClass() == "PCB_TRACK"]
vi = [t for t in b2.GetTracks() if t.GetClass() == "PCB_VIA"]
print("import:", ok, "tracks:", len(tr), "vias:", len(vi))
