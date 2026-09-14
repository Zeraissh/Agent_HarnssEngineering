/** Ambient types so ui/server.ts can import the zero-build browser module. */

export const INSPECT_MESSAGE_TYPE: string;
export const DECK_READY_MESSAGE_TYPE: string;
export const DECK_GOTO_MESSAGE_TYPE: string;
export const DECK_STATE_MESSAGE_TYPE: string;
export const WEBGL_STATUS_MESSAGE_TYPE: string;
export const HIDDEN_ATTR_FIX_CSS: string;
export const HIDDEN_ATTR_FIX_TAG: string;
export const INSPECT_HOOK_SOURCE: string;
export const DECK_VISIBILITY_CSS: string;
export const DECK_RUNTIME_SOURCE: string;
export const WEBGL_PROBE_SOURCE: string;

export function stripScripts(html: string): string;
export function appendInspectHook(html: string): string;
export function appendDeckRuntime(html: string): string;
export function appendWebglProbe(html: string): string;
export function appendHiddenAttrFix(html: string): string;
export const PRINT_HOOK_SOURCE: string;
export function appendPrintHook(html: string): string;
export function appendSiteHooks(
  html: string,
  opts?: { deck?: boolean; inspect?: boolean; print?: boolean; katex?: boolean; webgl?: boolean },
): string;
export function injectInspectHook(html: string): string;
export function isWebglStatus(data: unknown): boolean;
export function formatReviewComment(
  selector: string,
  comment?: string,
  slide?: string,
): string;
export function isWholeDeckRevision(text: string): boolean;
export function stripSlideLockMarkers(text: string): string;
export function appendReviewToInput(existing: string, line: string): string;
export function isInspectPick(data: unknown): boolean;
