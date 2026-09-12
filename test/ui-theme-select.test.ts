// @vitest-environment jsdom
/**
 * 自绘下拉：Windows 原生 <select> 弹出层不吃主题，暗色会白底浅字。
 * 守的是「看得见的列表必须用 --surface / --text」，以及升级后事实源仍是 select。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initThemeSelect, upgradeSelects } from "../ui/public/features/theme-select.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("initThemeSelect", () => {
  it("隐藏原生 select，点选项改 value 并冒泡 change", () => {
    document.body.innerHTML = `
      <label id="pack-lab">领域包</label>
      <select id="pack" aria-labelledby="pack-lab">
        <option value="">不用</option>
        <option value="kicad">kicad</option>
      </select>`;
    const select = document.querySelector("#pack") as HTMLSelectElement;
    const changed: string[] = [];
    select.addEventListener("change", () => changed.push(select.value));
    initThemeSelect(select);
    expect(select.classList.contains("sr-only")).toBe(true);
    expect(select.getAttribute("aria-hidden")).toBe("true");
    const trigger = document.querySelector(".theme-select-trigger") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-labelledby")).toBe("pack-lab");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(trigger.textContent).toContain("不用");
    trigger.click();
    expect(trigger.getAttribute("aria-controls")).toBe("pack-menu");
    const opt = [...document.querySelectorAll(".theme-select-option")]
      .find((el) => el.textContent === "kicad");
    expect(opt, "菜单里要有 kicad").toBeTruthy();
    (opt as HTMLElement).click();
    expect(select.value).toBe("kicad");
    expect(changed).toEqual(["kicad"]);
    expect((document.querySelector(".theme-select-menu") as HTMLElement).hidden).toBe(true);
    expect(trigger.textContent).toContain("kicad");
  });

  it("已是 sr-only + aria-hidden 的不升级（workdir / 模型事实源）", () => {
    document.body.innerHTML = `<select id="wd" class="sr-only" tabindex="-1" aria-hidden="true"></select>`;
    expect(initThemeSelect(document.querySelector("#wd"))).toBeNull();
    expect(document.querySelector(".theme-select")).toBeNull();
  });

  it("upgradeSelects 跳过已隐藏的，只包还露着的", () => {
    document.body.innerHTML = `
      <select id="a"><option>一</option></select>
      <select id="b" class="sr-only" tabindex="-1" aria-hidden="true"><option>二</option></select>`;
    const apis = upgradeSelects(document);
    expect(apis).toHaveLength(1);
    expect(document.querySelector("#a")?.closest(".theme-select")).toBeTruthy();
    expect(document.querySelector("#b")?.closest(".theme-select")).toBeNull();
  });
});

describe("防再犯：可见下拉必须自绘", () => {
  it("菜单底和字用语义令牌，不给原生 select 上主题色", () => {
    const css = readFileSync(join(root, "ui/public/styles.css"), "utf-8");
    expect(css).toMatch(/\.theme-select-menu\s*\{[^}]*background:\s*var\(--surface-0\)/);
    expect(css).toMatch(/\.theme-select-menu\s*\{[^}]*color:\s*var\(--text-1\)/);
    expect(css).toMatch(/\.theme-select-option\s*\{[^}]*color:\s*var\(--text-1\)/);
    const painted: string[] = [];
    for (const m of css.matchAll(/([^{}@][^{}]*)\{([^}]*)\}/g)) {
      const sel = (m[1] ?? "").replace(/\s+/g, " ").trim();
      if (!/(^|[\s,])select([\s,:]|$)/.test(sel)) continue;
      if (/color:\s*var\(--(?:text|fg)/.test(m[2] ?? "")) painted.push(sel);
    }
    expect(painted, `原生 select 上了主题色，Windows 弹出层会白底浅字：${painted.join(" | ")}`).toEqual([]);
  });

  it("骨架、设置、定时任务都会走 upgradeSelects", () => {
    const html = readFileSync(join(root, "ui/public/index.html"), "utf-8");
    const settings = readFileSync(join(root, "ui/public/features/settings.js"), "utf-8");
    const schedules = readFileSync(join(root, "ui/public/features/schedules.js"), "utf-8");
    expect(html).toContain('from "/features/theme-select.js"');
    expect(html).toContain("upgradeSelects(document)");
    expect(settings).toContain('from "./theme-select.js"');
    expect(settings).toContain("upgradeSelects(view)");
    expect(schedules).toContain('from "./theme-select.js"');
    expect(schedules).toContain("upgradeSelects(view)");
  });

  it("暗色主题声明 color-scheme: dark，避免系统控件仍按浅色画", () => {
    const css = readFileSync(join(root, "ui/public/styles.css"), "utf-8");
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
    expect(css).toMatch(/\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/\[data-theme="graphite"\]\s*\{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/\[data-theme="contrast"\]\s*\{[^}]*color-scheme:\s*dark/);
  });
});
