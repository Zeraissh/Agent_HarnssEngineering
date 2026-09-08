/**
 * SAFE-05 / WSL2 — Windows ↔ WSL 路径映射（判据④）。
 *
 * Docker-in-WSL 的 bind mount 必须用 Linux 路径；宿主 Node 仍用 Windows 路径做
 * 文件 I/O。两套坐标系之间的转换必须与「使用语义」一致：UNC、相对路径、
 * 盘符残缺、以及把 `/mnt/d/...` 误当 Windows 路径，一律 fail-closed。
 */
import path from "node:path";

const DRIVE_ABS = /^([A-Za-z]):[\\/](.*)$/;
const MNT_ABS = /^\/mnt\/([a-z])\/(.*)$/;
const WSL_UNC = /^\\\\wsl\$\\([^\\]+)[\\/](.*)$/i;

export function isWindowsAbsolutePath(value: string): boolean {
  const normalized = path.win32.normalize(value.trim());
  return DRIVE_ABS.test(normalized) || WSL_UNC.test(normalized);
}

/** 规范化后的 Windows 绝对路径 → WSL 路径（盘符 → `/mnt/<drive>/…`，或 `\\wsl$\Distro\…`）。 */
export function windowsPathToWsl(windowsPath: string): string {
  const raw = windowsPath.trim();
  if (!raw) throw new Error("WSL path mapping rejected empty path");
  if (raw.includes("\0") || /[\r\n]/.test(raw)) {
    throw new Error("WSL path mapping rejected control characters in path");
  }
  if (MNT_ABS.test(raw.replace(/\\/g, "/"))) {
    throw new Error("WSL path mapping rejected Linux path where a Windows path was required");
  }
  const normalized = path.win32.normalize(raw);
  const unc = WSL_UNC.exec(normalized);
  if (unc) {
    const rest = (unc[2] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    return rest ? `/${rest}` : "/";
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    throw new Error("WSL path mapping rejected UNC path; bind mounts require a drive letter or \\\\wsl$\\Distro\\…");
  }
  const match = DRIVE_ABS.exec(normalized);
  if (!match) {
    throw new Error(
      `WSL path mapping requires a Windows drive-absolute path; got: ${windowsPath}`,
    );
  }
  const drive = match[1]!.toLowerCase();
  const rest = (match[2] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/** WSL `/mnt/<drive>/...` → Windows `D:\...`。只接受 /mnt 形态，不猜其它挂载点。 */
export function wslPathToWindows(wslPath: string): string {
  const raw = wslPath.trim();
  if (!raw) throw new Error("Windows path mapping rejected empty path");
  if (raw.includes("\0") || /[\r\n]/.test(raw)) {
    throw new Error("Windows path mapping rejected control characters in path");
  }
  if (DRIVE_ABS.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error("Windows path mapping rejected Windows path where a WSL path was required");
  }
  if (raw.startsWith("//wsl") || raw.startsWith("\\\\wsl")) {
    throw new Error("Windows path mapping rejected \\\\wsl$ UNC; use /mnt/<drive>/...");
  }
  const posix = raw.replace(/\\/g, "/");
  const match = MNT_ABS.exec(posix);
  if (!match) {
    throw new Error(
      `Windows path mapping requires /mnt/<drive>/...; got: ${wslPath}`,
    );
  }
  const drive = match[1]!.toUpperCase();
  const rest = (match[2] ?? "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

/** 供 Docker bind `source=`：本机是 Windows 时转 WSL，否则原样 resolve。 */
export function dockerBindSource(workdir: string, viaWsl: boolean): string {
  const resolved = path.resolve(workdir);
  if (/[\r\n,]/.test(resolved)) {
    throw new Error("OCI workdir cannot contain comma or newline characters");
  }
  return viaWsl ? windowsPathToWsl(resolved) : resolved;
}
