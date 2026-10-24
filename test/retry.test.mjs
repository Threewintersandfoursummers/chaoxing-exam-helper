/**
 * retry.test.mjs — 免费档限速（429）重试验证
 *
 * 这个测试存在的意义：免费 API 的失败模式几乎全是 429，
 * 而 429 一旦没重试，考试时就是整整一题空白，且不会报错。
 */
import assert from 'node:assert';
import { makeProviders, isUsableKey } from '../src/llm.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const realFetch = globalThis.fetch;
const jsonRes = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const okBody = {
  choices: [{ message: { content: '{"answers":[{"id":"q1","answer":["A"],"confidence":0.9}]}' } }],
};

const mkCfg = (over = {}) => ({
  providers: [
    {
      id: 'free', name: 'free', baseURL: 'https://x.test/v1',
      model: 'm', apiKey: 'sk-abcdef123456', weight: 1,
      ...over,
    },
  ],
});

console.log('\n═══ 429 重试 ═══');

await t('429 一次后成功 → 自动重试拿到答案', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) return jsonRes(429, { error: { message: '请求过于频繁' } }, { 'retry-after': '0.05' });
    return jsonRes(200, okBody);
  };
  const [p] = makeProviders(mkCfg());
  const out = await p.fn('sys', 'user', {});
  assert.ok(out.includes('answers'), '应返回内容');
  assert.equal(n, 2, `应请求 2 次，实际 ${n}`);
});

await t('连续 503 三次后成功', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n <= 3) return jsonRes(503, { error: 'busy' });
    return jsonRes(200, okBody);
  };
  const [p] = makeProviders(mkCfg({ maxRetries: 5 }));
  const out = await p.fn('sys', 'user', {});
  assert.ok(out.includes('answers'));
  assert.equal(n, 4, `应请求 4 次，实际 ${n}`);
});

await t('401 不重试，立即报错（重试无意义，还会拖到考完）', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return jsonRes(401, { error: 'invalid api key' }); };
  const [p] = makeProviders(mkCfg());
  await assert.rejects(() => p.fn('sys', 'user', {}), /HTTP 401/);
  assert.ok(n <= 2, `401 不该反复重试，实际 ${n} 次`);
});

await t('400 会去掉 json_object 重来一次', async () => {
  const seen = [];
  globalThis.fetch = async (_u, opt) => {
    const b = JSON.parse(opt.body);
    seen.push(Boolean(b.response_format));
    if (b.response_format) return jsonRes(400, { error: 'response_format unsupported' });
    return jsonRes(200, okBody);
  };
  const [p] = makeProviders(mkCfg());
  const out = await p.fn('sys', 'user', {});
  assert.ok(out.includes('answers'));
  assert.deepEqual(seen, [true, false], '第二次应已去掉 response_format');
});

await t('429 打满重试次数 → 报明确原因，不是裸 HTTP', async () => {
  globalThis.fetch = async () => jsonRes(429, { error: 'rate limit' }, { 'retry-after': '0' });
  const [p] = makeProviders(mkCfg({ maxRetries: 2 }));
  await assert.rejects(
    () => p.fn('sys', 'user', {}),
    (e) => /429/.test(e.message) || /限速/.test(e.message),
    '错误信息里要能看出是限速'
  );
});

console.log('\n═══ Key 有效性 ═══');

await t('占位符 key 被拒（防考场 401）', async () => {
  for (const k of ['sk-在这里填你的key', '', 'short', 'sk-xxxxxxxxxxxxx', 'your-api-key-here']) {
    assert.equal(isUsableKey(k), false, `应拒绝：「${k}」`);
  }
});

await t('真实格式 key 通过', async () => {
  for (const k of ['sk-abcdef1234567890', 'a1b2c3d4e5f6g7h8j9k0']) {
    assert.equal(isUsableKey(k), true, `应通过：「${k}」`);
  }
});

globalThis.fetch = realFetch;

console.log(`\n${'─'.repeat(58)}\n通过 ${pass} · 失败 ${fail}`);
if (fail) process.exit(1);
