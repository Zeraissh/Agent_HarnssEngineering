/** 解析 "a-b" 形式的整数区间（含两端），如 "1-4" → [1,2,3,4]。 */
export function parseRange(spec) {
  const m = /^(\d+)-(\d+)$/.exec(spec.trim());
  if (!m) throw new TypeError(`bad range spec: ${spec}`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  const out = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** 把数组还原为 "a-b" 表示；空数组返回空串。 */
export function formatRange(values) {
  if (values.length === 0) return "";
  return `${values[0]}-${values[values.length - 1]}`;
}
