import { describe, expect, it } from 'vitest';
import {
  PRODUCT_NAME,
  desktopWindowTitle,
  hashFromHref,
  parseDesktopRoute,
} from '../electron/window-title.cjs';

describe('desktop window title', () => {
  it('首页 / 空 hash / 走查 #walk= 只用产品名，不带控制台口号', () => {
    expect(desktopWindowTitle()).toBe('FATHOM');
    expect(desktopWindowTitle({ hash: '' })).toBe('FATHOM');
    expect(desktopWindowTitle({ hash: '#/' })).toBe('FATHOM');
    expect(desktopWindowTitle({ hash: '#walk=cursor' })).toBe('FATHOM');
    expect(desktopWindowTitle({ href: 'http://127.0.0.1:4173/' })).toBe('FATHOM');
    expect(desktopWindowTitle({ href: 'http://127.0.0.1:4173/#walk=zcode' })).toBe('FATHOM');
    expect(desktopWindowTitle({ href: 'data:text/plain;charset=utf-8,starting' })).toBe('FATHOM');
  });

  it('对话页是产品名 + 页含义', () => {
    expect(desktopWindowTitle({ hash: '#/run/5d6a3212-1716-4be7-99db-0dbfb20228e5/loop' })).toBe(
      'FATHOM · 对话',
    );
    expect(desktopWindowTitle({ href: 'http://127.0.0.1:4173/#/run/abc/loop' })).toBe('FATHOM · 对话');
    expect(desktopWindowTitle({ hash: '#/run/abc' })).toBe('FATHOM · 对话');
  });

  it('其余 hash 与 Web 七路对齐', () => {
    expect(desktopWindowTitle({ hash: '#/settings' })).toBe('FATHOM · 设置');
    expect(desktopWindowTitle({ hash: '#/board' })).toBe('FATHOM · 指挥中心');
    expect(desktopWindowTitle({ hash: '#/artifacts' })).toBe('FATHOM · 产物');
    expect(desktopWindowTitle({ hash: '#/run/abc/artifact/0' })).toBe('FATHOM · 产物');
    expect(desktopWindowTitle({ hash: '#/run/abc/artifact/0?full' })).toBe('FATHOM · 产物');
    expect(desktopWindowTitle({ hash: '#/schedules' })).toBe('FATHOM · 定时任务');
    expect(desktopWindowTitle({ hash: '#/usage' })).toBe('FATHOM · 消耗');
  });

  it('任何输入都不会把「控制台」写进窗口标题', () => {
    const samples = [
      {},
      { hash: 'FATHOM 控制台' },
      { href: 'http://127.0.0.1:4173/', hash: '#/' },
      { kind: 'home' },
      { kind: 'run' },
    ];
    for (const sample of samples) {
      expect(desktopWindowTitle(sample)).not.toMatch(/控制台/);
      expect(desktopWindowTitle(sample).startsWith(PRODUCT_NAME)).toBe(true);
    }
  });

  it('parseDesktopRoute / hashFromHref 是标题的唯一事实源', () => {
    expect(parseDesktopRoute('#/run/x/loop')).toEqual({ kind: 'run' });
    expect(parseDesktopRoute('#/run/x/artifact/1')).toEqual({ kind: 'artifact' });
    expect(parseDesktopRoute('#walk=trae-solo')).toEqual({ kind: 'home' });
    expect(hashFromHref('http://127.0.0.1:4173/#/board')).toBe('#/board');
    expect(hashFromHref('data:text/plain,x')).toBe('');
  });
});
