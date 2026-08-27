import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorkspace, loadWorkspaceState, saveWorkspaceState, selectWorkspace } from '../electron/workspace-store.cjs';
import { makeTmpDir } from './workspace-test-util.js';

describe('desktop workspace store', () => {
  it('首次启动只有安全的 fallback；添加后持久化并可切换', () => {
    const root = makeTmpDir();
    const project = join(root, 'project');
    mkdirSync(project);
    const file = join(root, 'workspaces.json');
    let state = loadWorkspaceState(file, root);
    expect(state).toEqual({ selected: root, directories: [root] });

    state = addWorkspace(state, project);
    expect(state.selected).toBe(project);
    expect(state.directories).toEqual([project, root]);
    saveWorkspaceState(file, state);
    expect(JSON.parse(readFileSync(file, 'utf8')).selected).toBe(project);

    state = selectWorkspace(state, root);
    expect(state.selected).toBe(root);
    saveWorkspaceState(file, state); // 已有配置的原子替换在 Windows 也必须可用
    expect(JSON.parse(readFileSync(file, 'utf8')).selected).toBe(root);
    expect(() => selectWorkspace(state, join(root, 'missing'))).toThrow(/尚未授权/);
  });

  it('损坏配置与不存在目录被丢弃，不会扩大白名单', () => {
    const root = makeTmpDir();
    const file = join(root, 'workspaces.json');
    const state = loadWorkspaceState(file, root, {
      exists: (p) => p === file || p === root,
      read: () => '{ broken json',
      stat: () => ({ isDirectory: () => true }),
    });
    expect(state).toEqual({ selected: root, directories: [root] });
  });
});
