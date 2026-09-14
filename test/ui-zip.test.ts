import { describe, expect, it } from "vitest";
import { isSameDirSiteAsset, shouldSkipSiteZipName, siteRefsFromText } from "../ui/zip.js";

describe("site-zip 过滤", () => {
  it("跳过 _qa / webb_* / 下划线目录 / node_modules", () => {
    expect(shouldSkipSiteZipName("_qa")).toBe(true);
    expect(shouldSkipSiteZipName("webb_research")).toBe(true);
    expect(shouldSkipSiteZipName("_hidden")).toBe(true);
    expect(shouldSkipSiteZipName("node_modules")).toBe(true);
    expect(shouldSkipSiteZipName(".git")).toBe(true);
    expect(shouldSkipSiteZipName("css")).toBe(false);
    expect(shouldSkipSiteZipName("index.html")).toBe(false);
  });

  it("同目录站点资产含 css/js，不含 png 调研图", () => {
    expect(isSameDirSiteAsset("style.css")).toBe(true);
    expect(isSameDirSiteAsset("app.js")).toBe(true);
    expect(isSameDirSiteAsset("noise.png")).toBe(false);
  });

  it("抽出相对 href/src/url，忽略协议与锚点", () => {
    expect(siteRefsFromText('<link href="style.css"><img src="https://x/a.png"><a href="#top">')).toEqual([
      "style.css",
    ]);
    expect(siteRefsFromText("body{background:url(./hero.svg)}")).toEqual(["./hero.svg"]);
  });
});
