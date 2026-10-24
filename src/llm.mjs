/**
 * llm.mjs — Android 端解题桥
 *
 * 复用 chaoxing_solver 的内核（90 项测试已验证），只补两件事：
 *   1. Node 环境的 provider 构造（和扩展的 sw.js 同构，便于行为一致）
 *   2. 单 key 自动派生第二个温度采样，让自一致性投票生效
 */
import { solveBatch } from '../lib/solver.mjs';
import { QuestionBank } from '../lib/bank.mjs';

const BANK_MIN_CONF = 0.85;

/**
 * 免费档 API 的核心矛盾：不要钱，但限速狠。
 *
 * 智谱 GLM-Flash 免费档、硅基流动免费模型都会在并发或短时高频时直接抛 429
 * （而不是排队），5xx 也偶发。考试时一次 429 没重试，就是整整一题没有答案。
 *
 * 所以这里必须做退避重试，且要认 Retry-After。
 * 注意：只重试「可重试」的状态码，401/400 重试一万次也没用，要立刻报错。
 */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(doFetch, body, { tries = 4 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const res = await doFetch(body);
    if (res.ok) return res;

    const status = res.status;
    if (!RETRYABLE.has(status) || i === tries - 1) return res;

    // Retry-After 可能是秒数，也可能是 HTTP 日期；两种都认，认不出就用指数退避
    const ra = res.headers.get('retry-after');
    let waitMs = Math.min(8000, 600 * 2 ** i);
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs > 0) waitMs = Math.min(15000, secs * 1000);
      else {
        const at = Date.parse(ra);
        if (Number.isFinite(at)) waitMs = Math.min(15000, Math.max(500, at - Date.now()));
      }
    }
    // 免费档常见的 429 提示会带具体秒数，抓一把
    const hint = await res.clone().text().catch(() => '');
    const m = hint.match(/retry[^0-9]{0,20}(\d+)\s*(?:s|秒)/i);
    if (m) waitMs = Math.min(15000, Number(m[1]) * 1000);

    lastErr = `HTTP ${status}`;
    await sleep(waitMs);
  }
  if (lastErr) throw new Error(`${lastErr}（重试 ${tries} 次仍失败，免费档限速）`);
  throw new Error('请求失败');
}

/**
 * 英文题型 → 中文标签。
 * 两个字段都要传：type 给归一化用（必须英文），typeName 给模型看（中文更准）。
 */
const TYPE_CN = {
  single: '单选题', multiple: '多选题', judge: '判断题',
  fill: '填空题', wordfill: '选词填空', qa: '简答题', composite: '材料题',
};

function buildProvider(p, tempOverride, suffix = '') {
  return {
    id: p.id + suffix,
    name: `${p.name}${suffix ? '·采样2' : ''}`,
    weight: suffix ? (p.weight ?? 1) * 0.95 : (p.weight ?? 1),
    fn: async (system, user, { signal }) => {
      const url = `${p.baseURL.replace(/\/+$/, '')}/chat/completions`;
      const body = {
        model: p.model,
        // 必须低温：默认 0.7 会让同题多次答案漂移，投票直接失效
        temperature: tempOverride ?? p.temperature ?? 0.2,
        top_p: 0.9,
        max_tokens: p.maxTokens ?? 3000,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      if (p.jsonMode !== false) body.response_format = { type: 'json_object' };

      const doFetch = (b) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p.apiKey}`,
          },
          body: JSON.stringify(b),
          signal,
        });

      // 免费档必走重试版；限速时退避等待，而不是整题丢答案
      let res = await fetchWithRetry(doFetch, body, { tries: p.maxRetries ?? 4 });
      // 只有「请求形态不被接受」才去掉 json_object 重来。
      // 429 也去掉 json_object 重试的话，等于在限速时又砸 2 个请求，只会更糟。
      if ((res.status === 400 || res.status === 422) && body.response_format) {
        delete body.response_format;  // 部分中转/免费模型不支持 json_object
        res = await fetchWithRetry(doFetch, body, { tries: 2 });
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 160)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('空响应');
      return content;
    },
  };
}

/**
 * key 到底能不能用。
 * 必须挡住占位符 —— 否则用户忘了改，自检会「假通过」，
 * 等到考场才发现 401，代价太大。
 */
const PLACEHOLDER_KEY =
  /在这里|你的\s*key|your[\s_-]*api[\s_-]*key|your[\s_-]*key|api[\s_-]*key[\s_-]*here|placeholder|请填|待填|TODO|^sk-x+$|^xxx+$|^<.*>$/i;

export function isUsableKey(key) {
  if (!key || typeof key !== 'string') return false;
  const t = key.trim();
  if (t.length < 12) return false;
  return !PLACEHOLDER_KEY.test(t);
}

export function makeProviders(cfg) {
  const active = (cfg.providers || []).filter(
    (p) => p.enabled !== false && p.model && isUsableKey(p.apiKey)
  );
  if (!active.length) {
    throw new Error('还没配置可用的 API Key。把 config.example.json 复制为 config.json，填入真实 key。');
  }
  const out = active.map((p) => buildProvider(p));
  // 单 key 自动补第二个采样，否则多选题漏选无法通过投票纠正
  if (out.length === 1) out.push(buildProvider(active[0], 0.45, '_s2'));
  return out;
}

/** 内存题库（考试期间同一份卷子会重复出现，命中就零成本） */
export function makeBank(dir) {
  let raw = null;
  const storage = {
    get: () => raw,
    set: (s) => { raw = s; },
  };
  return new QuestionBank({ storage });
}

/**
 * 解一批题
 * @param {Array} questions  uia.mjs 抽出的题目
 * @param {object} cfg       配置
 * @param {QuestionBank} bank
 */
export async function solveQuestions(questions, cfg, bank = null) {
  const results = new Map();
  const pending = [];

  if (bank) {
    for (const q of questions) {
      const hit = bank.lookup({
        content: q.stem,
        type: q.type,
        options: q.options.map((o) => o.text),
      });
      if (hit && hit.score >= 0.9 && hit.entry?.answer != null) {
        results.set(q.key, {
          id: q.key,
          answer: hit.entry.answer,
          confidence: 1.0,
          reason: 'bank',
        });
      } else pending.push(q);
    }
  } else pending.push(...questions);

  const diagnostics = [];
  if (pending.length) {
    const providers = makeProviders(cfg);
    const BATCH = cfg.batchSize ?? 12;

    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH);
      try {
        const { results: rs, stats } = await solveBatch(
          // 字段必须对齐内核的序列化契约（prompt.mjs 的 serializeQuestions）：
          //   content → 题干（不是 stem）
          //   options → [{label, text}] 对象数组（不是字符串数组）
          //   blankCount → 空位数（不是 blanks）
          // 传错字段不会报错，模型只会收到空的题干 —— 这是最难发现的一类 bug。
          chunk.map((q) => ({
            id: q.key,
            type: q.type,                    // 英文，归一化分支用
            typeName: TYPE_CN[q.type] ?? q.type,  // 中文，给模型看
            content: q.stem,
            options: q.options.map((o) => ({ label: o.label, text: o.text })),
            blankCount: q.blanks ?? 1,
          })),
          { providers, timeoutMs: cfg.timeoutMs ?? 60000 }
        );
        rs.forEach((r) => results.set(r.id, r));
        diagnostics.push(stats);
      } catch (e) {
        chunk.forEach((q) =>
          results.set(q.key, { id: q.key, answer: null, confidence: 0, reason: 'error', error: e.message })
        );
        diagnostics.push({ error: e.message });
      }
    }

    if (bank) {
      for (const q of pending) {
        const r = results.get(q.key);
        if (r && r.answer != null && r.confidence >= BANK_MIN_CONF) {
          try {
            bank.record(
              {
                question: q.stem,
                type: q.type,
                options: q.options.map((o) => o.text),
                answer: r.answer,
              },
              { minConfidence: BANK_MIN_CONF }
            );
          } catch (_) {}
        }
      }
    }

    /* ── 解析失败兜底重试 ────────────────────────────────
     * 真机实测（2026-10-24）：整批 12 题里偶尔有 1 题拿到 answer=null，
     * 内核原因是 no_valid_candidate —— 模型答了，但输出没法归一化成
     * 选项字母（整批输出里格式跑偏/被截断）。整批重问常常还是同样的
     * 格式问题，所以改成【单题单发】再问一次：上下文更短、输出更规整，
     * 成功率明显更高。只对本批失败题做一次，成本可控。 */
    const failed = pending.filter((q) => {
      const r = results.get(q.key);
      return r && r.answer == null && r.reason !== 'error';
    });
    for (const q of failed.slice(0, 8)) {
      try {
        const { results: rs2 } = await solveBatch(
          [
            {
              id: q.key,
              type: q.type,
              typeName: TYPE_CN[q.type] ?? q.type,
              content: q.stem,
              options: q.options.map((o) => ({ label: o.label, text: o.text })),
              blankCount: q.blanks ?? 1,
            },
          ],
          { providers, timeoutMs: cfg.timeoutMs ?? 60000 }
        );
        const r2 = rs2[0];
        if (r2 && r2.answer != null) {
          results.set(q.key, { ...r2, reason: 'retry' });
        }
      } catch (_) {
        /* 重试也失败就交给上层跳过逻辑，不再纠缠 */
      }
    }
  }

  return questions.map((q) => results.get(q.key) ?? { id: q.key, answer: null, confidence: 0, reason: 'missing' });
}
