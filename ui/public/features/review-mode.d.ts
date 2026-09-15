/** Ambient types so ui/server.ts can import the zero-build browser module. */

export const INSPECT_MESSAGE_TYPE: string;
export const INSPECT_SET_MESSAGE_TYPE: string;
export const DECK_READY_MESSAGE_TYPE: string;
export const DECK_GOTO_MESSAGE_TYPE: string;
export const DECK_STATE_MESSAGE_TYPE: string;
export const WEBGL_STATUS_MESSAGE_TYPE: string;
export const HIDDEN_ATTR_FIX_CSS: string;
export const HIDDEN_ATTR_FIX_TAG: string;
export const INSPECT_HOOK_SOURCE: string;
export function buildInspectHookSource(opts?: { startOn?: boolean }): string;
export function isInspectSet(data: unknown): boolean;
export function isReviewChrome(el: { closest?: (sel: string) => unknown } | null): boolean;
export function isReviewOverlay(el: { closest?: (sel: string) => unknown } | null): boolean;
export function shouldSkipInvisibleMaterial(obj: { visible?: boolean; material?: { visible?: boolean } | { visible?: boolean }[] } | null): boolean;
export function formatObject3dReview(obj: unknown): { selector: string; text: string };
export const DECK_VISIBILITY_CSS: string;
export const DECK_RUNTIME_SOURCE: string;
export const WEBGL_PROBE_SOURCE: string;

export function stripScripts(html: string): string;
export function appendInspectHook(html: string, opts?: { startOn?: boolean }): string;
export function appendDeckRuntime(html: string): string;
export function appendWebglProbe(html: string): string;
export function appendHiddenAttrFix(html: string): string;
export const PRINT_HOOK_SOURCE: string;
export function appendPrintHook(html: string): string;
export function appendSiteHooks(
  html: string,
  opts?: { deck?: boolean; inspect?: boolean; inspectRuntime?: boolean; print?: boolean; katex?: boolean; webgl?: boolean },
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
