# kicad_autoroute step 3: import the freerouting session (SES) into the board, refill zones, save in place.
# usage: import_ses.py <pcb> <ses>
import sys

import pcbnew

pcb, ses = sys.argv[1], sys.argv[2]
board = pcbnew.LoadBoard(pcb)
if board is None:
    print("ERROR: board failed to load"); sys.exit(2)
ok = pcbnew.ImportSpecctraSES(board, ses)
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(pcb, board)
b2 = pcbnew.LoadBoard(pcb)
tracks = [t for t in b2.GetTracks() if t.GetClass() == "PCB_TRACK"]
vias = [t for t in b2.GetTracks() if t.GetClass() == "PCB_VIA"]
print("ses_import_ok=%s tracks=%d vias=%d" % (bool(ok), len(tracks), len(vias)))
sys.exit(0 if ok else 3)
