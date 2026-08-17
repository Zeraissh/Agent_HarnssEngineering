# 拆掉指定网的全部走线与 via。用法: python rip_net.py <pcb> NET1,NET2
import sys

import pcbnew

PCB = sys.argv[1]
NETS = set(sys.argv[2].split(","))
board = pcbnew.LoadBoard(PCB)
victims = [t for t in board.GetTracks() if t.GetNetname() in NETS]
for t in victims:
    board.Remove(t)
pcbnew.SaveBoard(PCB, board)
print("ripped items:", len(victims), "nets:", sorted(NETS))
