/**
 * auto.test.mjs — 自动答题引擎验证
 *
 * 这里测的不是「能不能点」，而是「会不会点错」。
 * 点错一题只丢分；点到「交卷」整场归零。所以重点在拦截逻辑。
 */
import { createEngine, qkey, matchOption, resolveOptionTarget } from '../src/auto.mjs';
import { parseNodes } from '../src/uia.mjs';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ' → ' + detail : ''}`); }
}
function eq(a, b, name) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  ok(x === y, name, `期望 ${y}，实际 ${x}`);
}

/* ══════════════ 假设备 ══════════════ */

function fakeDev(sequence) {
  const calls = [];
  let i = 0;
  return {
    calls,
    get round() { return i; },
    async dump() {
      const xml = sequence[Math.min(i, sequence.length - 1)];
      i++;
      return xml;
    },
    async taps(list, opt) {
      calls.push({ kind: 'taps', list: list.map((p) => `${p.label}@${Math.round(p.x)},${Math.round(p.y)}`), gap: opt?.gapMs ?? 0 });
      return list.length;
    },
    async tap(x, y) { calls.push({ kind: 'tap', at: `${Math.round(x)},${Math.round(y)}` }); },
    async swipe(...a) { calls.push({ kind: 'swipe', at: a.map(Math.round).join(',') }); },
    async longPress() { calls.push({ kind: 'longpress' }); },
    async screenSize() { return { w: 1080, h: 2400 }; },
  };
}

/** 收集所有被点过的坐标（点 + 批量点展开） */
function tapPoints(dev) {
  const out = [];
  for (const c of dev.calls) {
    if (c.kind === 'tap') out.push(c.at);
    if (c.kind === 'taps') out.push(...c.list.map((s) => s.split('@')[1]));
  }
  return out;
}

/* ══════════════ 样本 ══════════════ */

const N = (t, extra = '') =>
  `<node index="0" text="${t}" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="${extra}" />`;

const XML_QUIZ = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
  ${N('1.', '[42,300][90,356]')}${N('（单选题）', '[96,300][230,356]')}${N('根据《建筑法》，安全生产方针是？', '[42,370][1038,500]')}
  ${N('A、质量优先、安全为辅', '[42,540][1038,620]')}
  ${N('B、安全第一、预防为主', '[42,640][1038,720]')}
  ${N('C、效益优先、兼顾安全', '[42,740][1038,820]')}
  ${N('D、进度第一、安全第二', '[42,840][1038,920]')}
  ${N('2.', '[42,940][90,996]')}${N('（多选题）', '[96,940][230,996]')}${N('TCP 三次握手涉及哪些标志位？', '[42,1010][1038,1110]')}
  ${N('A、SYN', '[42,1120][1038,1200]')}
  ${N('B、ACK', '[42,1220][1038,1300]')}
  ${N('C、FIN', '[42,1320][1038,1400]')}
  ${N('D、RST', '[42,1420][1038,1500]')}
  ${N('3.', '[42,1540][90,1596]')}${N('（判断题）', '[96,1540][230,1596]')}${N('HTTP 协议是无状态协议。', '[42,1560][1038,1660]')}
  ${N('A、正确', '[42,1700][1038,1780]')}
  ${N('B、错误', '[42,1800][1038,1880]')}
</node></hierarchy>`;

const XML_SUBMIT = XML_QUIZ.replace(
  '</node></hierarchy>',
  `${N('提交', '[900,2100][1050,2180]')}</node></hierarchy>`
);

const XML_FACE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
  ${N('人脸识别', '[300,600][780,680]')}
  ${N('请正对摄像头并眨眨眼', '[180,720][900,820]')}
  ${N('开始识别', '[380,1000][700,1090]')}
</node></hierarchy>`;

const XML_WEBVIEW = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
  <node index="1" text="1.（单选题）以下哪个不是关系型数据库？&#10;A、MySQL&#10;B、PostgreSQL&#10;C、Redis&#10;D、Oracle" resource-id="" class="android.webkit.WebView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,280][1080,1800]" />
</node></hierarchy>`;

const XML_CHECKED = XML_QUIZ.replace(
  'text="A、质量优先、安全为辅" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false"',
  'text="A、质量优先、安全为辅" resource-id="" class="android.widget.TextView" content-desc="" checkable="true" checked="true"'
);

/* ══════════════ 1. 选项匹配 ══════════════ */

console.log('══════ 1. 答案 → 选项 ══════');
{
  const q = {
    type: 'single',
    stem: 'x',
    options: [
      { label: 'A', text: '质量优先' },
      { label: 'B', text: '安全第一' },
    ],
  };
  eq(matchOption(q, 'B')?.label, 'B', '字母直接命中');
  eq(matchOption(q, '安全第一')?.label, 'B', '选项全文命中');
  eq(matchOption(q, 'b')?.label, 'B', '小写字母');

  const jq = {
    type: 'judge',
    stem: 'y',
    options: [{ label: 'A', text: '正确' }, { label: 'B', text: '错误' }],
  };
  eq(matchOption(jq, '正确')?.label, 'A', '判断题语义 正确→A');
  eq(matchOption(jq, '错误')?.label, 'B', '判断题语义 错误→B');
  eq(matchOption(jq, '√')?.label, 'A', '判断题符号 √');
  eq(matchOption(jq, 'false')?.label, 'B', '判断题英文 false');
  eq(matchOption(q, 'Z'), null, '不存在的字母返回 null');
}

/* ══════════════ 2. 正常答题 ══════════════ */

console.log('══════ 2. 正常答题 ══════');
{
  const dev = fakeDev([XML_QUIZ]);
  const perQ = [['B'], ['A', 'B'], ['正确']];
  const solve = async (qs) => qs.map((q, i) => ({ id: q.key, answer: perQ[i], confidence: 0.9 }));

  const eng = createEngine({ dev, solve, cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } }, screenH: 2400 });
  const r = await eng.step();

  eq(r.action, 'answered', 'step 返回 answered');
  eq(r.count, 3, '答了 3 题');
  eq(r.taps, 4, '共 4 次点击（单选1 + 多选2 + 判断1）');

  const pts = tapPoints(dev);
  eq(pts, ['540,680', '540,1160', '540,1260', '540,1740'], '点击坐标落在对应选项中心');
}

/* ══════════════ 3. 幂等：不重复点同一题 ══════════════ */

console.log('══════ 3. 重复执行不重复点击 ══════');
{
  const dev = fakeDev([XML_QUIZ, XML_QUIZ, XML_QUIZ]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({ dev, solve, cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0], settleRounds: 2 } }, screenH: 2400 });

  await eng.step();
  const first = tapPoints(dev).length;
  await eng.step();
  await eng.step();
  const total = tapPoints(dev).length;

  ok(first > 0, '第一轮有点击', String(first));
  eq(total, first, '后续轮次不再点击同一批题');
}

/* ══════════════ 4. 绝不点提交 ══════════════ */

console.log('══════ 4. 提交按钮拦截 ══════');
{
  const dev = fakeDev([XML_SUBMIT, XML_SUBMIT, XML_SUBMIT]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({ dev, solve, cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } }, screenH: 2400 });

  await eng.step();
  const r2 = await eng.step();

  eq(r2.action, 'ready-to-submit', '答完后报告 ready-to-submit');
  const pts = tapPoints(dev);
  const hitSubmit = pts.some((p) => {
    const [x, y] = p.split(',').map(Number);
    return x > 880 && y > 2080;
  });
  ok(!hitSubmit, '没有点过「提交」按钮区域', pts.join(' '));
}

/* ══════════════ 5. 人脸识别立刻停手 ══════════════ */

console.log('══════ 5. 危险弹窗停手 ══════');
{
  const dev = fakeDev([XML_FACE]);
  let solved = 0;
  const solve = async (qs) => { solved++; return qs.map(() => ({ answer: 'A' })); };
  const eng = createEngine({ dev, solve, cfg: { auto: {} }, screenH: 2400 });

  const r = await eng.step();
  eq(r.action, 'paused', '识别到人脸页返回 paused');
  eq(r.alert, 'face', '告警类型是 face');
  eq(dev.calls.length, 0, '一次点击都没发');
  eq(solved, 0, '也没有去请求模型（不浪费 token）');
}

/* ══════════════ 6. 部分定位 → 整题放弃 ══════════════ */

console.log('══════ 6. 多选只定位到一半就放弃整题 ══════');
{
  const dev = fakeDev([XML_QUIZ]);
  // 第 2 题是 4 选项多选，给 A 和 Z（Z 不存在）
  const solve = async (qs) =>
    qs.map((q) => (q.type === 'multiple' ? { answer: ['A', 'Z'], confidence: 0.9 } : { answer: 'A', confidence: 0.9 }));

  const eng = createEngine({ dev, solve, cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } }, screenH: 2400 });
  const r = await eng.step();

  const partial = (r.unresolved || []).find((u) => u.reason === 'partial');
  ok(!!partial, '多选被标记 partial', JSON.stringify(r.unresolved));
  const pts = tapPoints(dev);
  // 第 2 题的选项中心 y = 1160/1260/1360/1460，一个都不该出现
  ok(!pts.some((p) => { const y = Number(p.split(',')[1]); return y >= 1120 && y <= 1500; }), '没有只点一半', pts.join(' '));
}

/* ══════════════ 7. WebView 整块文本 → 按行估算坐标 ══════════════ */

console.log('══════ 7. 整块文本的估算坐标 ══════');
{
  const dev = fakeDev([XML_WEBVIEW]);
  const solve = async (qs) => qs.map(() => ({ answer: 'C', confidence: 0.9 }));
  const eng = createEngine({ dev, solve, cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } }, screenH: 2400 });

  const r = await eng.step();
  ok(r.taps > 0, '估算出了点击点', JSON.stringify(r));
  const pts = tapPoints(dev);
  const y = Number((pts[0] || '0,0').split(',')[1]);
  ok(y > 280 && y < 1800, 'y 落在文本框范围内', `y=${y}`);
  // 5 行（题干 + ABCD），块高 1520 → 行高 304，C 是第 4 行（idx 3）
  // 行中心 = 280 + 3.5 × 304 = 1344
  ok(y > 1250 && y < 1420, 'y 落在 C 行附近（不是整块中心）', `y=${y}`);
}

/* ══════════════ 8. 已选中的题不再动 ══════════════ */

console.log('══════ 8. 已选中的题不重复点 ══════');
{
  const dev = fakeDev([XML_CHECKED]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({ dev, solve, cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } }, screenH: 2400 });

  await eng.step();
  const pts = tapPoints(dev);
  const q1Range = (p) => { const y = Number(p.split(',')[1]); return y >= 500 && y <= 930; };
  ok(!pts.some(q1Range), '第 1 题已选中，没有被重复点', pts.join(' '));
}

/* ══════════════ 9. 节奏参数生效 ══════════════ */

console.log('══════ 9. 人类节奏 ══════');
{
  const dev = fakeDev([XML_QUIZ]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({
    dev, solve,
    cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [500, 900] } },
    screenH: 2400,
  });
  await eng.step();
  const t = dev.calls.find((c) => c.kind === 'taps');
  ok(t && t.gap >= 500 && t.gap <= 900, '点击间隔落在 500-900ms', String(t?.gap));
}

/* ══════════════ 10. WebView 失明后自愈 ══════════════ */

console.log('══════ 10. 失明自愈 ══════');
{
  // 真机故障现场：整棵树只剩标题栏（26 节点 / 1 段文字）
  const BLIND =
    "<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation=\"0\">" +
    '<node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" ' +
    'bounds="[0,0][1080,2400]">' +
    '<node index="0" text="蔡家瑞 (2446030140101)" class="android.widget.TextView" ' +
    'package="com.chaoxing.mobile" bounds="[300,120][780,180]" />' +
    '</node></hierarchy>';

  const dev = fakeDev([BLIND, XML_QUIZ]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({
    dev,
    solve,
    cfg: { auto: { thinkDelayMs: [0, 0], tapGapMs: [0, 0] } },
    screenH: 2400,
  });
  const r = await eng.step();
  ok(dev.calls.some((c) => c.kind === 'swipe'), '先用轻滑唤醒（不点，避免误选）', JSON.stringify(dev.calls.map((c) => c.kind)));
  ok(r.action === 'answered' && r.taps > 0, '唤醒后照常答题', JSON.stringify(r));
}

/* ══════════════ 11. 一屏答完立刻翻页，不多读一次屏幕 ══════════════ */

console.log('══════ 11. 答完即翻页 ══════');
{
  const dev = fakeDev([XML_QUIZ]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({
    dev,
    solve,
    cfg: { auto: { thinkDelayMs: [0, 0], tapGapMs: [0, 0] } },
    screenH: 2400,
  });
  const r = await eng.step();
  ok(r.advanced === 'next' || r.advanced === 'scroll', '同一次 step 里就翻页', JSON.stringify(r.advanced));
  ok(dev.round === 1, '只读了一次屏幕', '读屏次数=' + dev.round);
}

/* ══════════════ 16. WebView 失明后能自己醒过来 ══════════════
   真机故障复现：答到十几题后，无障碍树只剩原生标题栏，
   题目节点全部消失。旧判据「文字总量 >= 40 就算正常」会被标题栏骗过，
   认为屏幕好好的、一次都不唤醒，程序在 idle 里无限空转（实测停在 15 题）。 */

console.log('══════ 16. WebView 失明 → 自动唤醒 ══════');
{
  const XML_BLIND = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
  ${N('蔡家瑞 (2446030140101)', '[42,120][700,180]')}
  ${N('倒计时 56:32 剩余', '[760,120][1038,180]')}
  ${N('答题卡', '[900,240][1038,300]')}
  ${N('标记', '[42,240][140,300]')}
  ${N('上一题', '[42,2260][300,2340]')}
  ${N('下一题', '[780,2260][1038,2340]')}
</node></hierarchy>`;

  const dev = fakeDev([XML_BLIND, XML_QUIZ]);
  const solve = async (qs) => qs.map(() => ({ answer: 'B', confidence: 0.9 }));
  const eng = createEngine({
    dev,
    solve,
    cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } },
    screenH: 2400,
  });

  const r = await eng.step();
  const swipes = dev.calls.filter((c) => c.kind === 'swipe');
  ok(swipes.length > 0, '失明后会滑动唤醒，而不是原地空转', '滑动 ' + swipes.length + ' 次');
  eq(r.action, 'answered', '唤醒后接着答题（不是 idle/nothing）');
  eq(r.count, 3, '整屏三题都答上了');
}

/* ══════════════ 17. 失明时不许误判「答完了」══════════════
   真机复现（第 33 题）：节点树里「下一题」消失 → advance() 只能盲上滑 →
   滑两次页面没变 → 判定「没有更多可答的题了」→ return 0 退出，
   而屏幕上明明还停在第 33 题，后面的题全漏。 */

console.log('══════ 17. 失明时不误判收工 ══════');
{
  // 唤醒后读到的那一屏：多了第 4 题（还没答）和「下一题」按钮
  const XML_MORE = XML_QUIZ.replace(
    '</node></hierarchy>',
    `${N('4.', '[42,1900][90,1956]')}${N('（单选题）', '[96,1900][230,1956]')}${N('HTTP 404 表示什么？', '[42,1960][1038,2040]')}
  ${N('A、服务器内部错误', '[42,2060][1038,2120]')}
  ${N('B、未找到资源', '[42,2140][1038,2200]')}
  ${N('下一题', '[780,2250][1038,2330]')}</node></hierarchy>`
  );

  // 第 1 次读：正常三题 → 全答完
  // 第 2 次读：同一屏但「下一题」不见了（失明）→ 不该收工
  // 唤醒后读：出现第 4 题
  const dev = fakeDev([XML_QUIZ, XML_QUIZ, XML_MORE]);
  const solve = async (qs) => qs.map(() => ({ answer: 'A', confidence: 0.9 }));
  const eng = createEngine({
    dev,
    solve,
    cfg: { auto: { thinkDelayMs: [0, 1], tapGapMs: [0, 0] } },
    screenH: 2400,
  });

  const r1 = await eng.step();
  eq(r1.action, 'answered', '第一屏三题答完');

  const r2 = await eng.step();
  ok(r2.action !== 'finished-likely', '没有误判「答完了」', '实际=' + r2.action);
  eq(r2.action, 'idle', '唤醒后发现还有题，回到正常流程');
  ok(dev.calls.some((c) => c.kind === 'swipe'), '确实做了唤醒滑动');
}

/* ══════════════ 结果 ══════════════ */

console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log(`\x1b[31m失败 ${fail} / 通过 ${pass}\x1b[0m`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
