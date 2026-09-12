import { describe, expect, it } from "vitest";
import {
  buildFreshTurnBackground,
  buildContinuationAnchor,
  buildThreadSketch,
  formatSiblingBootContext,
  isRelativeContinuation,
  shouldTreatAsExecutorSwitch,
  buildExecutorSwitchBriefing,
  withBootContext,
  buildWorkspaceGitBriefing,
} from "../ui/conversation-context.js";

describe("isRelativeContinuation", () => {
  it.each([
    "继续",
    "接着做",
    "往下改",
    "continue",
    "Continue.",
    "还能再优化吗",
    "再优化一下",
    "再改改",
    "继续未完成的任务",
    "接着做未完成项",
    "继续这个任务",
  ])(
    "认相对指代：%s",
    (t) => {
      expect(isRelativeContinuation(t)).toBe(true);
    },
  );
  it.each(["帮我优化这个网站", "继续把 CRC 位号改成 L1 的 1<<12 并重烧", ""])(
    "不把自足任务当相对指代：%s",
    (t) => {
      expect(isRelativeContinuation(t)).toBe(false);
    },
  );
});

describe("buildFreshTurnBackground / thread sketch", () => {
  it("无正史时禁止模型空口否认任务记录，并带上收口", () => {
    const bg = buildFreshTurnBackground({
      task: "优化 liquid-demo",
      conversationRecap: "已改完暗色顶栏。",
    });
    expect(bg).toContain("优化 liquid-demo");
    expect(bg).toContain("不要声称「没有任务记录」");
    expect(bg).toContain("已改完暗色顶栏");
  });

  it("有计划摘要时优先用摘要，仍可附开机背景", () => {
    const bg = buildFreshTurnBackground({
      task: "继续",
      planSummary: "【本对话此前是一次计划编排】原任务：做 PPT",
      bootContext: formatSiblingBootContext({
        title: "优化站点",
        task: "帮我优化这个网站",
        recap: "截图已出",
        conversationTurn: 4,
      }),
    });
    expect(bg).toContain("计划编排");
    expect(bg).toContain("同工作目录另有会话");
    expect(bg).not.toContain("帮我优化这个网站");
    expect(bg).not.toContain("默认接着上述会话");
    expect(bg).not.toContain("先 ask_user 确认");
  });

  it("相对指代锚点钉死本对话，禁止把邻居会话列进选项", () => {
    const anchor = buildContinuationAnchor({
      task: "我想制作一个关于华侨大学介绍的PPT",
      planSummary: "【计划】s1 勘察 / s2 改稿",
    });
    expect(anchor).toContain("华侨大学");
    expect(anchor).toContain("本对话锚点");
    expect(anchor).toContain("不要把邻居任务列进 ask_user");
    expect(anchor).toContain("未完成");
    expect(anchor).toContain("【计划】s1");
  });

  it("thread sketch 抽最近委托与执行者收口", () => {
    const sketch = buildThreadSketch([
      { source: "host", event: { type: "user_message", text: "帮我优化这个网站" } },
      { source: "main", event: { type: "assistant_text", text: "我先看结构。" } },
      { source: "host", event: { type: "user_message", text: "继续" } },
      { source: "verifier", event: { type: "assistant_text", text: "核查意见不应进速写" } },
      { source: "main", event: { type: "assistant_text", text: "暗色顶栏已改完。" } },
    ]);
    expect(sketch).toContain("帮我优化这个网站");
    expect(sketch).toContain("继续");
    expect(sketch).toContain("暗色顶栏已改完");
    expect(sketch).not.toContain("核查意见");
  });

  it("换模型 briefing 钉死同一场对话，并带上原任务与收口", () => {
    const text = buildExecutorSwitchBriefing({
      task: "记住暗号 alpha-7",
      fromModel: "deepseek-v4-flash",
      toModel: "claude-opus-4-8",
      conversationRecap: "已写下暗号。",
    });
    expect(text).toContain("执行模型已切换");
    expect(text).toContain("deepseek-v4-flash");
    expect(text).toContain("claude-opus-4-8");
    expect(text).toContain("同一场对话");
    expect(text).toContain("记住暗号 alpha-7");
    expect(text).toContain("已写下暗号");
    expect(text).toContain("不要声称没有上文");
  });

  it("角色 id 或端点身份变了才算换执行者；缺旧指纹不误判", () => {
    expect(shouldTreatAsExecutorSwitch(
      { roleId: "m-fast", identityKey: "openai|flash" },
      { roleId: "m-strong", identityKey: "openai|flash" },
    )).toBe(true);
    expect(shouldTreatAsExecutorSwitch(
      { roleId: "m-fast", identityKey: "openai|flash" },
      { roleId: "m-fast", identityKey: "anthropic|opus" },
    )).toBe(true);
    expect(shouldTreatAsExecutorSwitch(
      { roleId: "m-fast", identityKey: "openai|flash" },
      { roleId: "m-fast", identityKey: "openai|flash" },
    )).toBe(false);
    expect(shouldTreatAsExecutorSwitch(
      {},
      { roleId: "m-strong", identityKey: "anthropic|opus" },
    )).toBe(false);
  });

  it("withBootContext 只在有背景时拼接", () => {
    expect(withBootContext("继续")).toBe("继续");
    expect(withBootContext("继续", "【背景】x")).toContain("【背景】x");
  });
});

describe("buildWorkspaceGitBriefing", () => {
  it("无仓库不说话；有 GitHub 身份不写 remote URL", () => {
    expect(buildWorkspaceGitBriefing(null)).toBe("");
    expect(buildWorkspaceGitBriefing({ present: false })).toBe("");
    const text = buildWorkspaceGitBriefing({
      present: true,
      branch: "main",
      dirty: true,
      github: { owner: "acme", repo: "app" },
    });
    expect(text).toContain("GitHub acme/app");
    expect(text).toContain("main");
    expect(text).toContain("未提交");
    expect(text).toContain("不可信");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("ghp_");
  });
});

describe("formatSiblingBootContext", () => {
  it("邻居只作参考，不怂恿 ask_user 把邻居任务列成选项", () => {
    const text = formatSiblingBootContext({
      title: "优化站点",
      task: "帮我优化这个网站",
      recap: "截图已出",
      conversationTurn: 6,
    });
    expect(text).toContain("新开的对话");
    expect(text).toContain("回到那场会话里追问");
    expect(text).not.toContain("优化站点");
    expect(text).not.toContain("帮我优化这个网站");
    expect(text).not.toContain("截图已出");
    expect(text).toContain("不要根据工作目录");
    expect(text).not.toMatch(/默认接着/);
    expect(text).not.toMatch(/先 ask_user 确认/);
  });
});
