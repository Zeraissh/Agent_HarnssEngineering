import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, formatRange } from "../src/range.js";
import { sum, avg, rangeSum } from "../src/stats.js";

test("parseRange 常规区间 1-4", () => {
  assert.deepEqual(parseRange("1-4"), [1, 2, 3, 4]);
});

test("parseRange 单点区间 3-3", () => {
  assert.deepEqual(parseRange("3-3"), [3]);
});

test("parseRange 拒绝非法格式", () => {
  assert.throws(() => parseRange("abc"), TypeError);
});

test("formatRange 往返", () => {
  assert.equal(formatRange([1, 2, 3]), "1-3");
  assert.equal(formatRange([]), "");
});

test("sum 与 avg", () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(avg([1, 2, 3]), 2);
});

test("rangeSum 组合", () => {
  assert.equal(rangeSum("1-4"), 10);
});
