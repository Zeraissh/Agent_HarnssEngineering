// @vitest-environment jsdom
// @ts-nocheck
/**
 * 阅读模式（features/reading-mode.js）的回归锁——T12。
 *
 * 分层覆盖：
 *   纯函数层：单元分类 / 聚类（元素序列 → 摘要段模型）/ 摘要文案 / 时长格式化 /
 *             工具耗时解析 / 偏好读写（默认完整、非法值回退）
 *   DOM 层  ：jsdom 里真实初始化，验证聚焦模式藏过程元素 + 插摘要行、
 *             决策类痕迹（审批/裁决/段分界）与用户消息/正文/产物保留、
 *             点击摘要行展开收起、模式切换幂等、偏好持久化同源、
 *             直播增量（新过程事件不弹开已收起段、新正文正常出现）、
 *             空对话不渲染开关
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  READING_MODE_KEY,
  readReadingMode,
  writeReadingMode,
  classifyUnit,
  clusterUnits,
  formatDuration,
  summaryText,
  parseToolDuration,
  initReadingMode,
} from "../ui/public/features/reading-mode.js";
import { initSettingsView } from "../ui/public/features/settings.js";

/** 内存 storage 桩（隐私模式 / 测试注入两用） */
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------
describe("readReadingMode / writeReadingMode 偏好读写", () => {
  it("未设偏好默认完整（保守上线）；非法值回退完整", () => {
    const s = memStorage();
    expect(readReadingMode(s)).toBe("full");
    s.setItem(READING_MODE_KEY, "weird");
    expect(readReadingMode(s)).toBe("full");
  });

  it("写入后读回同值；非法写入按 full 落盘", () => {
    const s = memStorage();
    expect(writeReadingMode(s, "focus")).toBe("focus");
    expect(readReadingMode(s)).toBe("focus");
    expect(writeReadingMode(s, "nope")).toBe("full");
    expect(s.getItem(READING_MODE_KEY)).toBe("full");
  });

  it("storage 不可用时读回完整、写入不抛", () => {
    expect(readReadingMode(null)).toBe("full");
    expect(writeReadingMode(null, "focus")).toBe("focus");
  });
});

describe("classifyUnit 单元分类", () => {
  const make = (html) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild;
  };

  it("思考 / 工具组 / 工具行 / 活动条是过程类", () => {
    expect(classifyUnit(make('<details class="chat-thinking"><summary>t</summary></details>'))).toBe("thinking");
    expect(classifyUnit(make('<details class="chat-thinking chat-thinking--live"><summary>t</summary></details>'))).toBe("thinking");
    expect(classifyUnit(make('<details class="chat-tool-group"><summary>t</summary></details>'))).toBe("tool");
    expect(classifyUnit(make('<details class="chat-tool"><summary>t</summary></details>'))).toBe("tool");
    expect(classifyUnit(make('<div class="chat-activity">正在 bash</div>'))).toBe("activity");
    expect(classifyUnit(make('<div class="chat-activity chat-notice">上下文已压缩</div>'))).toBe("activity");
  });

  it("用户消息 / 正文 / 审批 / 裁决 / 产物 / 段分界是锚点（监督语义不藏）", () => {
    expect(classifyUnit(make('<div class="chat-msg chat-msg--user">问</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="chat-msg chat-msg--assistant">答</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="chat-msg chat-msg--assistant chat-msg--live">流式</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="chat-gate">⚠ bash 需要你放行</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="chat-verdict chat-verdict--ok">核查通过</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="chat-artifacts">产物</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="segment-boundary segment-boundary--verifier">核查</div>'))).toBe("anchor");
    expect(classifyUnit(make('<div class="chat-recap">此前对话</div>'))).toBe("anchor");
  });
});

describe("clusterUnits 聚类", () => {
  const U = (kind, key, durationMs) => ({ kind, key, durationMs });

  it("连续过程单元合并为一条摘要段；锚点原样保留", () => {
    const segs = clusterUnits([
      U("anchor", "user:-1"),
      U("thinking", "thinking:1"),
      U("thinking", "thinking:2"),
      U("tool", "tools:a", 1200),
      U("activity", "activity"),
      U("anchor", "text:9"),
      U("tool", "tools:b", 800),
      U("anchor", "verdict:1:1"),
    ]);
    expect(segs).toEqual([
      { type: "anchor", key: "user:-1" },
      { type: "summary", key: "thinking:1", thinking: 2, tools: 1, activities: 1, durationMs: 1200 },
      { type: "anchor", key: "text:9" },
      { type: "summary", key: "tools:b", thinking: 0, tools: 1, activities: 0, durationMs: 800 },
      { type: "anchor", key: "verdict:1:1" },
    ]);
  });

  it("段 key 取首单元 key；相邻锚点之间没有过程就不产生摘要段", () => {
    const segs = clusterUnits([U("anchor", "a"), U("anchor", "b"), U("tool", "t:x")]);
    expect(segs.map((s) => s.type)).toEqual(["anchor", "anchor", "summary"]);
    expect(segs[2].key).toBe("t:x");
  });

  it("空序列与全锚点序列都不产生摘要", () => {
    expect(clusterUnits([])).toEqual([]);
    expect(clusterUnits([U("anchor", "a")])).toEqual([{ type: "anchor", key: "a" }]);
  });
});

describe("summaryText / formatDuration 摘要文案", () => {
  it("维度齐全时全列；零计数维度不出现；时长可缺", () => {
    expect(summaryText({ thinking: 3, tools: 7, activities: 0, durationMs: 12000 }))
      .toBe("3 次思考 · 7 个工具调用 · 12s");
    expect(summaryText({ thinking: 0, tools: 2, activities: 1, durationMs: 0 }))
      .toBe("2 个工具调用 · 1 条状态提示");
    expect(summaryText({ thinking: 1, tools: 0, activities: 0, durationMs: 0 })).toBe("1 次思考");
    expect(summaryText({ thinking: 0, tools: 0, activities: 0, durationMs: 0 })).toBe("");
  });

  it("时长格式化分档", () => {
    expect(formatDuration(998)).toBe("998ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(12000)).toBe("12s");
    expect(formatDuration(125000)).toBe("2m5s");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(-5)).toBe("");
  });
});

describe("parseToolDuration 工具耗时解析", () => {
  it("工具行 summary 里的 ms peek 求和；组/无耗时按 0", () => {
    const row = document.createElement("details");
    row.className = "chat-tool";
    row.innerHTML = '<summary><span class="aside-peek">120ms</span></summary>';
    expect(parseToolDuration(row)).toBe(120);
    const group = document.createElement("details");
    group.className = "chat-tool-group";
    group.innerHTML = "<summary>bash ls</summary>";
    expect(parseToolDuration(group)).toBe(0);
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
describe("initReadingMode DOM 后处理", () => {
  let storage;
  let backBar;
  let conversation;
  let api;

  /** 造一条 chat-item */
  const item = (innerHtml) => {
    const el = document.createElement("div");
    el.className = "chat-item";
    el.innerHTML = innerHtml;
    return el;
  };

  /** 一条典型的长任务对话流 */
  function seedConversation() {
    conversation.appendChild(item('<div class="chat-msg chat-msg--user"><div class="chat-body">帮我查热电偶</div></div>'));
    conversation.appendChild(item('<details class="chat-thinking"><summary>Thought Process</summary><div class="chat-body">想想</div></details>'));
    conversation.appendChild(item('<details class="chat-tool-group"><summary>bash ls</summary><div class="chat-tool-group-body"></div></details>'));
    conversation.appendChild(item('<details class="chat-tool"><summary><code>bash</code> <span class="aside-peek">120ms</span></summary></details>'));
    conversation.appendChild(item('<div class="chat-msg chat-msg--assistant"><div class="chat-body">第一段结论</div></div>'));
    conversation.appendChild(item('<div class="segment-boundary segment-boundary--verifier"><span class="segment-label">严不苟 · 核查</span></div>'));
    conversation.appendChild(item('<details class="chat-thinking"><summary>Thought Process</summary></details>'));
    conversation.appendChild(item('<div class="chat-verdict chat-verdict--ok"><div class="chat-verdict-head">核查通过</div></div>'));
    conversation.appendChild(item('<div class="chat-artifacts"><div class="chat-artifacts-list">报告.pdf</div></div>'));
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    storage = memStorage();
    backBar = document.createElement("div");
    backBar.className = "back-bar";
    conversation = document.createElement("div");
    conversation.id = "conversation";
    document.body.appendChild(backBar);
    document.body.appendChild(conversation);
    api = initReadingMode({}, { doc: document, storage });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // 只数被藏的过程元素，不含被回收的空壳 chat-item 包装
  const hiddenCount = () => conversation.querySelectorAll(".rm-hidden:not(.chat-item)").length;
  const summaries = () => [...conversation.querySelectorAll(".rm-summary")];

  it("完整模式（默认）不做任何处理；开关挂进 back-bar 且可见", () => {
    seedConversation();
    api.update(backBar, conversation);
    expect(api.getMode()).toBe("full");
    expect(backBar.contains(api.element)).toBe(true);
    expect(api.element.hidden).toBe(false);
    expect(hiddenCount()).toBe(0);
    expect(summaries()).toHaveLength(0);
  });

  it("空对话不渲染开关", () => {
    api.update(backBar, conversation);
    expect(api.element.hidden).toBe(true);
    conversation.innerHTML = '<p class="empty-note">刚开始，还没有内容。</p>';
    api.update(backBar, conversation);
    expect(api.element.hidden).toBe(true);
  });

  it("聚焦模式：过程隐藏成摘要行，正文/审批/裁决/段分界/产物全保留", () => {
    seedConversation();
    api.setMode("focus");
    api.update(backBar, conversation);

    // 两段过程 → 两条摘要行（thinking+group+row 一段，核查段前的 thinking 一段）
    const lines = summaries();
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("1 次思考");
    expect(lines[0].textContent).toContain("2 个工具调用");
    expect(lines[0].textContent).toContain("120ms");
    expect(lines[1].textContent).toContain("1 次思考");

    // 被藏的是 thinking×2 + tool-group + tool-row
    expect(hiddenCount()).toBe(4);
    expect(conversation.querySelector("details.chat-thinking").classList.contains("rm-hidden")).toBe(true);
    expect(conversation.querySelector("details.chat-tool-group").classList.contains("rm-hidden")).toBe(true);

    // 空壳回收：子元素全藏的 chat-item 连壳一起藏（否则 flex gap 仍占高度）
    const thinkItem = conversation.querySelector("details.chat-thinking").closest(".chat-item");
    expect(thinkItem.classList.contains("rm-hidden")).toBe(true);
    const textItem = conversation.querySelector(".chat-msg--assistant").closest(".chat-item");
    expect(textItem.classList.contains("rm-hidden")).toBe(false);

    // 锚点全部可见
    for (const sel of [".chat-msg--user", ".chat-msg--assistant", ".segment-boundary", ".chat-verdict", ".chat-artifacts"]) {
      const el = conversation.querySelector(sel);
      expect(el, sel).not.toBeNull();
      expect(el.classList.contains("rm-hidden"), sel).toBe(false);
    }
    // 摘要行位置：第一段摘要插在第一段结论之前
    const children = [...conversation.children];
    const summaryAt = children.findIndex((c) => c.classList.contains("rm-summary"));
    const textAt = children.findIndex((c) => c.querySelector(".chat-msg--assistant"));
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(textAt);
  });

  it("点击摘要行展开该段过程，再点收起；重算后展开态保留", () => {
    seedConversation();
    api.setMode("focus");
    api.update(backBar, conversation);
    const first = summaries()[0];
    expect(first.getAttribute("aria-expanded")).toBe("false");

    first.click();
    expect(first.getAttribute("aria-expanded")).toBe("true");
    // 该段过程全部露出来
    expect(conversation.querySelector("details.chat-tool-group").classList.contains("rm-hidden")).toBe(false);
    expect(api.getExpandedKeys()).toHaveLength(1);

    // 模拟宿主每次渲染后的重算：展开态不丢（直播不弹回）
    api.update(backBar, conversation);
    const again = summaries()[0];
    expect(again.getAttribute("aria-expanded")).toBe("true");
    expect(conversation.querySelector("details.chat-tool-group").classList.contains("rm-hidden")).toBe(false);

    again.click();
    expect(again.getAttribute("aria-expanded")).toBe("false");
    expect(conversation.querySelector("details.chat-tool-group").classList.contains("rm-hidden")).toBe(true);
  });

  it("模式切换幂等：聚焦→完整→聚焦，DOM 可反复还原", () => {
    seedConversation();
    api.setMode("focus");
    api.update(backBar, conversation);
    expect(hiddenCount()).toBeGreaterThan(0);

    api.setMode("full");
    api.update(backBar, conversation);
    expect(hiddenCount()).toBe(0);
    expect(summaries()).toHaveLength(0);

    // 再切回聚焦：结果与第一次一致
    api.setMode("focus");
    api.update(backBar, conversation);
    expect(summaries()).toHaveLength(2);
    expect(hiddenCount()).toBe(4);
    // 重复 apply 不叠加摘要行
    api.update(backBar, conversation);
    api.update(backBar, conversation);
    expect(summaries()).toHaveLength(2);
  });

  it("偏好持久化同源：setMode 落 localStorage，新实例读回同值", () => {
    seedConversation();
    api.setMode("focus");
    expect(storage.getItem(READING_MODE_KEY)).toBe("focus");
    // 模拟另一次会话初始化（同一 storage）
    document.body.innerHTML = "";
    const api2 = initReadingMode({}, { doc: document, storage });
    expect(api2.getMode()).toBe("focus");
  });

  it("syncFromStorage：设置中心写入后详情侧对齐", () => {
    seedConversation();
    api.update(backBar, conversation);
    expect(api.getMode()).toBe("full");
    storage.setItem(READING_MODE_KEY, "focus");
    api.syncFromStorage();
    expect(api.getMode()).toBe("focus");
    expect(hiddenCount()).toBeGreaterThan(0);
  });

  it("直播增量：新过程事件并入尾段但不弹开；新正文正常出现", () => {
    seedConversation();
    api.setMode("focus");
    api.update(backBar, conversation);
    expect(summaries()).toHaveLength(2);

    // 新到一条思考 + 一个工具（尾段）
    conversation.appendChild(item('<details class="chat-thinking"><summary>Thought Process</summary></details>'));
    conversation.appendChild(item('<details class="chat-tool"><summary><code>bash</code> <span class="aside-peek">80ms</span></summary></details>'));
    api.update(backBar, conversation);
    const tail = summaries().at(-1);
    expect(tail.textContent).toContain("1 次思考");
    expect(tail.textContent).toContain("1 个工具调用");
    // 保持收起
    expect(tail.getAttribute("aria-expanded")).toBe("false");
    expect(conversation.querySelectorAll("details.chat-tool")[1].classList.contains("rm-hidden")).toBe(true);

    // 正文流式出现：新 chat-item 含 live 思考 + live 正文——思考折、正文露
    conversation.appendChild(item(
      '<details class="chat-thinking chat-thinking--live"><summary>Thinking</summary></details>' +
      '<div class="chat-msg chat-msg--assistant chat-msg--live"><div class="chat-body chat-live-text">正在写结论</div></div>',
    ));
    api.update(backBar, conversation);
    const liveItem = conversation.lastElementChild;
    expect(liveItem.querySelector("details.chat-thinking").classList.contains("rm-hidden")).toBe(true);
    expect(liveItem.querySelector(".chat-msg--live").classList.contains("rm-hidden")).toBe(false);
    // live 正文是锚点：它把前面的过程隔成独立尾段
    expect(summaries().at(-1).getAttribute("aria-expanded")).toBe("false");
  });

  it("段 key 用 patchList 键控表时身份稳定（展开态跨内容增长保留）", () => {
    // 模拟 patchList 的 __patchNodes：key → chat-item 节点
    const think = item('<details class="chat-thinking"><summary>t</summary></details>');
    const tools = item('<details class="chat-tool-group"><summary>g</summary></details>');
    conversation.appendChild(think);
    conversation.appendChild(tools);
    conversation.__patchNodes = new Map([["thinking:1", think], ["tools:a", tools]]);

    api.setMode("focus");
    api.update(backBar, conversation);
    summaries()[0].click(); // 展开尾段
    expect(api.getExpandedKeys()).toEqual(["thinking:1#0"]);

    // 直播追加：尾段增长，但首单元 key 不变 → 展开态保留
    const tools2 = item('<details class="chat-tool"><summary><code>bash</code></summary></details>');
    conversation.appendChild(tools2);
    conversation.__patchNodes.set("tools:b", tools2);
    api.update(backBar, conversation);
    expect(summaries()[0].getAttribute("aria-expanded")).toBe("true");
    expect(tools2.querySelector("details").classList.contains("rm-hidden")).toBe(false);
  });

  it("骨架重建后 re-parent：开关搬到新 back-bar", () => {
    seedConversation();
    api.update(backBar, conversation);
    expect(backBar.contains(api.element)).toBe(true);
    // 模拟 ensureDetailLayout 重建骨架：旧 back-bar 销毁，换新的
    const newBackBar = document.createElement("div");
    newBackBar.className = "back-bar";
    document.body.appendChild(newBackBar);
    api.update(newBackBar, conversation);
    expect(newBackBar.contains(api.element)).toBe(true);
    expect(api.element.hidden).toBe(false);
  });

  it("开关是 radio 语义：聚焦/完整两颗，aria-checked 跟随模式", () => {
    seedConversation();
    api.update(backBar, conversation);
    expect(api.element.getAttribute("role")).toBe("radiogroup");
    const radios = [...api.element.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(["聚焦", "完整"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    radios[0].click();
    expect(api.getMode()).toBe("focus");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });
});

// ---------------------------------------------------------------
// 设置中心同源（features/settings.js 外观分组 ↔ 本模块同一个键）
// ---------------------------------------------------------------
describe("设置中心「外观」阅读模式偏好同源", () => {
  const scaffold = () => {
    document.body.innerHTML =
      '<aside class="sidebar"><button type="button" id="settings-open-btn"></button></aside>' +
      '<div id="main-panel"></div>';
  };

  const makeHost = (overrides = {}) => ({
    getTheme: () => "auto",
    onSelectTheme: () => {},
    getHarnessSnapshot: () => null,
    onApplyComposerDefaults: () => {},
    onOpenSettings: () => {},
    onCloseSettings: () => {},
    onAnnounce: () => {},
    ...overrides,
  });

  const makeEnv = (storage) => ({
    doc: document,
    win: window,
    storage,
    Notification: {
      permission: "default",
      requestPermission: (cb) => { cb?.("granted"); return Promise.resolve("granted"); },
    },
  });

  it("外观分组渲染「对话阅读模式」radio，checked 反映已存偏好", () => {
    scaffold();
    const storage = memStorage();
    storage.setItem(READING_MODE_KEY, "focus");
    const view = initSettingsView(makeHost(), makeEnv(storage));
    view.open();
    const radios = [...document.querySelectorAll('input[name="settings-reading-mode"]')];
    expect(radios.map((r) => r.value)).toEqual(["full", "focus"]);
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
  });

  it("设置页改动写同一个键并回调 onReadingModeChange；详情侧 syncFromStorage 对齐", () => {
    scaffold();
    const storage = memStorage();
    let notified = 0;
    const view = initSettingsView(
      makeHost({ onReadingModeChange: () => { notified += 1; } }),
      makeEnv(storage),
    );
    view.open();
    const focus = document.querySelector('input[name="settings-reading-mode"][value="focus"]');
    focus.checked = true;
    focus.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(storage.getItem(READING_MODE_KEY)).toBe("focus");
    expect(notified).toBe(1);

    // 同源验证：详情侧实例读同一个 storage，syncFromStorage 后模式一致
    // （先建实例再改偏好，模拟「设置页改动晚于详情页初始化」）
    scaffold();
    const rm = initReadingMode({}, { doc: document, storage });
    expect(rm.getMode()).toBe("focus"); // 初始化即读到上方写入的 focus
    storage.setItem(READING_MODE_KEY, "full");
    rm.syncFromStorage();
    expect(rm.getMode()).toBe("full");
  });
});
