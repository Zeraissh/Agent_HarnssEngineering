import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
const args = npmCli
  ? [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const result = spawnSync(command, args, { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout)[0];
const paths = report.files.map((entry) => String(entry.path).replaceAll("\\", "/"));
const forbidden = paths.filter((path) =>
  path !== "package.json" &&
  path !== "README.md" &&
  !path.startsWith("dist/"),
);
if (forbidden.length > 0) {
  throw new Error(`Release package contains non-allowlisted files:\n${forbidden.join("\n")}`);
}
for (const required of ["dist/ui/serve.js", "dist/ui/server.js", "dist/ui/public/index.html"]) {
  if (!paths.includes(required)) throw new Error(`Release package is missing ${required}`);
}
if (Number(report.unpackedSize) > 8 * 1024 * 1024) {
  throw new Error(`Release package unexpectedly exceeds 8 MiB unpacked: ${report.unpackedSize}`);
}
console.log(`Pack audit passed: ${paths.length} files, ${report.unpackedSize} bytes unpacked`);
