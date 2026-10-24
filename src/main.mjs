/**
 * main.mjs — 学习通 APP 答题助手（ADB 版）
 *
 * 用法：
 *   node src/main.mjs
 *
 * 原理：手机连电脑，用 ADB 读 UI 节点树（不受 FLAG_SECURE 影响），
 *       抽出题目 → 送 AI → 答案显示在电脑屏幕上，你在手机上照着点。
 *       手机上不装任何东西，APP 扫不到第三方包。
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as adb from './adb.mjs';
import { extractQuestions, looksLikeQuiz } from './uia.mjs';
import { solveQuestions, makeBank } from './llm.mjs';
import { printAnswers, startDashboard, exportHtml } from './ui-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

/* ══════════════ 配置 ══════════════ */

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  if (!existsSync(p)) {
    if (existsSync(example)) {
      console.error(`${C.red}缺少 config.json${C.reset}`);
      console.error(`请复制一份并填入 API Key：`);
      console.error(`  ${C.cyan}cp config.example.json config.json${C.reset}`);
      console.error(`然后编辑 config.json，把 apiKey 换成你自己的。`);
    } else {
      console.error(`${C.red}找不到 config.json${C.reset}`);
    }
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${C.red}config.json 格式错误：${e.message}${C.reset}`);
    process.exit(1);
  }
}

/* ══════════════ 辅助 ══════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qkey(q) {
  return crypto.createHash('sha1').update(`${q.type}|${q.stem}`).digest('hex').slice(0, 10);
}

const TYPE_LABEL = {
  single: '单选', multiple: '多选', judge: '判断', fill: '填空',
  wordfill: '选词', qa: '简答', composite: '复合',
};

/* ══════════════ 主程序 ══════════════ */

async function main() {
  console.log(`\n${C.bold}学习通 APP 答题助手${C.reset} ${C.gray}(ADB 读屏 · 手机零安装)${C.reset}\n`);

  /* ---- 1. 环境自检 ---- */
  const check = await adb.selfCheck();
  if (!check.adbOk) {
    console.error(`${C.red}找不到 adb。${C.reset}`);
    console.error(`解决方法（任选一个）：`);
    console.error(`  · 运行 ${C.cyan}install-adb.ps1${C.reset} 自动下载`);
    console.error(`  · 手动下载 platform-tools 解压到 ${C.cyan}chaoxing_app/bin/${C.reset}`);
    console.error(`  · 装 Android Studio，它自带 adb`);
    console.error(`\n原始错误：${C.gray}${check.error}${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}✓${C.reset} adb ${C.gray}${check.version}${C.reset}`);

  let device;
  try {
    device = await adb.requireDevice();
    console.log(`${C.green}✓${C.reset} 设备 ${C.gray}${device.model || device.serial}${C.reset}`);
  } catch (e) {
    console.error(`${C.red}✗ ${e.message}${C.reset}`);
    process.exit(1);
  }

  const size = await adb.screenSize(device.serial);
  console.log(`${C.green}✓${C.reset} 屏幕 ${C.gray}${size.w}×${size.h}${C.reset}`);

  const cfg = loadConfig();
  const providerCount = (cfg.providers || []).filter((p) => p.enabled !== false && p.apiKey).length;
  if (!providerCount) {
    console.error(`${C.red}✗ config.json 里没有可用的 API Key${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}✓${C.reset} 模型 ${C.gray}${providerCount} 个${providerCount === 1 ? '（会自动双采样）' : ''}${C.reset}`);

  const bank = makeBank(ROOT);
  const dashboard = await startDashboard({ port: cfg.dashboardPort ?? 7802 });
  await sleep(400);

  /* ---- 2. 状态 ---- */
  const solved = new Map();   // key → result，同一题不重复烧 token
  let lastXml = '';
  let lastQuestions = [];

  /* ---- 3. 抓取 + 解题 ---- */
  async function capture({ silent = false } = {}) {
    dashboard.setBusy(true, '抓取界面…');
    let xml;
    try {
      xml = await adb.dumpUI(device.serial);
    } catch (e) {
      dashboard.setBusy(false);
      console.log(`${C.red}抓取失败：${e.message}${C.reset}`);
      return { ok: false };
    }
    lastXml = xml;

    const focus = await adb.currentPackage(device.serial);
    const inChaoxing = /chaoxing|edu\.cn|fanya/i.test(focus);
    if (!inChaoxing && !silent) {
      console.log(`${C.yellow}提醒：当前前台不是学习通${C.reset} ${C.gray}${focus.slice(0, 80)}${C.reset}`);
    }

    const { questions, strategy, debug } = extractQuestions(xml, { screenH: size.h });
    lastQuestions = questions;

    if (!questions.length) {
      dashboard.update([], []);
      dashboard.setBusy(false);
      console.log(
        `${C.yellow}当前屏幕没识别到题目${C.reset}\n` +
        `${C.gray}  策略 节点 ${debug.nodes}/带字 ${debug.textNodes}/切出 ${debug.byNode}|${debug.byText}` +
        `${looksLikeQuiz(xml) ? '（像是答题页，可能是渲染方式特殊）' : '（不是答题页）'}${C.reset}\n` +
        `${C.gray}  试：滚到有题的位置再抓；或按 s 保存 XML 发给我调解析器${C.reset}`
      );
      return { ok: false, questions: [] };
    }

    // 挂上稳定 key
    for (const q of questions) q.key = qkey(q);

    const fresh = questions.filter((q) => !solved.has(q.key));
    console.log(
      `${C.cyan}识别 ${questions.length} 题${C.reset}` +
      `${fresh.length < questions.length ? C.gray + `（${questions.length - fresh.length} 题已解过，直接复用）` + C.reset : ''}` +
      `${C.gray} 策略=${strategy}${C.reset}`
    );

    if (fresh.length) {
      dashboard.setBusy(true, `解题中… ${fresh.length} 题`);
      console.log(`${C.gray}请求模型中…${C.reset}`);
      const t0 = Date.now();
      try {
        const rs = await solveQuestions(fresh, cfg, bank);
        fresh.forEach((q, i) => solved.set(q.key, rs[i]));
        console.log(`${C.gray}用时 ${((Date.now() - t0) / 1000).toFixed(1)}s${C.reset}`);
      } catch (e) {
        dashboard.setBusy(false);
        console.log(`${C.red}解题失败：${e.message}${C.reset}`);
        return { ok: false, questions };
      }
    }

    const results = questions.map((q) => solved.get(q.key) ?? { answer: null, confidence: 0 });
    dashboard.update(questions, results);
    printAnswers(questions, results);

    const low = results.filter((r) => r.answer == null || (r.confidence ?? 0) < 0.75).length;
    if (low) {
      console.log(`${C.yellow}${low} 题需要你确认${C.reset} ${C.gray}（置信度低或未解出，别直接照着点）${C.reset}`);
    }

    return { ok: true, questions, results };
  }

  /* ---- 4. 命令循环 ---- */
  const help = () => {
    console.log(`
${C.bold}命令${C.reset}
  ${C.cyan}Enter${C.reset}  重新抓取当前屏幕并解题（翻到下一题后按）
  ${C.cyan}n${C.reset}      向下翻一屏再抓
  ${C.cyan}a${C.reset}      自动模式：连续翻滚抓取，直到题目不再变化
  ${C.cyan}t${C.reset}      辅助点击，格式：${C.gray}t 1 B${C.reset}（第 1 题点 B 选项）
  ${C.cyan}s${C.reset}      保存当前界面 XML（解析出错时发给我）
  ${C.cyan}o${C.reset}      重新打开答题台网页
  ${C.cyan}h${C.reset}      帮助    ${C.cyan}q${C.reset}  退出
`);
  };

  help();
  await capture();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  let running = true;
  while (running) {
    let line;
    try {
      line = (await ask(`${C.cyan}›${C.reset} `)).trim();
    } catch (_) {
      break;
    }
    const [cmd, ...rest] = line.split(/\s+/);

    switch ((cmd || '').toLowerCase()) {
      case '':
      case 'r':
        await capture();
        break;

      case 'n': {
        await adb.swipe(device.serial, size.w / 2, size.h * 0.78, size.w / 2, size.h * 0.28, 320);
        await sleep(700);
        await capture();
        break;
      }

      case 'a': {
        console.log(`${C.gray}自动模式：每次翻屏后重新识别，题目不再变化就停。Ctrl+C 可中断。${C.reset}`);
        let prevSig = '';
        for (let i = 0; i < 30; i++) {
          const r = await capture({ silent: true });
          const sig = lastQuestions.map((q) => q.stem).join('|');
          if (sig && sig === prevSig) {
            console.log(`${C.gray}题目没有变化，自动模式结束${C.reset}`);
            break;
          }
          prevSig = sig;
          await adb.swipe(device.serial, size.w / 2, size.h * 0.78, size.w / 2, size.h * 0.28, 320);
          await sleep(800);
        }
        break;
      }

      case 't': {
        const [, nStr, label] = [cmd, rest[0], rest[1]];
        const n = Number(nStr);
        if (!nStr || !label) {
          console.log(`${C.yellow}格式：t 1 B${C.reset} ${C.gray}（第 1 题，点 B 选项）${C.reset}`);
          break;
        }
        const q = lastQuestions.find((x) => (x.number ?? 0) === n) || lastQuestions[n - 1];
        if (!q) { console.log(`${C.yellow}找不到第 ${n} 题（当前屏幕只有 ${lastQuestions.length} 题）${C.reset}`); break; }

        const opt = q.options.find((o) => o.label === label.toUpperCase());
        if (!opt) {
          console.log(`${C.yellow}第 ${n} 题没有选项 ${label}${C.reset} ${C.gray}可选：${q.options.map((o) => o.label).join(' ')}${C.reset}`);
          break;
        }
        if (!opt.cx || !opt.cy) {
          console.log(`${C.red}该选项没有坐标信息，无法点击${C.reset} ${C.gray}（可能是文本级解析，需要原生渲染才有坐标）${C.reset}`);
          break;
        }
        await adb.tap(device.serial, opt.cx, opt.cy);
        console.log(`${C.green}已点击第 ${n} 题的 ${label}${C.reset} ${C.gray}(${Math.round(opt.cx)}, ${Math.round(opt.cy)})${C.reset}`);
        break;
      }

      case 's': {
        if (!lastXml) { console.log(`${C.yellow}还没有抓到内容${C.reset}`); break; }
        const dir = path.join(ROOT, 'dump');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `ui-${new Date().toISOString().replace(/[:.]/g, '-')}.xml`);
        writeFileSync(f, lastXml, 'utf8');
        console.log(`${C.green}已保存${C.reset} ${C.gray}${f}${C.reset}`);
        break;
      }

      case 'o': {
        console.log(`${C.cyan}${dashboard.url}${C.reset}`);
        break;
      }

      case 'h':
        help();
        break;

      case 'q':
      case 'exit':
        running = false;
        break;

      default:
        console.log(`${C.gray}未知命令 ${cmd}，按 h 看帮助${C.reset}`);
    }
  }

  rl.close();
  dashboard.close();
  console.log(`\n${C.gray}已退出。题库已记录 ${bank.size ?? 0} 条。${C.reset}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n${C.red}程序异常：${e.message}${C.reset}`);
  console.error(`${C.gray}${e.stack?.split('\n').slice(1, 4).join('\n')}${C.reset}`);
  process.exit(1);
});
