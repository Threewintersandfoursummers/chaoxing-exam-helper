#!/usr/bin/env node
/**
 * single.mjs — 单机考场版入口（只有一部手机）
 *
 *   node src/single.mjs doctor    自检：shell 通道、读屏、抽题、API Key
 *   node src/single.mjs           正式跑：自动读题 → 解题 → 自己点
 *
 * 和电脑版（main.mjs）的区别：
 *   电脑版把答案打到屏幕上，靠人点。
 *   单机版不能显示任何东西——低头看第二块屏幕=切屏=第一道检测。
 *   所以它自己点。你唯一的动作是：进考试页，然后什么都不做。
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDevice, localExec } from './sh.mjs';
import { createEngine, wait } from './auto.mjs';
import { extractQuestions, parseNodes, nodeText } from './uia.mjs';
import { solveQuestions, makeBank, isUsableKey } from './llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

const ts = () => new Date().toTimeString().slice(0, 8);

/* ══════════════ 配置 ══════════════ */

const DEFAULTS = {
  auto: {
    thinkDelayMs: [6000, 15000],   // 每题之间的「思考」停顿
    tapGapMs: [420, 900],          // 两次点击之间的手指移动时间
    settleRounds: 2,
    estimateTap: true,
    autoAdvance: true,             // 自动点「下一题」
    scrollAdvance: true,           // 没有下一页按钮就上滑
    submit: false,                 // 绝不自动交卷
    maxRounds: 400,
  },
  batchSize: 8,
  timeoutMs: 60000,
};

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const ex = path.join(ROOT, 'config.example.json');
  if (!existsSync(p)) {
    if (existsSync(ex)) {
      console.error(`${C.red}缺少 config.json${C.reset}`);
      console.error(`在项目目录里执行：${C.cyan}cp config.example.json config.json${C.reset}`);
      console.error(`然后编辑 config.json，把 apiKey 换成你自己的。`);
    } else {
      console.error(`${C.red}找不到 config.json${C.reset}`);
    }
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${C.red}config.json 格式错误：${e.message}${C.reset}`);
    process.exit(1);
  }
  return {
    ...DEFAULTS,
    ...raw,
    auto: { ...DEFAULTS.auto, ...(raw.auto || {}) },
  };
}

/* ══════════════ 窥视：把这一屏解析成什么，原样打出来 ══════════════ */

/**
 * peek 是调解析器的唯一正确姿势。
 * doctor 只说「几题」，peek 说「第几题、题干是什么、每个选项落在哪个坐标」。
 * 抽错题、坐标偏了，一眼就能看出来。
 */
async function peek() {
  const dev = await openDevice({ mode: 'auto', noisy: true });
  const { w, h } = await dev.screenSize();
  const xml = await dev.dump();

  const dir = path.join(ROOT, 'dump');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `peek-${Date.now()}.xml`);
  writeFileSync(f, xml, 'utf8');

  const { questions, strategy, debug } = extractQuestions(xml, { screenH: h });
  const nodes = parseNodes(xml);

  console.log(
    `\n${C.bold}屏幕${C.reset} ${w}×${h}  ` +
    `${C.gray}节点 ${debug.nodes} / 带字 ${debug.textNodes} / ` +
    `切出 node=${debug.byNode} text=${debug.byText} / 采用 ${strategy}${C.reset}`
  );
  console.log(`${C.gray}快照 ${path.relative(ROOT, f)}${C.reset}\n`);

  if (!questions.length) {
    console.log(`${C.yellow}没切出题目。${C.reset}屏幕上的文字是：\n`);
    const texts = nodes.map(nodeText).filter(Boolean);
    texts.slice(0, 60).forEach((t, i) => console.log(`  ${C.gray}${String(i).padStart(2)}${C.reset} ${t.slice(0, 70)}`));
    console.log(
      `\n${C.gray}如果上面确实是题目内容，把 ${path.basename(f)} 发我。${C.reset}\n`
    );
    return 2;
  }

  for (const q of questions) {
    const conf = q.options.some((o) => o.cx) ? C.green + '可点' + C.reset : C.yellow + '无坐标' + C.reset;
    console.log(`${C.bold}第 ${q.number} 题${C.reset} ${C.cyan}[${q.type}]${C.reset} ${conf}`);
    console.log(`  ${q.stem}`);
    for (const o of q.options) {
      const pos = o.cx ? `${Math.round(o.cx)},${Math.round(o.cy)}` : '—';
      console.log(`  ${C.gray}${o.label}.${C.reset} ${o.text.slice(0, 46)} ${C.gray}@${pos}${C.reset}`);
    }
    if (q.blanks > 1) console.log(`  ${C.gray}（${q.blanks} 个空）${C.reset}`);
    console.log('');
  }

  const bad = questions.filter((q) => !q.options.some((o) => o.cx)).length;
  if (bad) {
    console.log(
      `${C.yellow}${bad} 题没有坐标${C.reset}${C.gray}——会自动退到「按选项文字找节点」，` +
      `准确率略低，但能用。${C.reset}\n`
    );
  }
  return 0;
}

/* ══════════════ 演练：真跑一遍，但一次都不点 ══════════════ */

/**
 * dry 模式存在的理由：
 * 唯一能放心在真实答题页上测试的方式，就是【不发点击】。
 * 它会完整走一遍 抽题 → 解题 → 算落点，
 * 然后把「本来要点哪里」打出来，但绝不调用 input tap。
 * 这样能验证三件事：抽题对不对、答案像不像、坐标靠不靠谱 —— 零副作用。
 */
async function dry() {
  const cfg = loadConfig();
  const real = await openDevice({ mode: 'auto', noisy: true });
  const { w, h } = await real.screenSize();

  const taps = [];
  const dev = {
    ...real,
    async taps(list, opts) {
      taps.push(...list);
      return list.length;
    },
    async tap(x, y) {
      taps.push({ x, y });
    },
    async swipe() {},        // 演练不翻页，防止把页面滑走
    async longPress() {},
  };

  const bank = makeBank(ROOT);
  const engine = createEngine({
    dev,
    screenH: h,
    cfg: { ...cfg, auto: { ...cfg.auto, scrollAdvance: false } },
    log: () => {},
    solve: (qs) => solveQuestions(qs, cfg, bank),
  });

  console.log(
    `\n${C.bold}演练模式${C.reset} ${C.gray}不会发出任何点击，页面会停在原处${C.reset}\n`
  );

  let r;
  try {
    r = await engine.step();
  } catch (e) {
    console.log(`${C.red}失败：${e.message}${C.reset}\n`);
    return 1;
  }

  if (r.action === 'answered') {
    console.log(`${C.green}抽到并解出 ${r.count} 题${C.reset} ${C.gray}[${r.strategy}]${C.reset}\n`);
    taps.forEach((t, i) => {
      console.log(`  ${C.gray}${String(i + 1).padStart(2)}${C.reset} 本应点 (${Math.round(t.x)}, ${Math.round(t.y)})`);
    });
    if (!taps.length) console.log(`  ${C.yellow}一个落点都没算出来${C.reset}`);
    if (r.unresolved?.length) {
      console.log(`\n  ${C.yellow}放弃 ${r.unresolved.length} 题${C.reset}`);
      for (const u of r.unresolved) {
        console.log(`    ${C.gray}第${u.n ?? '?'}题 ${u.reason} ${u.text || ''}${C.reset}`);
      }
    }
    console.log(
      `\n${C.gray}确认上面的坐标落在选项上，就可以正式跑了：` +
      `node src/single.mjs${C.reset}\n`
    );
    return 0;
  }

  if (r.action === 'paused') {
    console.log(`${C.yellow}检测到弹窗（${r.alert}），演练停止。${C.reset}\n`);
    return 1;
  }

  if (r.action === 'error') {
    console.log(`${C.red}没跑通：${r.message}${C.reset}\n`);
    return 1;
  }

  const d = r.debug || {};
  console.log(`${C.yellow}这一屏没识别出题${C.reset} ${C.gray}（${r.action}）${C.reset}`);
  console.log(
    `${C.gray}节点 ${d.nodes ?? '?'} / 带字 ${d.textNodes ?? '?'} / ` +
    `切出 ${d.byNode ?? '?'}|${d.byText ?? '?'}${C.reset}\n`
  );
  console.log(`${C.gray}用 peek 看得更细。${C.reset}\n`);
  return 1;
}

/* ══════════════ 自检 ══════════════ */

async function doctor() {
  console.log(`\n${C.bold}单机版自检${C.reset}\n`);
  let bad = 0;
  const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`);
  const no = (m, hint) => {
    bad++;
    console.log(`  ${C.red}✗${C.reset} ${m}`);
    if (hint) for (const h of [].concat(hint)) console.log(`      ${C.gray}${h}${C.reset}`);
  };

  /* 1. shell 通道 */
  let dev;
  try {
    dev = await openDevice({ mode: 'auto' });
    ok(`shell 通道：${dev.mode}`);
  } catch (e) {
    no('没有可用的 shell 通道', String(e.message).split('\n').slice(0, 8));
    console.log(`\n${C.yellow}后面的检查需要 shell，先解决这个。${C.reset}\n`);
    return 1;
  }

  /* 2. 屏幕 */
  let size = { w: 1080, h: 2400 };
  try {
    size = await dev.screenSize();
    ok(`屏幕 ${size.w}×${size.h}`);
  } catch (_) {
    no('读不到屏幕尺寸');
  }

  /* 3. 前台应用 */
  try {
    const fg = await dev.foreground();
    if (/chaoxing|xuexitong|edu\.cn/i.test(fg)) ok(`前台：学习通`);
    else {
      console.log(`  ${C.yellow}!${C.reset} 前台不是学习通 ${C.gray}${fg.slice(0, 90)}${C.reset}`);
      console.log(`      ${C.gray}自检时可以先切到学习通，再跑一次${C.reset}`);
    }
  } catch (_) {}

  /* 4. 读屏 */
  let xml = '';
  try {
    xml = await dev.dump();
    ok(`读到 UI 树 ${C.gray}${(xml.length / 1024).toFixed(0)} KB${C.reset}`);
    // 存一份快照：出问题时有实物可比对，不用靠猜
    const dir = path.join(ROOT, 'dump');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `doctor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.xml`);
    writeFileSync(f, xml, 'utf8');
    console.log(`      ${C.gray}快照 ${path.relative(ROOT, f)}${C.reset}`);
  } catch (e) {
    no('读不到 UI 树', [e.message]);
  }

  /* 5. 抽题 */
  if (xml) {
    const { questions, strategy, debug } = extractQuestions(xml, { screenH: size.h });
    if (questions.length) {
      ok(`抽到 ${questions.length} 题 ${C.gray}(策略 ${strategy})${C.reset}`);
      const wOpts = questions.filter((q) => q.options.length >= 2).length;
      const wCoord = questions.filter((q) => q.options.some((o) => o.cx)).length;
      console.log(`      ${C.gray}有选项 ${wOpts} 题 / 有坐标 ${wCoord} 题${C.reset}`);
      if (wCoord < questions.length) {
        console.log(`      ${C.yellow}部分题没有坐标，会自动退到「按文本匹配节点」${C.reset}`);
      }
      for (const q of questions.slice(0, 3)) {
        console.log(
          `      ${C.gray}${q.number}. [${q.type}] ${q.stem.slice(0, 26)}… ` +
          `${q.options.map((o) => o.label).join('')}${C.reset}`
        );
      }
    } else {
      console.log(
        `  ${C.yellow}!${C.reset} 没抽到题 ` +
        `${C.gray}(节点 ${debug.nodes} / 带字 ${debug.textNodes} / 切出 ${debug.byNode}|${debug.byText})${C.reset}`
      );
      // 分清两种失败：读不到节点 vs 读到但切不出题 —— 修法完全不同
      if (debug.textNodes === 0) {
        console.log(`      ${C.gray}一个带文字的节点都没有。屏幕可能锁着，或页面还在加载。${C.reset}`);
      } else if (debug.textNodes < 4) {
        console.log(`      ${C.gray}文字太少（${debug.textNodes} 个），不像答题页。翻到有题的页面再跑。${C.reset}`);
      } else {
        console.log(`      ${C.gray}有 ${debug.textNodes} 个文字节点但切不出题——把下面存下的 XML 发我，我按实际结构调。${C.reset}`);
      }
    }
  }

  /* 6. API Key */
  const cfgPath = path.join(ROOT, 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const all = (cfg.providers || []).filter((p) => p.enabled !== false);
      const good = all.filter((p) => isUsableKey(p.apiKey) && p.model);
      if (good.length) ok(`模型 ${good.length} 个${good.length === 1 ? '（会自动双采样补投票）' : ''}`);
      else if (all.length) no('config.json 里的 apiKey 还是占位符', '打开 config.json，把 providers[0].apiKey 换成真实的 key');
      else no('config.json 里没有启用的 provider');
    } catch (_) {
      no('config.json 解析失败');
    }
  } else no('缺少 config.json', 'cp config.example.json config.json 然后填 apiKey');

  /* 7. 中文输入通道（填空/简答才需要） */
  try {
    const out = await dev.raw('ime list -s 2>/dev/null', { timeout: 10000 });
    if (/adbkeyboard/i.test(out)) {
      ok('中文输入通道可用（填空/简答能自动填）');
    } else {
      console.log(`  ${C.yellow}!${C.reset} 没启用 ADBKeyboard ${C.gray}（填空/简答会留给你自己打）${C.reset}`);
      console.log(
        `      ${C.gray}装 ADBKeyboard 后执行：adb shell ime enable com.android.adbkeyboard/.AdbIME${C.reset}`
      );
    }
  } catch (_) {}

  console.log(
    bad
      ? `\n${C.yellow}有 ${bad} 项没通过。${C.reset}\n`
      : `\n${C.green}全部通过，可以进考试了。${C.reset}\n`
  );
  return bad ? 1 : 0;
}

/* ══════════════ 进程不死金身 ══════════════
 * 2026-10-24 实测：拔 USB 的瞬间底层 adb 命令会集体失败，任何一个没接住的
 * Promise 异常都会让 Node 无声退出（15+ 的默认行为）——表现就是「没有任何
 * 提示，程序直接没了」。考场上绝不允许：所有未捕获异常一律记日志、继续跑。
 * 真正要停只有两条路：Ctrl+C，或 touch ~/chaoxing/STOP。 */
function fatalLog(kind, e) {
  try {
    appendFileSync(
      path.join(ROOT, 'dump', 'fatal.log'),
      `${ts()} ${kind} ${e?.stack || e?.message || e}\n`,
      'utf8'
    );
  } catch (_) {}
}
process.on('unhandledRejection', (e) => {
  fatalLog('UNHANDLED_REJECTION', e);
  try { console.error(`${C.gray}· 内部异常已吞掉，继续跑（详情 dump/fatal.log）${C.reset}`); } catch (_) {}
});
process.on('uncaughtException', (e) => {
  fatalLog('UNCAUGHT_EXCEPTION', e);
  try { console.error(`${C.gray}· 内部异常已吞掉，继续跑（详情 dump/fatal.log）${C.reset}`); } catch (_) {}
});
process.on('SIGTERM', () => {
  // vivo 后台管理会发 SIGTERM 软杀。吞掉——真想停用 Ctrl+C 或 STOP 文件。
  fatalLog('SIGTERM_SWALLOWED', null);
});

/* ══════════════ 正式运行 ══════════════ */

async function run() {
  const cfg = loadConfig();

  const dev = await openDevice({ mode: 'auto', noisy: true });
  const size = await dev.screenSize();
  const bank = makeBank(ROOT);

  const dir = path.join(ROOT, 'dump');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `session-${Date.now()}.log`);
  const record = (line) => {
    try { appendFileSync(logFile, `${ts()} ${line}\n`, 'utf8'); } catch (_) {}
  };

  // 单实例保护：两个引擎同时点屏幕会互相打架（一个翻页、一个点选项），
  // 比不跑还糟。启动时检查上一次的 pid 是否还活着。
  const PIDFILE = path.join(ROOT, 'engine.pid');
  try {
    if (existsSync(PIDFILE)) {
      const oldPid = Number(String(readFileSync(PIDFILE, 'utf8')).trim());
      if (oldPid && oldPid !== process.pid) {
        let alive = false;
        try {
          process.kill(oldPid, 0);
          alive = true;
        } catch (_) {}
        if (alive) {
          console.log(
            `${C.yellow}已有引擎在跑（pid ${oldPid}），这次不再重复启动${C.reset}` +
            `${C.gray}——两个程序抢着点屏幕只会互相干扰。\n` +
            `要换新版：touch ~/chaoxing/STOP 停掉旧的，再跑本脚本。${C.reset}`
          );
          return 1;
        }
      }
    }
    writeFileSync(PIDFILE, String(process.pid), 'utf8');
  } catch (_) {}

  // 正常退出时清掉自己的 pidfile，别留下误判的残留
  process.on('exit', () => {
    try {
      if (String(readFileSync(PIDFILE, 'utf8')).trim() === String(process.pid)) unlinkSync(PIDFILE);
    } catch (_) {}
  });

  console.log(
    `${C.green}✓${C.reset} 通道 ${dev.mode} · 屏幕 ${size.w}×${size.h}\n` +
    `${C.gray}进考试页后不要碰屏幕。程序不会自动退出：答完一套会待命，` +
    `你开下一套它自动接着答。\n停止方式：Termux 里 Ctrl+C，或另开一个会话执行 touch ~/chaoxing/STOP` +
    `。日志：dump/session-*.log${C.reset}\n`
  );

  // 通道代理：dev 可以在中途被替换（adb 挂了降级到 rish），引擎完全无感知。
  // 没有电脑时，这是「adbd 被系统杀掉」之后唯一的自救通道。
  let currentDev = dev;
  let swappedRish = false;
  const devLive = new Proxy(
    {},
    {
      get(_, prop) {
        const v = currentDev[prop];
        return typeof v === 'function' ? (...a) => v.apply(currentDev, a) : v;
      },
    }
  );

  const engine = createEngine({
    dev: devLive,
    screenH: size.h,
    cfg,
    log: () => {},
    solve: (qs) => solveQuestions(qs, cfg, bank),
  });

  let pausedFor = '';
  let stop = false;
  let lastAction = '';
  let quietRounds = 0;
  let errStreak = 0;

  process.on('SIGINT', () => {
    stop = true;
  });

  // 【永不自动退出】2026-10-24 实测：第一套交卷后、进第二套之前的中转页
  // 会撞上 ready-to-submit / finished 判定，程序自己收工，第二套就没人答了。
  // 考场上最贵的就是「程序以为结束了」——所以所有退出出口全部焊死，
  // 永远循环待命，只有用户下令（Ctrl+C 或 STOP 标记文件）才停。
  const STOPFILE = path.join(ROOT, 'STOP');

  while (!stop) {
    if (existsSync(STOPFILE)) {
      try { unlinkSync(STOPFILE); } catch (_) {}
      console.log(`\n${C.yellow}检测到 STOP 标记，停止。${C.reset}`);
      record('STOP_FILE');
      break;
    }

    let r;
    try {
      r = await engine.step();
    } catch (e) {
      console.log(`${C.red}异常：${e.message}${C.reset}`);
      record(`ERROR ${e.message}`);
      errStreak++;
      // 连续异常 = 通道大概率断了（拔线瞬间 vivo 重置 adbd 的典型症状）。
      // 主动把 127.0.0.1:5555 重新 connect 回来，连上就自动恢复，不用人管。
      if (errStreak >= 2 && errStreak % 2 === 0) {
        const okRe = await dev.reconnect();
        console.log(
          okRe
            ? `${C.gray}· 通道已重新连接，继续${C.reset}`
            : `${C.gray}· 通道暂时连不上，稍后自动再试${C.reset}`
        );
        record(`RECONNECT ${okRe ? 'OK' : 'FAIL'}`);
        if (okRe) errStreak = 0;
      }

      // adb 通道连续 6 次救不回来 → 降级到 rish（Shizuku）。没有电脑时
      // 这是 adbd 被系统杀掉之后唯一的活路。rish 在本机偶发卡死，全部
      // 用超时兜住，失败就继续用 adb 重试，绝不让它拖死主循环。
      if (errStreak >= 6 && !swappedRish) {
        try {
          const rish = await Promise.race([
            openDevice({ mode: 'rish' }).catch(() => null),
            new Promise((r) => setTimeout(() => r(null), 10000)),
          ]);
          if (rish) {
            const probe = await Promise.race([
              rish.raw('echo __cx__').catch(() => ''),
              new Promise((r) => setTimeout(() => r(''), 8000)),
            ]);
            if (/__cx__/.test(String(probe))) {
              currentDev = rish;
              swappedRish = true;
              errStreak = 0;
              console.log(`${C.green}✓${C.reset} adb 断开，已降级到 rish 通道继续跑`);
              record('FALLBACK_RISH OK');
            } else {
              record('FALLBACK_RISH FAIL');
            }
          }
        } catch (_) {}
      }
      await wait(2500);
      continue;
    }

    switch (r.action) {
      case 'answered': {
        quietRounds = 0;
        errStreak = 0;
        const parts = [`答 ${r.count}`];
        if (r.taps) parts.push(`点 ${r.taps}`);
        if (r.unresolved?.length) parts.push(`放弃 ${r.unresolved.length}`);
        console.log(`${C.green}●${C.reset} ${parts.join(' · ')} ${C.gray}[${r.strategy}]${C.reset}`);
        record(`ANSWER count=${r.count} taps=${r.taps} strategy=${r.strategy}`);

        for (const u of r.unresolved || []) {
          const why = {
            'no-answer': '模型没给答案',
            'llm-error': '模型请求失败（网络/限流）',
            'no-target': '找不到选项位置',
            partial: '多选只定位到一部分',
            'fill-manual': '填空需手打',
          }[u.reason] || u.reason;
          console.log(`   ${C.yellow}第${u.n ?? '?'}题跳过${C.reset} ${C.gray}${why}${u.text ? ' | ' + u.text : ''}${C.reset}`);
          record(`SKIP n=${u.n} reason=${u.reason} detail=${u.detail || ''} text=${u.text || ''}`);
        }
        break;
      }

      case 'advanced':
        quietRounds = 0;
        errStreak = 0;
        console.log(`${C.gray}→ ${r.how === 'next' || r.how === 'next-fixed' ? '下一题' : '上滑' }${C.reset}`);
        record(`ADVANCE ${r.how}`);
        break;

      case 'paused': {
        const label = {
          face: '人脸识别',
          proctor: '切屏/离开提示',
          login: '登录失效',
          confirm: '交卷确认框',
          'not-chaoxing': '前台不是学习通（已挂起防误触，切回学习通自动恢复）',
        }[r.alert] || r.alert;
        if (pausedFor !== r.alert) {
          console.log(`\n${C.yellow}⚠ 检测到「${label}」${C.reset}`);
          console.log(`${C.gray}  已停手，等你处理。处理完这个弹窗后自动继续。${C.reset}\n`);
          record(`PAUSE ${r.alert}`);
          pausedFor = r.alert;
        }
        await wait(2500);
        break;
      }

      case 'ready-to-submit':
        if (engine.state.answered === 0) {
          // 外面目录页上若有「提交」字样的按钮，advance 会误报 ready-to-submit。
          // 一题没答过，这个判定不可信 —— 继续等。
          if (pausedFor !== 'waiting') {
            console.log(`${C.gray}· 还没进到答题页，继续等${C.reset}`);
            record('WAITING_FOR_EXAM');
            pausedFor = 'waiting';
          }
          await wait(2500);
          break;
        }
        console.log(`\n${C.cyan}题目全部答完，看到「提交」按钮了。${C.reset}`);
        console.log(`${C.gray}  按设计不自动交卷——你现在自己滚一遍检查，然后点提交。${C.reset}`);
        console.log(`${C.gray}  交完卷程序会待命等下一套；我不会退出，只有你下令才停。${C.reset}`);
        record('READY_TO_SUBMIT');
        await wait(4000);
        break;

      case 'finished':
        // 【永不自动退出】第一套交卷成功页会走到这里 —— 以前直接 return 退出，
        // 第二套就没人答了。现在转为待命：等你开下一套，看到新题自动接上。
        if (pausedFor !== 'between') {
          console.log(
            `\n${C.green}这一套结束了（检测到交卷成功页）。${C.reset}` +
            `${C.gray}程序待命中：去开下一套/下一场，我看到题目自动开始。${C.reset}`
          );
          record('SET_DONE_WAITING');
          pausedFor = 'between';
        }
        await wait(3000);
        break;

      case 'finished-likely':
        // 【永不自动退出】页面暂时没题 ≠ 答完了。可能是中转页、成绩页、
        // 目录页，也可能只是 WebView 又瞎了。全部转为待命继续轮询。
        if (pausedFor !== 'between' && pausedFor !== 'waiting') {
          console.log(
            `${C.gray}· 这一屏没有可答的题，继续待命（进到答题页自动开始）${C.reset}`
          );
          record('NO_MORE_ON_SCREEN_WAITING');
          pausedFor = 'between';
        }
        await wait(2500);
        break;

      case 'nothing':
      case 'idle': {
        quietRounds++;
        if (r.waiting && pausedFor !== 'waiting') {
          console.log(
            `${C.cyan}· 等待进入答题页…${C.reset} ${C.gray}（现在可以打开学习通、点进考试，程序看到题目会自动开始）${C.reset}`
          );
          record('WAITING_FOR_EXAM');
          pausedFor = 'waiting';
        }
        if (quietRounds === 1 || quietRounds % 10 === 0) {
          const hint = r.debug
            ? `节点 ${r.debug.nodes}/带字 ${r.debug.textNodes}/切出 ${r.debug.byNode}|${r.debug.byText}`
            : '';
          console.log(`${C.gray}· 这一屏没识别到题 ${hint}${C.reset}`);
          record(`IDLE ${hint}`);
        }
        if (quietRounds === 6) {
          console.log(
            `${C.yellow}  连续 6 轮读不到题${C.reset}\n` +
            `${C.gray}  屏幕上如果一直不动，用手在学习通页面上轻轻上下滑一下（别点选项），` +
            `程序读到新节点会自己接着跑。${C.reset}`
          );
          record('IDLE_STUCK_HINT');
        }
        await wait(2200);
        break;
      }

      case 'error':
        console.log(`${C.red}× ${r.message}${C.reset}`);
        record(`ERR ${r.message}`);
        await wait(3000);
        break;

      default:
        await wait(1200);
    }

    if (r.action === 'paused') continue;
    // 还在「等待进入答题页」状态时不清标记，否则等待提示会每轮重复打印
    if (pausedFor === 'waiting' && r.waiting) continue;
    // 「待命」状态同理：中转页/成绩页/空屏会连续多轮命中 finished 类判定，
    // 标记不保持的话提示语会每 3 秒刷一遍。只有真正开始干活（答题/翻页）
    // 或出错时才清，进入下一套后提示会重新出现一次。
    if (
      pausedFor === 'between' &&
      ['finished', 'finished-likely', 'idle', 'nothing', 'ready-to-submit'].includes(r.action)
    ) {
      continue;
    }
    pausedFor = '';
    lastAction = r.action;
  }

  const s = engine.state;
  console.log(
    `\n${C.bold}结束${C.reset} 答 ${s.answered} 题 · 放弃 ${s.skipped} 次 · 轮次 ${s.round}`
  );
  if (s.answered === 0) {
    console.log(
      `${C.yellow}一题都没答就结束了${C.reset} —— ` +
      `${C.gray}多半是自检后没能进到答题页，或屏幕中途熄了。看上面日志找原因。${C.reset}`
    );
  }
  if (s.pending.size) {
    console.log(
      `${C.yellow}有 ${s.pending.size} 题点了但没能确认选中${C.reset} ` +
      `${C.gray}（界面不暴露选中态，或点到了非可点区域）——交卷前自己看一眼${C.reset}`
    );
  }
  console.log(`${C.gray}题库累计 ${bank.size ?? 0} 条 · 日志 ${logFile}${C.reset}\n`);
  return 0;
}

/* ══════════════ 入口 ══════════════ */

const mode = (process.argv[2] || '').toLowerCase();

if (mode === 'doctor' || mode === 'check') {
  doctor()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${C.red}自检异常：${e.message}${C.reset}`);
      process.exit(1);
    });
} else if (mode === 'peek' || mode === 'p') {
  peek()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${C.red}失败：${e.message}${C.reset}`);
      process.exit(1);
    });
} else if (mode === 'dry' || mode === 'try') {
  dry()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${C.red}失败：${e.message}${C.reset}`);
      process.exit(1);
    });
} else if (mode === 'help' || mode === '-h' || mode === '--help') {
  console.log(`
${C.bold}用法${C.reset}
  node src/single.mjs doctor   自检（先跑这个）
  node src/single.mjs peek     看清这一屏被解析成什么题（调解析器用）
  node src/single.mjs dry      演练：完整解一遍但不点（安全验证）
  node src/single.mjs          开始自动答题
`);
} else {
  run()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`\n${C.red}程序异常：${e.message}${C.reset}`);
      if (e.details) e.details.forEach((d) => console.error(`  ${C.gray}${d}${C.reset}`));
      process.exit(1);
    });
}
