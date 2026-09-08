import { describe, expect, it } from "vitest";
import { clipTitle, sanitizeGeneratedTitle, summarizeTitle } from "../ui/title.js";

describe("summarizeTitle", () => {
  it("长任务截到可扫视长度", () => {
    const t = summarizeTitle("你好 今天广东省佛山市南海区的天气怎么样 适合去哪些地方玩啊?");
    expect(t.length).toBeLessThanOrEqual(25);
    expect(t.startsWith("你好")).toBe(true);
  });

  it("只有附件时拿文件名，不铺路径", () => {
    const t = summarizeTitle("附件：uploads/65a53cbdab081af8413977836a52f10b.jpg");
    expect(t.startsWith("附件 ")).toBe(true);
    expect(t).not.toContain("uploads/");
  });

  it("正文优先于附件行", () => {
    expect(summarizeTitle("写一个函数\n附件：uploads/a.png")).toBe("写一个函数");
  });

  it("剥 Markdown 行首", () => {
    expect(summarizeTitle("## 三、四线制 PT1000 测量原理")).toBe("三、四线制 PT1000 测量原理");
    expect(summarizeTitle("- 做一件事")).toBe("做一件事");
  });

  it("空任务有兜底", () => {
    expect(summarizeTitle("")).toBe("未命名任务");
    expect(summarizeTitle("   \n  ")).toBe("未命名任务");
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("收下短标题并去掉引号", () => {
    expect(sanitizeGeneratedTitle("「天气查询」")).toBe("天气查询");
  });

  it("太长或空则丢掉，维持启发式", () => {
    expect(sanitizeGeneratedTitle("")).toBeNull();
    expect(sanitizeGeneratedTitle("x".repeat(80))).toBeNull();
  });

  it("只取第一行并剥掉「标题：」前缀", () => {
    expect(sanitizeGeneratedTitle("标题：电路板复核\n还有一段解释")).toBe("电路板复核");
  });

  it("clipTitle 超长加省略号", () => {
    expect(clipTitle("abcdefghijklmnop", 8)).toBe("abcdefg…");
  });
});
