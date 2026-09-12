import { describe, expect, it } from "vitest";
import { abortError, rejectWhenAborted } from "../src/abort.js";

describe("rejectWhenAborted", () => {
  it("已中止则立刻拒绝，不等原 Promise", async () => {
    const ac = new AbortController();
    ac.abort();
    let started = false;
    const hanging = new Promise<string>(() => {
      started = true;
    });
    await expect(rejectWhenAborted(hanging, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(true);
  });

  it("中途 abort 立刻拒绝，不陪无视 signal 的 await 耗着", async () => {
    const ac = new AbortController();
    const hanging = new Promise<string>(() => {
      /* 永不 resolve——模拟兼容端点吞掉 signal */
    });
    const raced = rejectWhenAborted(hanging, ac.signal);
    ac.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });
  });

  it("正常完成原样返回", async () => {
    await expect(rejectWhenAborted(Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(rejectWhenAborted(Promise.resolve("ok"), new AbortController().signal)).resolves.toBe("ok");
  });

  it("abortError 名字是 AbortError，loop 才不会当成故障重试", () => {
    expect(abortError().name).toBe("AbortError");
  });
});
