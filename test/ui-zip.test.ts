import { describe, expect, it } from "vitest";
import { buildStoreZip, zipEntryName } from "../ui/zip.js";

describe("buildStoreZip", () => {
  it("打出可读的 store ZIP，拒绝 ..", () => {
    expect(() => zipEntryName("../x")).toThrow();
    const zip = buildStoreZip([
      { name: "index.html", data: Buffer.from("<h1>hi</h1>", "utf8") },
      { name: "a/style.css", data: Buffer.from("body{}", "utf8") },
    ]);
    expect(zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(zip.includes(Buffer.from("index.html", "utf8"))).toBe(true);
    expect(zip.includes(Buffer.from("<h1>hi</h1>", "utf8"))).toBe(true);
    expect(zip.includes(Buffer.from("a/style.css", "utf8"))).toBe(true);
  });
});
