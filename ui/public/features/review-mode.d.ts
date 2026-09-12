/** Ambient types so ui/server.ts can import the zero-build browser module. */

export const INSPECT_MESSAGE_TYPE: string;
export const DECK_READY_MESSAGE_TYPE: string;
export const DECK_GOTO_MESSAGE_TYPE: string;
export const DECK_STATE_MESSAGE_TYPE: string;
export const INSPECT_HOOK_SOURCE: string;
export const DECK_RUNTIME_SOURCE: string;

export function stripScripts(html: string): string;
export function appendInspectHook(html: string): string;
export function appendDeckRuntime(html: string): string;
export const PRINT_HOOK_SOURCE: string;
export function appendPrintHook(html: string): string;
export function appendSiteHooks(
  html: string,
  opts?: { deck?: boolean; inspect?: boolean; print?: boolean },
): string;
export function injectInspectHook(html: string): string;
export function formatReviewComment(
  selector: string,
  comment?: string,
  slide?: string,
): string;
export function appendReviewToInput(existing: string, line: string): string;
export function normalizeDesignEditScope(scope: unknown): { slide: string; path?: string; selector?: string } | null;
export function formatDesignEditScope(scope: unknown): string;
export function attachDesignEditScope(text: string, scope: unknown): string;
export function isInspectPick(data: unknown): boolean;
