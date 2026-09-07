// @vitest-environment jsdom
// @ts-nocheck
/**
 * 提问卡「推荐」徽标的渲染回归锁（§5.2 延伸）。
 *
 * 委托方需求：推荐标记是选项**旁边**的结构化徽标，不是选项文字的一部分——
 * 旧写法把「（推荐）」塞进选项文字，回传的答案就带着重复词语。
 * 锁三件事：徽标渲染对位、radio value 是干净文字、无 recommended 时无徽标。
 * 样式侧（令牌 / 字号下限 / 禁裸 hex）由 ui-app.test.ts 的静态门禁守护，这里不重复。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, reduceEvent, renderRunDetail } from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

function loadSkeleton(): string {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

/** 把一组问题推成挂起态并渲染，返回 .user-question 容器 */
function renderQuestionCard(questions) {
  let s = createInitialState("run-q", "做一版 Desktop UI", false);
  s = reduceEvent(s, { seq: 0, source: "host", event: { type: "turn_start", turn: 1 } });
  s = reduceEvent(s, {
    seq: 1,
    source: "host",
    event: { type: "user_question_request", id: "q1", questions, at: 1000 },
  });
  renderRunDetail(s, { activeTab: "loop" });
  return document.querySelector(".user-question");
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
  document.title = "Agent Harness — Web UI";
  document.body.innerHTML = loadSkeleton();
});

describe("提问卡推荐徽标（.question-badge）", () => {
  it("recommended 命中的选项文字旁有「推荐」徽标，其余选项没有", () => {
    renderQuestionCard([
      {
        question: "桌面端用哪个框架？",
        options: ["Electron", "Tauri", "Qt"],
        fallback: "默认 Tauri",
        recommended: 2,
      },
    ]);
    const labels = [...document.querySelectorAll(".user-question .question-opt")];
    expect(labels).toHaveLength(3);
    expect(labels[0].querySelector(".question-badge")).toBeNull();
    expect(labels[1].querySelector(".question-badge"), "第 2 项被推荐").not.toBeNull();
    expect(labels[1].querySelector(".question-badge").textContent).toBe("推荐");
    expect(labels[2].querySelector(".question-badge")).toBeNull();
  });

  it("radio 的 value 是干净文字——回传的答案永远不带装饰词", () => {
    renderQuestionCard([
      {
        question: "用哪个？",
        options: ["Electron", "Tauri"],
        fallback: "默认 Tauri",
        recommended: 2,
      },
    ]);
    const values = [...document.querySelectorAll('.user-question input[type="radio"]')].map(
      (r) => r.value,
    );
    expect(values).toEqual(["Electron", "Tauri"]);
    expect(values.join()).not.toContain("推荐");
  });

  it("没有 recommended 字段时一个徽标都不渲染", () => {
    renderQuestionCard([
      { question: "用哪个？", options: ["a", "b"], fallback: "默认 a" },
    ]);
    expect(document.querySelectorAll(".user-question .question-badge")).toHaveLength(0);
  });

  it("reducer 对越界/非整数的 recommended 静默丢弃，不留脏字段", () => {
    for (const bad of [0, 5, 1.5, "2"]) {
      const s = reduceEvent(createInitialState("r", "t", false), {
        seq: 0,
        source: "host",
        event: {
          type: "user_question_request",
          id: "q1",
          questions: [
            { question: "q", options: ["a", "b"], fallback: "f", recommended: bad },
          ],
          at: 1,
        },
      });
      expect(s.question.questions[0].recommended, `${JSON.stringify(bad)} 应被丢弃`).toBeUndefined();
    }
  });

  it("已决留痕（questionLog）保留 recommended——审计记录与当时所见一致", () => {
    let s = createInitialState("run-q", "t", false);
    s = reduceEvent(s, {
      seq: 0,
      source: "host",
      event: {
        type: "user_question_request",
        id: "q1",
        questions: [
          { question: "用哪个？", options: ["a", "b"], fallback: "f", recommended: 2 },
        ],
        at: 1,
      },
    });
    s = reduceEvent(s, {
      seq: 1,
      source: "host",
      event: { type: "user_question_resolved", id: "q1", requestSeq: 0, answers: ["b"], at: 2 },
    });
    expect(s.questionLog).toHaveLength(1);
    expect(s.questionLog[0].questions[0].recommended).toBe(2);
  });

  it("recommended 变化触发重渲染——签名里带着它，不会被增量补丁跳过", () => {
    const mk = (rec) => [
      { question: "用哪个？", options: ["a", "b"], fallback: "f", ...(rec ? { recommended: rec } : {}) },
    ];
    renderQuestionCard(mk(1));
    let labels = [...document.querySelectorAll(".user-question .question-opt")];
    expect(labels[0].querySelector(".question-badge")).not.toBeNull();
    expect(labels[1].querySelector(".question-badge")).toBeNull();

    // 同 id 同文字、只换推荐项：签名不带 recommended 的话这次补丁会被跳过
    let s = createInitialState("run-q", "做一版 Desktop UI", false);
    s = reduceEvent(s, { seq: 0, source: "host", event: { type: "turn_start", turn: 1 } });
    s = reduceEvent(s, {
      seq: 1, source: "host",
      event: { type: "user_question_request", id: "q1", questions: mk(2), at: 2000 },
    });
    renderRunDetail(s, { activeTab: "loop" });
    labels = [...document.querySelectorAll(".user-question .question-opt")];
    expect(labels[0].querySelector(".question-badge")).toBeNull();
    expect(labels[1].querySelector(".question-badge")).not.toBeNull();
  });
});
