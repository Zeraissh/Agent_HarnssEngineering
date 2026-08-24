import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "ui", "public");
const target = resolve(root, "dist", "ui", "public");
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
