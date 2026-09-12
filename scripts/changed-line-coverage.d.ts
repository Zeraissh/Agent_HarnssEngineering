export function coverageInclude(file: string): boolean;
export function parseLcov(text: string): Map<string, Map<number, number>>;
export function parseUnifiedDiff(text: string): Map<string, Set<number>>;
export function changedLineCoverage(opts: {
  lcovText: string;
  diffText: string;
}): {
  ok: boolean;
  uncovered: Array<{ file: string; line: number; hits: number }>;
  checked: number;
  skippedUninstrumented: number;
  missingFiles: string[];
};
export function gitDiff(base: string, cwd?: string): string;
