import { parseRange } from "./range.js";

export function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

export function avg(values) {
  if (values.length === 0) throw new RangeError("avg of empty array");
  return sum(values) / values.length;
}

export function rangeSum(spec) {
  return sum(parseRange(spec));
}
