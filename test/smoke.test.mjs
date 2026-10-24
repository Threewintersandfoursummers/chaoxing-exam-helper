/**
 * smoke.test.mjs — 端到端链路验证
 *
 * 串起真实数据流：UI XML → 抽题 → 模型调用 → 归一化 → 投票 → 答案
 * 模型用 mock 替代（不烧 token），但走的是同一条 solver 代码路径。
 *
 * 这是唯一能验证「解析出来的题目能正确喂进答题内核」的测试 ——
 * 前面的测试各自验证一半，中间的字段对接错了照样全绿。
 */
import { extractQuestions } from '../src/uia.mjs';
import { solveQuestions } from '../src/llm.mjs';

let pass = 0, fail = 0;
const failures = [];
const ok = (c, n, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' → ' + d : ''}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

/* ══════════════ 样本 ══════════════ */

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" bounds="[0,0][1080,2400]">
    <node index="0" text="1." class="android.widget.TextView" bounds="[42,300][90,356]" />
    <node index="1" text="（单选题）" class="android.widget.TextView" bounds="[96,300][230,356]" />
    <node index="2" text="根据《建筑法》，建筑施工企业应当坚持的安全生产方针是？" class="android.widget.TextView" bounds="[42,370][1038,500]" />
    <node index="3" text="A、质量优先、安全为辅" class="android.widget.TextView" clickable="true" bounds="[42,540][1038,620]" />
    <node index="4" text="B、安全第一、预防为主" class="android.widget.TextView" clickable="true" bounds="[42,640][1038,720]" />
    <node index="5" text="C、效益优先、兼顾安全" class="android.widget.TextView" clickable="true" bounds="[42,740][1038,820]" />
    <node index="6" text="D、进度第一、安全第二" class="android.widget.TextView" clickable="true" bounds="[42,840][1038,920]" />
    <node index="7" text="2." class="android.widget.TextView" bounds="[42,980][90,1036]" />
    <node index="8" text="（多选题）" class="android.widget.TextView" bounds="[96,980][230,1036]" />
    <node index="9" text="TCP 三次握手涉及以下哪些标志位？" class="android.widget.TextView" bounds="[42,1050][1038,1180]" />
    <node index="10" text="A、SYN" class="android.widget.TextView" clickable="true" bounds="[42,1220][1038,1300]" />
    <node index="11" text="B、ACK" class="android.widget.TextView" clickable="true" bounds="[42,1320][1038,1400]" />
    <node index="12" text="C、FIN" class="android.widget.TextView" clickable="true" bounds="[42,1420][1038,1500]" />
    <node index="13" text="D、RST" class="android.widget.TextView" clickable="true" bounds="[42,1520][1038,1600]" />
    <node index="14" text="3." class="android.widget.TextView" bounds="[42,1660][90,1716]" />
    <node index="15" text="（判断题）" class="android.widget.TextView" bounds="[96,1660][230,1716]" />
    <node index="16" text="HTTP 协议是无状态协议。" class="android.widget.TextView" bounds="[42,1730][1038,1830]" />
    <node index="17" text="A、正确" class="android.widget.TextView" clickable="true" bounds="[42,1870][1038,1950]" />
    <node index="18" text="B、错误" class="android.widget.TextView" clickable="true" bounds="[42,1960][1038,2040]" />
  </node>
</hierarchy>`;

/* ══════════════ Mock 模型 ══════════════ */

let fetchCalls = 0;
const seenPrompts = [];

global.fetch = async (url, opts) => {
  fetchCalls++;
  const body = JSON.parse(opts.body);
  const userMsg = body.messages.find((m) => m.role === 'user')?.content || '';
  seenPrompts.push(userMsg);

  // 从 prompt 里捞出题目 id（顺序与题目顺序一致）
  const ids = [...userMsg.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);

  // 按题目内容给答案：第1题B / 第2题ABD / 第3题错误
  const answers = ids.map((id, i) => {
    if (i === 0) return { id, answer: 'B', confidence: 0.95, brief: '安全第一' };
    if (i === 1) return { id, answer: ['A', 'B', 'D'], confidence: 0.9, brief: '三次握手' };
    return { id, answer: '错误', confidence: 0.92, brief: '有状态' };
  });

  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '```json\n' + JSON.stringify({ answers }) + '\n```' } }],
    }),
    text: async () => '',
  };
};

/* ══════════════ 跑 ══════════════ */

console.log('══════ 端到端：XML → 抽题 → 模型 → 答案 ══════');

// 1. 抽题
const { questions, strategy } = extractQuestions(XML);
eq(questions.length, 3, '抽出 3 题');
eq(strategy, 'node', '走节点策略');

// 2. 挂 key（main.mjs 里做的事）
const crypto = await import('node:crypto');
for (const q of questions) {
  q.key = crypto.createHash('sha1').update(`${q.type}|${q.stem}`).digest('hex').slice(0, 10);
}
ok(questions.every((q) => q.key && q.key.length === 10), '每题都有稳定 key');
eq(new Set(questions.map((q) => q.key)).size, 3, 'key 互不相同');

// 3. 解题（走真实 solver 路径，含双 provider 采样）
const cfg = {
  providers: [{
    id: 'mock', name: 'Mock', baseURL: 'https://mock.local/v1',
    model: 'mock-model', apiKey: 'sk-mock-1234567890', enabled: true, weight: 1.0,
  }],
  timeoutMs: 15000,
};

const results = await solveQuestions(questions, cfg, null);

eq(results.length, 3, '返回 3 个结果');
ok(fetchCalls >= 2, `单 key 自动派生双采样（实际调用 ${fetchCalls} 次）`);

// 4. 验证答案
eq(results[0].answer, 'B', '第1题答案 = B');
ok(Array.isArray(results[1].answer), '第2题答案是数组', JSON.stringify(results[1].answer));
eq(results[1].answer.sort(), ['A', 'B', 'D'], '第2题答案 = ABD');
eq(results[2].answer, '错误', '第3题答案 = 错误（判断语义归一）');

// 5. 置信度与投票来源
ok(results.every((r) => r.confidence > 0.8), '置信度都 > 0.8',
   results.map((r) => r.confidence).join(','));
ok(results.every((r) => r.reason === 'unanimous'), '两次采样一致 → 全票',
   results.map((r) => r.reason).join(','));

// 6. prompt 质量：题干和选项都进去了
const p0 = seenPrompts[0];
ok(p0.includes('安全生产方针'), 'prompt 里含第1题题干');
ok(p0.includes('安全第一、预防为主'), 'prompt 里含选项原文');
ok(!p0.includes('（单选题）'), 'prompt 已剥离题型标记');
ok(p0.includes('"type":"多选题"') || p0.includes('多选题'), '多选题类型已标注');

// 7. 答案能映射回选项（供自动点击）
const q1 = questions[0];
const pick = results[0].answer;
const opt = q1.options.find((o) => o.label === pick);
ok(!!opt, '答案 B 能映射到选项对象');
eq(opt.text, '安全第一、预防为主', '映射出的选项文本正确');
ok(opt.cx > 0 && opt.cy > 0, '选项带点击坐标');

// 8. 题库二次命中（同题不再烧 token）
const bankData = [];
const fakeBank = {
  lookup: () => null,
  record: (item) => bankData.push(item),
  get size() { return bankData.length; },
};
const before = fetchCalls;
await solveQuestions([{ ...questions[0], key: 'dup1' }], cfg, fakeBank);
ok(fetchCalls > before, '无题库时正常走模型');
ok(bankData.length > 0, '高置信度结果已写入题库');
eq(bankData[0].answer, 'B', '入库答案正确');

/* ══════════════ 结果 ══════════════ */

console.log('\n' + '─'.repeat(58));
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
