// @vitest-environment jsdom
// @ts-nocheck
/**
 * 信息队列·前端契约测试（独立文件，不动 ui-app.test.ts / ui-patch.test.ts）。
 *
 * 守的四件事：
 *   ① reducer：message_queued（queue → chips 状态；steer → 不进 chips）、
 *      message_queue_updated 整表替换、steering 进时间线——全部从事件重放长出；
 *   ② 重放幂等：同一批事件灌进全新 state，长出与同态事件流相同的队列状态；
 *   ③ 渲染：排队 chips（含 ✕ 取消的 data-index）、插队指令用户气泡标注、
 *      message_queued 轻提示行；
 *   ④ composer：运行中亮出「插队重想 / 排队等待」，其余模式藏起。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialState,
  reduceEvent,
  reduceEvents,
  deriveChatItems,
  renderChatItem,
  renderQueueChips,
  deriveComposerMode,
  patchComposer,
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

function loadSkeleton() {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

const sse = (seq, source, type, extra = {}) => ({ seq, source, ts: 1, event: { type, ...extra } });

// ================================================================
// ① reducer
// ================================================================

describe("信息队列 · reducer", () => {
  it("message_queued(mode:queue) 进 queuedMessages 与时间线；steer 只进时间线", () => {
    let s = createInitialState("r1", "任务", false);
    s = reduceEvent(s, sse(0, "host", "message_queued", { mode: "queue", text: "排队甲" }));
    s = reduceEvent(s, sse(1, "host", "message_queued", { mode: "queue", text: "排队乙" }));
    s = reduceEvent(s, sse(2, "host", "message_queued", { mode: "steer", text: "插队丙" }));

    expect(s.queuedMessages).toEqual(["排队甲", "排队乙"]);
    const kinds = s.timeline.map((e) => `${e.type}:${e.mode ?? ""}`);
    expect(kinds).toEqual(["message_queued:queue", "message_queued:queue", "message_queued:steer"]);
  });

  it("message_queue_updated 整表替换（取消 / 自动续跑清空 / 被拒还原）", () => {
    let s = createInitialState("r1", "任务", false);
    s = reduceEvent(s, sse(0, "host", "message_queued", { mode: "queue", text: "甲" }));
    s = reduceEvent(s, sse(1, "host", "message_queued", { mode: "queue", text: "乙" }));
    // 取消单条：服务端整表推回
    s = reduceEvent(s, sse(2, "host", "message_queue_updated", { pending: ["乙"] }));
    expect(s.queuedMessages).toEqual(["乙"]);
    // 自动续跑成功：清空
    s = reduceEvent(s, sse(3, "host", "message_queue_updated", { pending: [] }));
    expect(s.queuedMessages).toEqual([]);
    // 被拒还原 + sendError 留一条时间线（取消/清空不留噪声）
    s = reduceEvent(s, sse(4, "host", "message_queue_updated", { pending: ["丙"], sendError: "并发容量已满" }));
    expect(s.queuedMessages).toEqual(["丙"]);
    expect(s.timeline.at(-1)).toMatchObject({ type: "message_queue_updated", sendError: "并发容量已满" });
  });

  it("steering 事件进时间线（气泡渲染认它），不影响队列", () => {
    let s = createInitialState("r1", "任务", false);
    s = reduceEvent(s, sse(0, "main", "steering", { text: "改方向" }));
    expect(s.timeline[0]).toMatchObject({ type: "steering", text: "改方向" });
    expect(s.queuedMessages).toEqual([]);
  });

  it("重放幂等：同一批 durable 事件灌进全新 state，长出同样的队列状态", () => {
    const batch = [
      sse(0, "host", "message_queued", { mode: "queue", text: "甲" }),
      sse(1, "host", "message_queued", { mode: "steer", text: "乙" }),
      sse(2, "host", "message_queued", { mode: "queue", text: "丙" }),
      sse(3, "host", "message_queue_updated", { pending: ["丙"] }),
      sse(4, "main", "steering", { text: "乙" }),
    ];
    const live = reduceEvents(createInitialState("r1", "任务", false), batch);
    const replayed = reduceEvents(createInitialState("r1", "任务", false), batch);
    expect(replayed.queuedMessages).toEqual(live.queuedMessages);
    expect(replayed.queuedMessages).toEqual(["丙"]);
    expect(replayed.timeline).toEqual(live.timeline);
  });
});

// ================================================================
// ③ 渲染
// ================================================================

describe("信息队列 · 渲染", () => {
  it("renderQueueChips：每条一个 chip 带 ✕（data-index），空队列返回空串", () => {
    const html = renderQueueChips(["把报告写成中文", "别忘了跑测试"]);
    expect(html).toContain("queue-chips-label");
    expect(html).toContain("把报告写成中文");
    expect(html).toContain("别忘了跑测试");
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-index="1"');
    expect(html).toContain("queue-chip-cancel");
    expect(renderQueueChips([])).toBe("");
    expect(renderQueueChips(undefined)).toBe("");
  });

  it("chips 对 HTML 注入转义", () => {
    const html = renderQueueChips(['<img src=x onerror=alert(1)>']);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("steering 在对话里渲染为带「插队指令」标注的用户气泡", () => {
    let s = createInitialState("r1", "任务", false);
    s = reduceEvent(s, sse(0, "main", "steering", { text: "别查了，直接给结论" }));
    const items = deriveChatItems(s, null);
    const bubble = items.find((it) => it.kind === "user" && it.steering === true);
    expect(bubble, "插队指令应长成用户气泡").toBeDefined();
    const html = renderChatItem(bubble);
    expect(html).toContain("chat-msg--user");
    expect(html).toContain("chat-msg-tag");
    expect(html).toContain("插队指令");
    expect(html).toContain("别查了，直接给结论");
    // 普通用户气泡不带标注
    const plain = renderChatItem({ kind: "user", text: "正常追加", seq: 9, runId: "r1" });
    expect(plain).not.toContain("chat-msg-tag");
  });

  it("message_queued 在对话里渲染为轻提示行（queue / steer 文案分开）", () => {
    // 注意：notice 在对话管线里走 collapseLiveStatus——运行中只留最新一条直播
    // 状态位（既有产品语义，compaction 提示同款）。排队清单的完整呈现面是 chips。
    let sq = createInitialState("r1", "任务", false);
    sq = reduceEvent(sq, sse(0, "host", "message_queued", { mode: "queue", text: "排队甲" }));
    const noticeQ = deriveChatItems(sq, null).filter((it) => it.kind === "notice");
    expect(noticeQ).toHaveLength(1);
    expect(renderChatItem(noticeQ[0])).toContain("已排队 · 本轮结束后自动发送");

    let ss = createInitialState("r1", "任务", false);
    ss = reduceEvent(ss, sse(0, "host", "message_queued", { mode: "steer", text: "插队乙" }));
    const noticeS = deriveChatItems(ss, null).filter((it) => it.kind === "notice");
    expect(noticeS).toHaveLength(1);
    expect(renderChatItem(noticeS[0])).toContain("插队指令已受理，将在下一轮模型调用前生效");
  });
});

// ================================================================
// ④ composer 按钮显隐
// ================================================================

describe("信息队列 · composer 按钮", () => {
  it("运行中（kind=stop）亮出「插队重想 / 排队等待」，其余模式藏起", () => {
    document.body.innerHTML = loadSkeleton();
    const steerBtn = document.querySelector("#steer-btn");
    const queueBtn = document.querySelector("#queue-btn");
    expect(steerBtn, "骨架里要有插队按钮").not.toBeNull();
    expect(queueBtn, "骨架里要有排队按钮").not.toBeNull();
    expect(steerBtn.textContent).toContain("插队重想");
    expect(queueBtn.textContent).toContain("排队等待");

    const running = deriveComposerMode({
      info: { status: "running", runId: "r1" },
      localStatus: "running",
    });
    expect(running.kind).toBe("stop");
    patchComposer(running);
    expect(steerBtn.hasAttribute("hidden")).toBe(false);
    expect(queueBtn.hasAttribute("hidden")).toBe(false);
    // 主按钮此时仍是「停止」
    expect(document.querySelector("#submit-btn-label").textContent).toBe("停止");

    // 停止中（正在停止…）：藏起来
    patchComposer(deriveComposerMode({
      info: { status: "running", runId: "r1" },
      localStatus: "running",
      stopping: true,
    }));
    expect(steerBtn.hasAttribute("hidden")).toBe(true);

    // 新建模式：藏起来
    patchComposer(deriveComposerMode({ info: null }));
    expect(steerBtn.hasAttribute("hidden")).toBe(true);
    expect(queueBtn.hasAttribute("hidden")).toBe(true);

    // 可追加（done）：藏起来——追加走主按钮
    patchComposer(deriveComposerMode({
      info: { status: "done", runId: "r1", canContinue: true, continuationMode: "same-run" },
      localStatus: "done",
    }));
    expect(steerBtn.hasAttribute("hidden")).toBe(true);
  });
});
