/**
 * 解析 + 投票 + 编排
 *
 * 这一层的价值：把「LLM 输出不可靠」这个不确定性，转成「可度量的置信度」。
 */

import { answerKey, normalizeAnswer, QTYPE } from './normalize.mjs';
import { buildSystemPrompt, buildUserPrompt } from './prompt.mjs';

/* ────────────── 容错 JSON 解析 ────────────── */

/**
 * LLM 输出 → answers 数组
 *
 * 这是自动答题最脆弱的一环。真实会遇到的脏数据：
 *   ```json\n{...}\n```          markdown 围栏
 *   好的，以下是答案：{...}        前置寒暄
 *   {"answers":[...]} 以上。       后置说明
 *   {"a":1,}                     尾逗号
 *   {'answer':'A'}               单引号
 *   {“answers”：[...]}           中文标点
 *   <answer>...</answer>          XML 包裹
 */
export function extractJson(raw) {
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object') return raw;
    return null;
  }
  let s = raw.trim();

  // 1. 剥 markdown 围栏（包括 ```json / ```JSON）
  s = s.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
  // 2. 去 XML 标签
  s = s.replace(/<\/?(answer|result|output)[^>]*>/gi, '');

  // 3. 直接试
  const tryParse = (t) => {
    try { return JSON.parse(t); } catch { return undefined; }
  };

  let v = tryParse(s);
  if (v !== undefined) return v;

  // 4. 截取最外层 { } 或 [ ]
  const firstCurly = s.indexOf('{');
  const lastCurly = s.lastIndexOf('}');
  if (firstCurly >= 0 && lastCurly > firstCurly) {
    v = tryParse(s.slice(firstCurly, lastCurly + 1));
    if (v !== undefined) return v;
  }
  // 4b. 只有在整段以 [ 开头时，才把裸数组当答案
  //     否则会误伤 {"answers":[]} 这种（先去截 [] 会得到空数组）
  if (s.trimStart().startsWith('[')) {
    const firstSq = s.indexOf('[');
    const lastSq = s.lastIndexOf(']');
    if (firstSq >= 0 && lastSq > firstSq) {
      v = tryParse(s.slice(firstSq, lastSq + 1));
      if (v !== undefined) return v;
    }
  }

  // 5. 修复常见破损后重试
  let fixed = (firstCurly >= 0 && lastCurly > firstCurly ? s.slice(firstCurly, lastCurly + 1) : s)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    // 尾逗号
    .replace(/,\s*([}\]])/g, '$1')
    // 单引号 key/value
    .replace(/'([^'\\]*)'/g, '"$1"');

  // 5b. 括号不配对时补齐（LLM 被截断会这样）
  const balanced = balanceBrackets(fixed);
  v = tryParse(balanced);
  if (v !== undefined) return v;
  v = tryParse(fixed);
  if (v !== undefined) return v;

  // 6. 彻底失败 —— 交给 regex 兜底（在 parseAnswers 里）
  return null;
}

/** 补上缺失的闭合括号 */
function balanceBrackets(text) {
  let curly = 0;
  let square = 0;
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }
  let out = text;
  // 先补方括号再补花括号（数组通常在对象里）
  if (square > 0) out += ']'.repeat(square);
  if (curly > 0) out += '}'.repeat(curly);
  // 被截断在字符串中间 → 补引号
  if (inStr) out += '"';
  return out;
}

/**
 * 从解析结果里取出 answers 数组
 * 兼容 {answers:[...]} / {data:[...]} / 裸数组
 */
function pickAnswersArray(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;
  for (const k of ['answers', 'data', 'result', 'list']) {
    if (Array.isArray(parsed[k])) return parsed[k];
  }
  // {"q1":"A","q2":["A","C"]} 这种扁平 map
  const keys = Object.keys(parsed);
  if (keys.length && keys.every((k) => typeof parsed[k] !== 'object' || Array.isArray(parsed[k]))) {
    return keys.map((k) => ({ id: k, answer: parsed[k] }));
  }
  return null;
}

/**
 * 正则兜底：JSON 彻底崩了也要尽量捞回答案
 * 匹配  "id":"q1" ... "answer":"A"
 */
function regexSalvage(raw, questions) {
  const out = [];
  const text = String(raw);
  for (const q of questions) {
    const id = q.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 该 id 附近 200 字符内找 answer
    const re = new RegExp(`"${id}"[\\s\\S]{0,200}?"answer"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]|null|true|false)`, 'i');
    const m = text.match(re);
    if (m) {
      try {
        out.push({ id: q.id, answer: JSON.parse(m[1]), _salvaged: true });
      } catch {
        out.push({ id: q.id, answer: m[1].replace(/^"|"$/g, ''), _salvaged: true });
      }
    }
  }
  return out.length ? out : null;
}

/**
 * 单次 provider 输出 → 结构化答案列表
 */
export function parseProviderOutput(raw, questions) {
  let parsed = extractJson(raw);
  let arr = pickAnswersArray(parsed);
  if (!arr) {
    arr = regexSalvage(raw, questions);
  }
  if (!arr) {
    return { ok: false, answers: [], reason: 'unparseable' };
  }

  const byId = new Map();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? item.qid ?? item.questionId ?? '').trim();
    if (!id) continue;
    byId.set(id, item);
  }

  const answers = [];
  const missing = [];
  for (const q of questions) {
    const item = byId.get(q.id);
    if (!item) { missing.push(q.id); continue; }
    const conf = typeof item.confidence === 'number'
      ? Math.max(0, Math.min(1, item.confidence > 1 ? item.confidence / 100 : item.confidence))
      : null;
    answers.push({
      id: q.id,
      raw: item.answer,
      confidence: conf,
      brief: item.brief ?? item.reasoning ?? '',
    });
  }
  return { ok: true, answers, missing, reason: missing.length ? 'partial' : 'ok' };
}

/* ────────────── 投票 ────────────── */

/**
 * 加权多数决
 *
 * 规则（这三条的顺序很关键，写反就会出错）：
 *   1. 先按归一化后的答案分桶
 *   2. 胜出：桶内票数(count)最多
 *   3. 平票时：比桶内权重和(totalWeight)
 *
 * 为什么"票数优先、权重裁平票"，而不是直接比权重和？
 * 因为直接比权重时，一个权重 2.0 的模型能压过两个权重 1.0 的模型 ——
 * 那就退化成"单模型"了，投票失去意义。
 */
export function vote(question, candidates, providerWeights = {}) {
  // ── 主观题特殊处理 ──
  // 简答题/名词解释是自由文本，三个模型给出的措辞必然不同。
  // 如果按字符串分桶投票，永远会判成"三家各不相同 → 平票"，
  // 那投票不但没帮助，反而把置信度打到 0.5 以下。
  // 正确做法：选「置信度最高」的那一份，并把置信度打折（因为无法交叉验证）。
  if (question.type === QTYPE.QA) {
    const valid = candidates
      .map((c) => ({ ...c, norm: normalizeAnswer(question, c.raw) }))
      .filter((c) => c.norm.ok);
    if (!valid.length) {
      return {
        id: question.id, answer: null, confidence: 0, votes: 0,
        totalProviders: candidates.length, agree: 0, conflict: false,
        reason: 'no_valid_candidate',
      };
    }
    // 排序：置信度优先，同分取更完整的（长度）
    valid.sort((a, b) => {
      const ca = (a.confidence ?? 0.7) * (providerWeights[a.providerId] ?? 1);
      const cb = (b.confidence ?? 0.7) * (providerWeights[b.providerId] ?? 1);
      if (Math.abs(cb - ca) > 0.05) return cb - ca;
      return String(b.norm.answer).length - String(a.norm.answer).length;
    });
    const best = valid[0];
    const base = (best.confidence ?? 0.7) * 0.9; // 主观题打折
    return {
      id: question.id,
      answer: best.norm.answer,
      confidence: Math.round(Math.max(0.3, Math.min(0.85, base)) * 100) / 100,
      votes: 1,
      totalProviders: candidates.length,
      agree: 1 / valid.length,
      conflict: false,
      reason: 'qa_pick',
      supporters: [best.providerId],
      notes: ['subjective_unsupervised'],
    };
  }

  const buckets = new Map();

  for (const c of candidates) {
    const norm = normalizeAnswer(question, c.raw);
    if (!norm.ok) continue;
    const key = answerKey(norm.answer);
    const base = providerWeights[c.providerId] ?? 1.0;
    const conf = c.confidence ?? 0.7; // 没给置信度的按 0.7，低于默认值
    const w = base * conf;

    const b = buckets.get(key);
    if (b) {
      b.count += 1;
      b.weight += w;
      b.supporters.push(c.providerId);
    } else {
      buckets.set(key, {
        answer: norm.answer,
        count: 1,
        weight: w,
        supporters: [c.providerId],
        notes: norm.notes,
      });
    }
  }

  const list = [...buckets.values()].sort((a, b) =>
    b.count - a.count || b.weight - a.weight
  );

  const total = candidates.length;
  const winner = list[0];

  if (!winner) {
    return {
      id: question.id,
      answer: null,
      confidence: 0,
      votes: 0,
      totalProviders: total,
      agree: 0,
      conflict: false,
      reason: 'no_valid_candidate',
    };
  }

  // 一致性：胜出桶票数 / 有效票数
  const validVotes = list.reduce((s, b) => s + b.count, 0);
  const agree = winner.count / Math.max(1, validVotes);

  // 置信度合成：
  //   - 全票通过 → 0.92（不吹成 1.0，给下游门控留余量）
  //   - 2:1     → 0.72
  //   - 3:1     → 0.80
  //   - 更低一致度 → 线性衰减
  let confidence;
  if (agree >= 0.999) confidence = 0.92;
  else if (agree >= 0.75) confidence = 0.80;
  else if (agree >= 0.6) confidence = 0.72;
  else confidence = 0.50 + agree * 0.2;

  return {
    id: question.id,
    answer: winner.answer,
    confidence: Math.round(confidence * 100) / 100,
    votes: winner.count,
    totalProviders: total,
    agree: Math.round(agree * 100) / 100,
    conflict: list.length > 1 && winner.count === list[1].count,
    reason: list.length > 1 ? 'majority' : 'unanimous',
    supporters: winner.supporters,
    notes: winner.notes ?? [],
  };
}

/* ────────────── 编排 ────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * 单 provider 调用（带超时，AbortController）
 * provider 签名：async (systemPrompt, userPrompt, { signal }) => string
 */
async function callProvider(provider, system, user, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const text = await provider.fn(system, user, { signal: controller.signal });
    return { ok: true, text, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 主流程：多模型并发 → 解析 → 投票
 *
 * @param {Array} questions
 * @param {object} opts
 * @param {Array<{id,name,fn,weight}>} opts.providers
 * @param {number} opts.timeoutMs      单 provider 超时，默认 60s
 * @param {boolean} opts.askConfidence 是否要求置信度
 * @param {function} opts.onProgress   进度回调
 */
export async function solveBatch(questions, opts = {}) {
  const {
    providers = [],
    timeoutMs = 60_000,
    askConfidence = true,
    onProgress = () => {},
  } = opts;

  if (!providers.length) throw new Error('solveBatch: 至少需要一个 provider');
  if (!questions.length) return { results: [], stats: {} };

  const system = buildSystemPrompt();
  const user = buildUserPrompt(questions, { askConfidence });

  onProgress({ phase: 'query', providers: providers.length, questions: questions.length });

  const settled = await Promise.all(
    providers.map(async (p) => ({
      provider: p,
      ...(await callProvider(p, system, user, timeoutMs)),
    }))
  );

  const weights = Object.fromEntries(providers.map((p) => [p.id, p.weight ?? 1.0]));
  const perQuestion = new Map(questions.map((q) => [q.id, []]));
  const diagnostics = [];

  for (const r of settled) {
    if (!r.ok) {
      diagnostics.push({ provider: r.provider.id, ok: false, ms: r.ms, error: r.error });
      continue;
    }
    const parsed = parseProviderOutput(r.text, questions);
    diagnostics.push({
      provider: r.provider.id,
      ok: parsed.ok,
      ms: r.ms,
      got: parsed.answers?.length ?? 0,
      missing: parsed.missing?.length ?? 0,
      reason: parsed.reason,
    });
    for (const a of parsed.answers ?? []) {
      perQuestion.get(a.id)?.push({ ...a, providerId: r.provider.id });
    }
  }

  onProgress({ phase: 'vote' });

  const results = questions.map((q) => {
    const cands = perQuestion.get(q.id) ?? [];
    return vote(q, cands, weights);
  });

  const stats = {
    total: results.length,
    answered: results.filter((r) => r.answer !== null).length,
    unanimous: results.filter((r) => r.reason === 'unanimous').length,
    majority: results.filter((r) => r.reason === 'majority').length,
    qaPick: results.filter((r) => r.reason === 'qa_pick').length,
    conflict: results.filter((r) => r.conflict).length,
    failed: results.filter((r) => r.reason === 'no_valid_candidate').length,
    avgConfidence: Math.round(
      (results.reduce((s, r) => s + r.confidence, 0) / Math.max(1, results.length)) * 100
    ) / 100,
    providers: diagnostics,
  };

  onProgress({ phase: 'done', stats });
  return { results, stats };
}

export { sleep, jitter };
