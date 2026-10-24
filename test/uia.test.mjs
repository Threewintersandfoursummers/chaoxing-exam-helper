/**
 * uia.test.mjs — Android UI 树解析验证
 *
 * 用真实格式的 uiautomator XML 测两种渲染方式：
 *   A. 原生渲染：每个选项是独立 TextView（有坐标，能自动点击）
 *   B. WebView 渲染：整块内容在一个节点里（只能显示答案，手动点）
 *
 * 这两种必须都过。学习通 APP 是原生 + H5 混合，同一个考试里可能两种都有。
 */
import { extractQuestions, extractByNodes, extractByTextFlow, cleanStem, parseNodes, looksLikeQuiz } from '../src/uia.mjs';

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

/* ══════════════ 样本 A：原生渲染（每选项独立节点，带坐标） ══════════════ */

const XML_NATIVE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="1." resource-id="id/tv_num" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,300][90,356]" />
    <node index="1" text="（单选题）" resource-id="id/tv_type" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[96,300][230,356]" />
    <node index="2" text="根据《建筑法》，建筑施工企业应当坚持的安全生产方针是？" resource-id="id/tv_stem" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,370][1038,500]" />
    <node index="3" text="A、质量优先、安全为辅" resource-id="id/opt_a" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,540][1038,620]" />
    <node index="4" text="B、安全第一、预防为主" resource-id="id/opt_b" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,640][1038,720]" />
    <node index="5" text="C、效益优先、兼顾安全" resource-id="id/opt_c" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,740][1038,820]" />
    <node index="6" text="D、进度第一、安全第二" resource-id="id/opt_d" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,840][1038,920]" />
    <node index="7" text="2." resource-id="id/tv_num" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,980][90,1036]" />
    <node index="8" text="（多选题）" resource-id="id/tv_type" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[96,980][230,1036]" />
    <node index="9" text="TCP 三次握手涉及以下哪些标志位？" resource-id="id/tv_stem" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,1050][1038,1180]" />
    <node index="10" text="A、SYN" resource-id="id/opt_a" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,1220][1038,1300]" />
    <node index="11" text="B、ACK" resource-id="id/opt_b" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,1320][1038,1400]" />
    <node index="12" text="C、FIN" resource-id="id/opt_c" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,1420][1038,1500]" />
    <node index="13" text="D、RST" resource-id="id/opt_d" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,1520][1038,1600]" />
    <node index="14" text="3." resource-id="id/tv_num" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,1660][90,1716]" />
    <node index="15" text="（判断题）" resource-id="id/tv_type" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[96,1660][230,1716]" />
    <node index="16" text="HTTP 协议是无状态协议。" resource-id="id/tv_stem" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,1730][1038,1830]" />
    <node index="17" text="A、正确" resource-id="id/opt_a" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,1870][1038,1950]" />
    <node index="18" text="B、错误" resource-id="id/opt_b" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[42,1960][1038,2040]" />
  </node>
</hierarchy>`;

/* ══════════════ 样本 B：WebView 渲染（整块文本在一个节点） ══════════════ */

const XML_WEBVIEW = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="第四章 测验" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[42,200][600,260]" />
    <node index="1" text="1.（单选题）以下哪个不是关系型数据库？&#10;A、MySQL&#10;B、PostgreSQL&#10;C、Redis&#10;D、Oracle&#10;2.（判断题）Redis 是内存数据库。&#10;A、正确&#10;B、错误" resource-id="" class="android.webkit.WebView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" bounds="[0,280][1080,1800]" />
  </node>
</hierarchy>`;

/* ══════════════ 样本 C：非答题页 ══════════════ */

const XML_NOT_QUIZ = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" bounds="[0,0][1080,2400]">
    <node index="0" text="课程" class="android.widget.TextView" bounds="[42,200][200,260]" />
    <node index="1" text="消息" class="android.widget.TextView" bounds="[400,200][560,260]" />
    <node index="2" text="我的" class="android.widget.TextView" bounds="[800,200][960,260]" />
  </node>
</hierarchy>`;

/* ══════════════ 测试 ══════════════ */

console.log('══════ 1. XML 解析基础 ══════');
{
  const nodes = parseNodes(XML_NATIVE);
  ok(nodes.length >= 19, '解析出全部节点', String(nodes.length));
  eq(nodes[0].bounds.x1, 0, 'bounds 左上 x');
  eq(nodes[0].bounds.w, 1080, 'bounds 宽度');
  ok(nodes.some((n) => n.text.includes('安全生产方针')), '中文文本正确提取');
  ok(nodes.some((n) => n.clickable === true), 'clickable 属性解析');
}

console.log('══════ 2. 节点级解析（原生渲染） ══════');
{
  const qs = extractByNodes(XML_NATIVE);
  ok(qs !== null, '策略A 有结果');
  eq(qs.length, 3, '抽出 3 题');
  eq(qs.map((q) => q.number), [1, 2, 3], '题号 1/2/3');

  const [q1, q2, q3] = qs;

  eq(q1.type, 'single', 'q1 题型 = 单选');
  ok(q1.stem.includes('安全生产方针'), 'q1 题干正确', q1.stem);
  ok(!/单选题/.test(q1.stem), 'q1 题干已剥离题型标记', q1.stem);
  eq(q1.options.length, 4, 'q1 四个选项');
  eq(q1.options.map((o) => o.label), ['A', 'B', 'C', 'D'], 'q1 选项标签');
  eq(q1.options[1].text, '安全第一、预防为主', 'q1 选项文本去前缀');

  // 坐标（用于自动点击）
  ok(q1.options[1].cx > 0 && q1.options[1].cy > 0, 'q1 选项 B 有坐标');
  eq(Math.round(q1.options[1].cy), 680, 'q1 选项 B 中心 y = 680');

  eq(q2.type, 'multiple', 'q2 题型 = 多选');
  eq(q2.options.length, 4, 'q2 四个选项');

  eq(q3.type, 'judge', 'q3 题型 = 判断（选项是正确/错误）');
  eq(q3.options.map((o) => o.text), ['正确', '错误'], 'q3 选项文本');
}

console.log('══════ 3. 文本级解析（WebView 渲染） ══════');
{
  const qs = extractByTextFlow(XML_WEBVIEW);
  eq(qs.length, 2, '抽出 2 题');
  eq(qs.map((q) => q.number), [1, 2], '题号 1/2');

  const [q1, q2] = qs;
  eq(q1.type, 'single', 'q1 单选');
  ok(q1.stem.includes('关系型数据库'), 'q1 题干正确', q1.stem);
  eq(q1.options.length, 4, 'q1 四个选项');
  eq(q1.options[2].text, 'Redis', 'q1 选项 C 文本');

  eq(q2.type, 'judge', 'q2 判断');
  eq(q2.options.length, 2, 'q2 两个选项');
}

console.log('══════ 4. 统一入口自动选策略 ══════');
{
  const a = extractQuestions(XML_NATIVE);
  eq(a.strategy, 'node', '原生页面走节点策略');
  eq(a.questions.length, 3, '原生页面 3 题');

  const b = extractQuestions(XML_WEBVIEW);
  eq(b.strategy, 'text', 'WebView 页面走文本策略');
  eq(b.questions.length, 2, 'WebView 页面 2 题');

  const c = extractQuestions(XML_NOT_QUIZ);
  eq(c.questions.length, 0, '非答题页抽出 0 题');
}

console.log('══════ 5. 小数保护（题号误判） ══════');
{
  // 题干里出现「3.14」不能当成第 3 题
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <node index="0" text="1." class="android.widget.TextView" bounds="[42,300][90,356]" />
    <node index="1" text="（填空题）圆周率取值约为" class="android.widget.TextView" bounds="[96,300][1038,400]" />
    <node index="2" text="3.14159，保留两位小数是" class="android.widget.TextView" bounds="[42,410][1038,500]" />
    <node index="3" text="2." class="android.widget.TextView" bounds="[42,560][90,616]" />
    <node index="4" text="（判断题）圆的周长公式是 2πr。" class="android.widget.TextView" bounds="[96,560][1038,660]" />
    <node index="5" text="A、正确" class="android.widget.TextView" bounds="[42,700][1038,780]" />
    <node index="6" text="B、错误" class="android.widget.TextView" bounds="[42,800][1038,880]" />
  </node>
</hierarchy>`;
  const qs = extractByNodes(xml);
  eq(qs.length, 2, '「3.14159」没被当成第 3 题');
  ok(qs[0].stem.includes('3.14159'), '小数保留在题干里', qs[0].stem);
}

console.log('══════ 6. 题干清洗 ══════');
{
  eq(cleanStem('1.（单选题）下列哪个正确？'), '下列哪个正确？', '去题号+题型');
  eq(cleanStem('【2分】（多选题）选出所有正确项'), '选出所有正确项', '去分值+题型');
  eq(cleanStem('(1.5分) 判断题内容'), '判断题内容', '去小数分值');
  // 汉字之间的空格是学习通两端对齐拉出来的，必须压掉（真机实测「从 严」「治 理」）。
  // 英文单词之间的空格要保留，否则会把词组连成一个词。
  eq(cleanStem('  多  空格  '), '多空格', '汉字间空格压掉');
  eq(cleanStem('the  quick  brown'), 'the quick brown', '英文单词空格保留');
  eq(cleanStem('根据 《建筑法》 的规定'), '根据 《建筑法》 的规定', '汉字与书名号之间不动');
}

console.log('══════ 7. 答题页识别 ══════');
{
  ok(looksLikeQuiz(XML_NATIVE), '原生答题页识别为 true');
  ok(looksLikeQuiz(XML_WEBVIEW), 'WebView 答题页识别为 true');
  ok(!looksLikeQuiz(XML_NOT_QUIZ), '课程首页识别为 false');
}

/* ══════════════════ 8. 真机实测结构（2026-10-21，iQOO Neo9 / 学习通 WebView） ══════════════════
   这是从真机上 dump 下来、删减后的真实片段，不是构造的。
   特征是：选项标签单独一个字母节点（「A」，后面不带任何标点），
   选项正文是它右边的兄弟节点。这是学习通新版渲染，开源项目里没有针对性处理。 */
const XML_REAL = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" package="com.chaoxing.mobile" bounds="[0,0][1260,2800]"><node index="0" text="单选题 （共30题，60.0分）" class="android.widget.TextView" bounds="[47,480][1210,584]" /><node index="0" text="1." class="android.widget.TextView" bounds="[47,593][92,661]" /><node index="0" text="（2.0分）" class="android.widget.TextView" bounds="[86,593][330,661]" /><node index="0" text="中国特色社会主义事业的坚强领导核心是 ( )" class="android.widget.TextView" bounds="[47,593][1210,756]" /><node index="0" text="" class="android.view.View" bounds="[47,834][1210,1012]"><node index="0" text="A" class="android.widget.TextView" bounds="[98,890][139,956]" /><node index="0" text="中国共产党" class="android.widget.TextView" bounds="[184,881][1115,962]" /></node><node index="0" text="" class="android.view.View" bounds="[47,1051][1210,1232]"><node index="0" text="B" class="android.widget.TextView" bounds="[98,1107][136,1173]" /><node index="0" text="国家主席" class="android.widget.TextView" bounds="[184,1098][1115,1179]" /></node><node index="0" text="" class="android.view.View" bounds="[47,1271][1210,1450]"><node index="0" text="C" class="android.widget.TextView" bounds="[98,1325][139,1393]" /><node index="0" text="军委 主席" class="android.widget.TextView" bounds="[184,1319][1115,1396]" /></node><node index="0" text="" class="android.view.View" bounds="[47,1488][1210,1667]"><node index="0" text="D" class="android.widget.TextView" bounds="[98,1545][142,1610]" /><node index="0" text="国家总理" class="android.widget.TextView" bounds="[184,1536][1115,1616]" /></node><node index="0" text="下一题" class="android.view.View" bounds="[401,2631][1210,2767]" /></node></hierarchy>`;

console.log('══════ 8. 真机实测结构：标签单独字母 + 兄弟节点 ══════');
{
  const r = extractQuestions(XML_REAL, { screenH: 2800 });
  eq(r.questions.length, 1, '只切出 1 题（不能把选项当成新题）');

  const q = r.questions[0];
  ok(!!q, '拿到题目');
  eq(q.type, 'single', '题型=单选（来自章节标题，不靠猜）');
  eq(q.number, 1, '题号=1');
  eq(q.stem, '中国特色社会主义事业的坚强领导核心是 ( )', '题干干净，没有「（2.0分）」尾巴');
  eq(q.options.length, 4, '4 个选项全部认出来');
  eq(q.options.map((o) => o.label).join(''), 'ABCD', '标签 ABCD');
  eq(q.options[0].text, '中国共产党', 'A 正文正确');
  eq(q.options[2].text, '军委主席', 'C 正文的 justify 空格被压掉');

  ok(q.options.every((o) => o.cx > 0 && o.cy > 0), '每个选项都有落点坐标');
  ok(q.options[1].cy > q.options[0].cy, '选项按屏幕从上到下排列');
  // 行中心必须落在该选项行区间内，否则会点到别的行上
  ok(q.options[1].cy > 1098 && q.options[1].cy < 1179, 'B 的落点在其行区间内', String(q.options[1].cy));
}

console.log('══════ 9. 回归：老结构不能被破坏 ══════');
{
  // 「A、xxx」写在同一节点的老结构，仍要能解析
  const r = extractQuestions(XML_NATIVE, { screenH: 2400 });
  ok(r.questions.length > 0, '老结构仍能抽到题');
  ok(r.questions.every((q) => q.options.length >= 2), '老结构选项仍完整');
}

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
