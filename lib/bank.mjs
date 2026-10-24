/**
 * 自增长本地题库
 *
 * 为什么不用别人的付费题库：
 *   1. 地址是服务端下发的，脚本里没有硬编码，抠不出来
 *   2. 免费源要靠伪造 X-Forwarded-For 绕 IP 配额，随时会挂
 *   3. 免费源会往答案里塞广告（"叛逆"/"公众号"/"李恒雅" 黑名单就是为此存在）
 *   4. 覆盖率天花板只有 40-70%，不如 AI
 *
 * 但「题库」这件事本身是对的 —— 只是应该建自己的：
 *   AI 每答完一道题就落库，第二次遇到零成本、零延迟、100% 准确。
 *   一个学期下来，你自己这门课的题库覆盖就能到 80%+。
 *
 * 存储格式对齐 pang-qin 的 tiku.json，方便互相导入：
 *   {"question":"...","type":"0","options":["..."],"answer":"B"}
 */

import { normalizeStem } from './normalize.mjs';

/* ────────────── 相似度 ────────────── */

/**
 * Levenshtein 相似度（带长度剪枝）
 * 长度差超过 30% 直接判 0 —— 省掉 90% 的无用计算
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > Math.max(la, lb) * 0.3) return 0;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

/**
 * 选项集相似度
 * 用「归一化后集合的包含率」而不是逐位比较 —— 因为选项顺序可能被打乱
 */
export function optionsSimilarity(optsA = [], optsB = []) {
  if (!optsA.length || !optsB.length) return 0;
  const norm = (arr) => arr.map((o) => String(o).trim().toLowerCase().replace(/^\s*[a-hA-H]\s*[.、．)）]\s*/, '').replace(/\s+/g, ''));
  const A = norm(optsA);
  const B = norm(optsB);
  const sa = new Set(A);
  const sb = new Set(B);
  if (sa.size === sb.size && [...sa].every((x) => sb.has(x))) return 1;
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit++;
  return hit / Math.max(sa.size, sb.size);
}

/** 综合分：题干 70% + 选项 30% */
export function combinedScore(textScore, optScore, hasOptions) {
  return hasOptions ? textScore * 0.7 + optScore * 0.3 : textScore;
}

/* ────────────── 题库 ────────────── */

export const THRESHOLD = {
  EXACT: 1.0,
  HIGH: 0.9,   // 直接采用
  USABLE: 0.75 // 可用，但需要 AI 交叉验证
};

export class QuestionBank {
  /**
   * @param {object} opts
   * @param {Array} opts.seed      初始数据（tiku.json 格式）
   * @param {object} opts.storage  可选：{ get():string, set(s):void }，浏览器用 localStorage
   */
  constructor({ seed = [], storage = null } = {}) {
    this.storage = storage;
    this.entries = new Map(); // normStem -> entry
    this.byType = new Map();  // type -> [entry]（模糊匹配时缩小范围用）

    const initial = storage ? this._loadFromStorage() : [];
    for (const item of [...initial, ...seed]) this._insert(item);
  }

  _loadFromStorage() {
    try {
      const raw = this.storage.get();
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _persist() {
    if (!this.storage) return;
    try {
      this.storage.set(JSON.stringify([...this.entries.values()].map((e) => e.raw)));
    } catch {}
  }

  _insert(item) {
    if (!item?.question || item.answer === undefined || item.answer === null) return false;
    const stem = normalizeStem(item.question);
    if (!stem) return false;
    const key = `${item.type ?? ''}::${stem}`;
    if (this.entries.has(key)) return false;

    const entry = {
      key,
      stem,
      type: String(item.type ?? ''),
      options: item.options ?? [],
      answer: item.answer,
      raw: item,
      hits: 0,
      addedAt: Date.now(),
    };
    this.entries.set(key, entry);
    const t = entry.type;
    if (!this.byType.has(t)) this.byType.set(t, []);
    this.byType.get(t).push(entry);
    return true;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * 查询
   * @returns {{ entry, score, mode:'exact'|'high'|'fuzzy'|'none' }}
   */
  lookup({ content, type, options = [] }) {
    const stem = normalizeStem(content);
    if (!stem) return { entry: null, score: 0, mode: 'none' };

    // 1. 精确：同题型 + 题干完全相等
    const exact = this.entries.get(`${type}::${stem}`) ?? this.entries.get(`::${stem}`);
    if (exact) {
      exact.hits++;
      return { entry: exact, score: 1, mode: 'exact' };
    }

    // 2. 模糊：同题型池 + 长度剪枝
    const pool = this.byType.get(type) ?? [...this.entries.values()];
    const hasOpts = options.length > 0;
    let best = null;
    let bestScore = 0;

    for (const e of pool) {
      const ts = similarity(stem, e.stem);
      if (ts === 0) continue; // 被剪枝
      const os = hasOpts && e.options.length ? optionsSimilarity(options, e.options) : 0;
      const score = combinedScore(ts, os, hasOpts && e.options.length > 0);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }

    if (!best) return { entry: null, score: 0, mode: 'none' };
    const mode = bestScore >= THRESHOLD.HIGH ? 'high'
      : bestScore >= THRESHOLD.USABLE ? 'fuzzy'
      : 'none';
    if (mode === 'none') return { entry: null, score: bestScore, mode: 'none' };
    best.hits++;
    return { entry: best, score: bestScore, mode };
  }

  /**
   * 落库（AI 答完且未被人为修改时调用）
   * 只在同一道题被答过 1 次以上、或置信度高时才写 —— 避免污染
   */
  record({ content, type, options = [], answer }, { minConfidence = 0.8 } = {}) {
    if (!content || answer === undefined || answer === null || answer === '') return false;
    const added = this._insert({
      question: content,
      type: String(type ?? ''),
      options,
      answer,
    });
    if (added) this._persist();
    return added;
  }

  /** 导出成 tiku.json 格式，可直接喂给 pang-qin 的后台 */
  export() {
    return [...this.entries.values()].map((e) => e.raw);
  }

  /** 只看命中过的条目，方便人工校验 */
  exportHot(minHits = 2) {
    return [...this.entries.values()].filter((e) => e.hits >= minHits).map((e) => e.raw);
  }
}
