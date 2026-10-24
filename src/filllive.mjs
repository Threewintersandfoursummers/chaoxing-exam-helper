/**
 * filllive.mjs — 填空/简答写入链路的真机验证
 *
 * 为什么需要一个独立脚本：
 *   fillText() 在 auto.mjs 的闭包里，只能靠真界面触发。而练习卷里没有
 *   填空题，等于这条链路从来没在真机上跑过。第 41 题那次 fill-manual
 *   就是因为它。
 *
 * 这里用「新建联系人」当测试台（有标准 EditText、点完不保存就没有副作用），
 * 把 fillText 用的同一条命令序列原样走一遍：
 *   点框 → 切 ADBKeyboard → 清空 → 注入中文 → 切回原输入法
 * 每一步都读屏核对，最后把输入法恢复。
 *
 * 用法：node src/filllive.mjs [测试文本]
 */
import { openDevice, q as shq } from './sh.mjs';
import { parseNodes } from './uia.mjs';

const IME_ADB = 'com.android.adbkeyboard/.AdbIME';
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

const dev = await openDevice({ mode: 'auto' });
console.log(`通道：${dev.mode}`);

const imeNow = async () => {
  const out = await dev.raw('settings get secure default_input_method', { timeout: 8000 });
  return String(out).trim().split(/\r?\n/)[0].trim();
};
const imeSet = (id) => dev.raw(`ime set ${id}`, { timeout: 15000 });

const boxesOf = async () => {
  const xml = await dev.dump();
  return parseNodes(xml).filter((n) => /EditText/.test(n.cls) && n.bounds.h > 20);
};

let bad = 0;
const chk = (name, cond, extra = '') => {
  if (cond) console.log(`  ${PASS} ${name}`);
  else {
    bad++;
    console.log(`  ${FAIL} ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/* 1. 安装与启用状态 */
console.log('\n[1] ADBKeyboard');
const imeList = await dev.raw('ime list -s 2>/dev/null', { timeout: 10000 });
chk('已安装并启用', /adbkeyboard/i.test(imeList), imeList.trim().replace(/\n/g, ' | '));

const backup = await imeNow();
console.log(`  原输入法：${backup || '(空)'}`);
chk('已记下原输入法', !!backup);

/* 2. 准备一个有输入框的界面 */
console.log('\n[2] 测试台（新建联系人，不保存）');
await dev.raw('am start -a android.intent.action.INSERT -t vnd.android.cursor.dir/contact');
await WAIT(2500);
let boxes = await boxesOf();
chk('找到输入框', boxes.length > 0, `${boxes.length} 个`);
if (!boxes.length) {
  console.log('  没有输入框，无法继续');
  process.exit(1);
}

/* 3. 切输入法 */
console.log('\n[3] 切换输入法');
await imeSet(IME_ADB);
await WAIT(800);
chk('已切到 ADBKeyboard', /adbkeyboard/i.test(await imeNow()));

/* 4. 点框 + 清空 + 注入 */
const text = process.argv[2] || '和平发展';
console.log(`\n[4] 写入「${text}」`);

const c = {
  x: Math.round((boxes[0].bounds.x1 + boxes[0].bounds.x2) / 2),
  y: Math.round((boxes[0].bounds.y1 + boxes[0].bounds.y2) / 2),
};
await dev.tap(c.x, c.y);
await WAIT(500);

try {
  // 先塞一段 ASCII 制造「框里已有内容」的场景 —— 新卷里框是空的，
  // 但程序重启重答同一题时框里就有旧答案，那时必须覆盖而不是追加。
  await dev.raw('am broadcast -a ADB_INPUT_TEXT --es msg __pre__', { timeout: 10000 });
  await WAIT(400);
  const before = (await boxesOf())[0]?.text || '';
  chk('预置内容成功', /__pre__/.test(before), `实际「${before}」`);

  await dev.raw('am broadcast -a ADB_CLEAR_TEXT', { timeout: 10000 });
  await WAIT(400);
  const cleared = (await boxesOf())[0]?.text || '';
  chk('清空生效（不残留旧内容）', !/__pre__/.test(cleared), `残留「${cleared}」`);

  await dev.raw(`am broadcast -a ADB_INPUT_TEXT --es msg ${shq(text)}`, { timeout: 10000 });
  await WAIT(500);
  const afterType = await boxesOf();
  const got = (afterType[0]?.text || '').trim();
  chk('中文写入正确', got === text, `实际「${got}」`);
} catch (e) {
  bad++;
  console.log(`  ${FAIL} 广播失败 — ${e.message}`);
}

/* 5. 切回原输入法（这一步必须做成，否则用户手打没键盘） */
console.log('\n[5] 恢复输入法');
await imeSet(backup);
await WAIT(600);
chk('已切回原输入法', (await imeNow()) === backup);

/* 6. 退出测试台（直接杀掉进程，避免弹「是否保存联系人」挡住下一轮） */
await dev.raw('am force-stop com.android.contacts');
await WAIT(500);

console.log(
  bad
    ? `\n\x1b[31m${bad} 项失败\x1b[0m —— 填空题现在不能自动填，需要人工补`
    : `\n\x1b[32m全部通过\x1b[0m —— 填空/简答可以自动填了`
);
process.exit(bad ? 1 : 0);
