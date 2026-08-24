// @ts-nocheck
/**
 * Agent Harness Console — 冒烟测试。
 *
 * 控制台前端是从仓库 ui/public 原样拷贝的纯 reducer + 渲染模型，
 * 这里只锁几条最核心的状态折叠不变量，保证打包进来的是能用的那份代码。
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  reduceEvent,
  reduceEvents,
  deriveComposerMode,
} from '../app.js';

function sse(source, type, extra = {}, seq = 1) {
  return { seq, source, event: { type, ...extra } };
}

describe('Agent Harness 前端 reducer 冒烟', () => {
  it('createInitialState 初始化为 running 且无裁决', () => {
    const state = createInitialState('r1', '阅读文档并总结', false);
    expect(state.runId).toBe('r1');
    expect(state.status).toBe('running');
    expect(state.timeline).toEqual([]);
    expect(state.verdict).toBeNull();
    expect(state.usage).toBeNull();
  });

  it('approval_request 挂起审批，等待委托方决定', () => {
    let state = createInitialState('r1', '写文件', false);
    state = reduceEvent(
      state,
      sse('main', 'approval_request', {
        toolUseId: 'tu_1',
        name: 'write_file',
        input: { path: 'a.md', content: 'x' },
      }),
    );
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].toolUseId).toBe('tu_1');
    expect(state.pendingApprovals[0].name).toBe('write_file');
  });

  it('user_message 把终态拉回 running 并追加到时间线', () => {
    let state = createInitialState('r1', '第一轮', false);
    state = { ...state, status: 'done', runEnd: { outcome: 'completed' } };
    state = reduceEvent(state, sse('main', 'user_message', { text: '继续', turn: 2 }));
    expect(state.status).toBe('running');
    expect(state.runEnd).toBeNull();
    expect(state.timeline.at(-1).type).toBe('user_message');
    expect(state.timeline.at(-1).text).toBe('继续');
  });

  it('plan_approval_request 把计划门置为 pending', () => {
    let state = createInitialState('r1', '计划任务', false);
    state = reduceEvent(state, sse('host', 'plan_approval_request', { at: 1234 }));
    expect(state.planApproval.status).toBe('pending');
  });

  it('reduceEvents 按 seq 幂等：同批重放不产生重复条目', () => {
    let state = createInitialState('r1', '任务', false);
    const events = [
      sse('main', 'turn_start', { turn: 1 }, 0),
      sse('main', 'tool_call', { toolUseId: 'tu_1', name: 'read_file', input: {} }, 1),
      sse('main', 'tool_result', { toolUseId: 'tu_1', result: { content: 'ok', isError: false } }, 2),
    ];
    const once = reduceEvents(state, events);
    const twice = reduceEvents(reduceEvents(state, events), events);
    expect(twice.timeline).toEqual(once.timeline);
  });

  it('deriveComposerMode：无选中 run 时是新任务模式', () => {
    const mode = deriveComposerMode({
      info: null,
      localStatus: null,
      submitting: false,
      error: null,
    });
    expect(mode.mode).toBe('new');
    expect(mode.canSubmit).toBe(true);
  });
});
