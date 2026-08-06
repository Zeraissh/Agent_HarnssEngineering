/**
 * 键控列表差异——纯函数，无 DOM 依赖，可在 node 环境直测。
 *
 * 存在的理由：渲染层此前每收到一条 SSE 事件就重建整个详情页的 innerHTML。
 * 代价不是"慢"这么抽象——实测是拒绝理由输入框里的字每次被清空、
 * 焦点每 3 秒被摧毁、日志滚动位置归零。要保住这些，DOM 节点就必须**复用**，
 * 而复用的前提是先算出"哪些留、哪些走、哪些新来、谁该排在谁前面"。
 */

/**
 * @param {string[]} prevKeys 当前 DOM 中的键序
 * @param {string[]} nextKeys 目标键序
 * @returns {{
 *   keeps: string[],
 *   removes: string[],
 *   inserts: {key: string, beforeKey: string|null}[],
 *   moves: {key: string, beforeKey: string|null}[],
 *   order: string[]
 * }}
 *   - `keeps`   两边都在、且相对顺序未变的键（节点原地复用，不动）
 *   - `removes` 只在 prev 中的键（节点删除）
 *   - `inserts` 只在 next 中的键；`beforeKey` = 应插到哪个键之前，null = 追加到末尾
 *   - `moves`   两边都在但相对顺序变了的键；语义同 inserts
 *   - `order`   目标顺序，供应用层做最终校验
 */
export function diffKeyed(prevKeys, nextKeys) {
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);

  const removes = prevKeys.filter((k) => !nextSet.has(k));

  // 只保留仍然存在的旧键，再与新键序比对相对顺序——这样"因为前面有元素被删掉
  // 而整体前移"不会被误判成 move
  const survivors = prevKeys.filter((k) => nextSet.has(k));
  const common = nextKeys.filter((k) => prevSet.has(k));

  // 最长公共子序列：落在其中的键相对顺序未变，可以不动
  const stable = new Set(longestCommonSubsequence(survivors, common));

  const inserts = [];
  const moves = [];
  const keeps = [];

  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i];
    const beforeKey = i + 1 < nextKeys.length ? nextKeys[i + 1] : null;
    if (!prevSet.has(key)) {
      inserts.push({ key, beforeKey });
    } else if (stable.has(key)) {
      keeps.push(key);
    } else {
      moves.push({ key, beforeKey });
    }
  }

  return { keeps, removes, inserts, moves, order: [...nextKeys] };
}

/** 标准 LCS（列表长度在本项目里是几十量级，O(n·m) 完全够用） */
function longestCommonSubsequence(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * 廉价签名：把一个区域的渲染依赖压成字符串，相等即跳过重绘。
 * 只接受标量——对象请自行摘要，别在这里做深比较（那就失去廉价的意义了）。
 * @param {(string|number|boolean|null|undefined)[]} parts
 * @returns {string}
 */
export function signature(parts) {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
}
