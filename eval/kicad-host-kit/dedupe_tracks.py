# 去重:删除完全重复的走线段(同层同网同端点,方向不论)与同位重复 via;重填铺铜存盘。
# 用法: python dedupe_tracks.py <pcb> [--dry]
import sys

import pcbnew

PCB = sys.argv[1]
DRY = "--dry" in sys.argv
board = pcbnew.LoadBoard(PCB)


def key(p):
    return (round(p.x / 1e6, 3), round(p.y / 1e6, 3))


seen, victims = set(), []
for t in board.GetTracks():
    if t.GetClass() == "PCB_VIA":
        k = ("V", t.GetNetname(), key(t.GetPosition()))
    else:
        a, b = key(t.GetStart()), key(t.GetEnd())
        k = ("T", t.GetNetname(), t.GetLayer(), min(a, b), max(a, b))
    if k in seen:
        victims.append((k, t))
    else:
        seen.add(k)
for k, t in victims:
    print("dup:", k)
if not DRY:
    for _, t in victims:
        board.Remove(t)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(PCB, board)
print("duplicates %s: %d" % ("found" if DRY else "removed", len(victims)))
