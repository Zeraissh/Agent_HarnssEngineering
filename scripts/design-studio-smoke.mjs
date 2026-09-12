/**
 * 设计台冒烟：用 templates/design/deck-basic 起宿主，验 site / ZIP / print / deck 注入。
 * 用法：npx tsx scripts/design-studio-smoke.mjs
 */
import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../ui/server.ts";
import { FakeModelClient } from "../test/helpers.ts";
import { fakeMessage, textBlock } from "../test/helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = join(root, "templates", "design", "deck-basic");

const dir = await mkdtemp(join(tmpdir(), "design-smoke-"));
await cp(template, join(dir, "deck"), { recursive: true });

const handle = createUiServer({
  modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
  workdir: dir,
});
await new Promise((resolve, reject) => {
  handle.server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
});
const { port } = handle.server.address();
const base = `http://127.0.0.1:${port}`;

try {
  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "smoke", pack: "design" }),
  });
  if (!created.ok) throw new Error(`create run ${created.status}`);
  const { runId } = await created.json();

  const html = await (await fetch(`${base}/api/runs/${runId}/site/deck/index.html?deck=1`)).text();
  if (!html.includes("agent-deck-ready")) throw new Error("missing deck runtime");
  if (!html.includes('data-slide="1"')) throw new Error("missing slides");

  const inspect = await (await fetch(`${base}/api/runs/${runId}/site/deck/index.html?inspect=1`)).text();
  if (!inspect.includes("agent-inspect-pick")) throw new Error("missing inspect hook");

  const print = await (await fetch(`${base}/api/runs/${runId}/site/deck/index.html?print=1`)).text();
  if (!print.includes("window.print")) throw new Error("missing print hook");

  const zipRes = await fetch(`${base}/api/runs/${runId}/site-zip?path=deck%2Findex.html`);
  if (!zipRes.ok) throw new Error(`zip ${zipRes.status}`);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  if (zip.subarray(0, 2).toString("utf8") !== "PK") throw new Error("not a zip");
  if (!zip.includes(Buffer.from("style.css"))) throw new Error("zip missing style.css");

  const templates = await (await fetch(`${base}/api/design-templates`)).json();
  if (!templates.templates?.some((t) => t.id === "deck-basic")) {
    throw new Error("design-templates missing deck-basic");
  }

  const seed = await fetch(`${base}/api/runs/${runId}/seed-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: "landing-basic", dest: "landing-smoke" }),
  });
  if (!seed.ok) throw new Error(`seed ${seed.status}`);
  const seeded = await seed.json();
  if (seeded.entry !== "landing-smoke/index.html") throw new Error("bad seed entry");

  const md = await (await fetch(`${base}/api/runs/${runId}/design-md`)).json();
  if (!md.found || !md.palette?.colors?.length) throw new Error("design-md palette missing");

  // 对照模板源仍在磁盘
  const src = await readFile(join(dir, "deck", "index.html"), "utf8");
  if (!src.includes("class=\"slide\"")) throw new Error("workdir template broken");

  console.log("design-studio-smoke OK", {
    runId,
    zipBytes: zip.length,
    seeded: seeded.dest,
    colors: md.palette.colors.length,
  });
} finally {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
}
