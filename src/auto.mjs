/**
 * auto.mjs — 自动答题引擎（单机版）
 *
 * 定位：手机在自己手里，屏幕上只有学习通。
 *       所以答案不需要「显示」给任何人看——引擎自己点。
 *
 * 设计约束（每一条都对应一个真实的失败模式）：
 *   1. 绝不切屏。所有动作走 shell 注入，不弹 Activity、不挂悬浮窗。
 *   2. 绝不点「提交」。除非显式配置 auto.submit = true，否则只答不交。
 *   3. 遇到人脸/切屏提示立刻停手。这类弹窗一出现，乱点就是自杀。
 *   4. 点击目标必须落在题目区域内，且文本得对得上选项。
 *      宁可放弃一题，也不能乱点——点错一题只丢分，点到「交卷」全盘归零。
 *   5. 节奏必须像人。连续 3 秒答完 10 题是行为异常，不是效率。
 */
import crypto from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { extractQuestions, parseNodes, nodeText, QTYPE } from './uia.mjs';
import { localExec, q as shq } from './sh.mjs';

/* ══════════════ 文本工具 ══════════════ */

const norm = (s) =>
  String(s ?? '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/^[A-Za-z][.、．)）:：]/, '')
    .trim();

const OPT_LABEL_RE = /^([A-Ha-h])\s*[.、．)）:：]\s*([\s\S]*)$/;

/** 题目指纹：同一题在不同轮次必须得到同一个 key */
export function qkey(q) {
  return crypto
    .createHash('sha1')
    .update(`${q.type}|${norm(q.stem)}`)
    .digest('hex')
    .slice(0, 12);
}

/** 把所有可读文本拼起来（用于检测弹窗、提示语） */
export function allText(nodes) {
  return nodes.map(nodeText).filter(Boolean).join('\n');
}

/* ══════════════ 需要人介入的界面 ══════════════ */

/**
 * 这些字样一出现，说明考试要求你本人做点什么。
 * 此时任何自动化动作都是在赌命，必须立刻停。
 */
const ALERT_RULES = [
  { kind: 'face', re: /人脸识别|请正对摄像头|眨眨眼|张张嘴|摇摇头|活体检测|请将面部|识别中请勿/ },
  { kind: 'proctor', re: /切屏|离开考试|请勿切换|检测到您|离开页面|回到考试/ },
  { kind: 'login', re: /重新登录|登录已失效|账号异常|请验证/ },
  { kind: 'confirm', re: /确定要交卷|确认提交|还有.*未作答/ },
];

export function detectAlert(blob) {
  for (const r of ALERT_RULES) {
    if (r.re.test(blob)) return r.kind;
  }
  return null;
}

/** 考试已经结束的界面 */
export function isFinished(blob) {
  return /已交卷|考试已结束|提交成功|交卷成功|成绩已生成/.test(blob);
}

/* ══════════════ 危险目标拦截 ══════════════ */

const DANGER_RE = /交卷|提交|退出|返回|结束考试|放弃|上一题|重做/;

function isDangerous(node) {
  const t = nodeText(node);
  if (DANGER_RE.test(t)) return true;
  return false;
}

/* ══════════════ 题目空间范围 ══════════════ */

/**
 * 一题占据的垂直范围。
 *
 * 坑：q.bounds 来自「题号节点」，只有几十像素高。
 * 拿它当题目范围，选项全落在范围外，判断选中态会永远失败。
 * 所以必须把题号范围和选项范围合并。
 */
function questionRange(q) {
  const ys = [];
  if (q.bounds && q.bounds.h > 0) ys.push([q.bounds.y1, q.bounds.y2]);
  for (const o of q.options || []) {
    if (o.bounds && o.bounds.h > 0) ys.push([o.bounds.y1, o.bounds.y2]);
  }
  if (!ys.length) return null;
  return {
    y1: Math.min(...ys.map((v) => v[0])),
    y2: Math.max(...ys.map((v) => v[1])),
  };
}

/* ══════════════ 选项 → 点击坐标 ══════════════ */

/**
 * 把答案里的「B」变成屏幕上的一个点。
 *
 * 三级解析，成功率从高到低：
 *   1. 选项自带坐标（原生渲染，选项是独立 TextView）
 *   2. 全树里找文本等于选项内容的节点（WebView 里选项常是独立可点节点）
 *   3. 大文本块内按行号估算（兜底，风险最高，可关闭）
 */
export function resolveOptionTarget(q, val, nodes, { estimate = true } = {}) {
  const opt = matchOption(q, val);
  if (!opt) return null;

  // ① 自带坐标
  if (opt.cx && opt.cy && opt.cx > 0 && opt.cy > 0) {
    return { label: opt.label, x: opt.cx, y: opt.cy, how: 'coord' };
  }

  // ② 按文本找节点
  const want = norm(opt.text);
  if (want.length >= 1) {
    const hits = nodes.filter((n) => {
      const t = norm(nodeText(n));
      return t && (t === want || t === norm(opt.label + opt.text));
    });
    if (hits.length) {
      // 多个命中时优先可点的、面积大的
      const best = hits.sort((a, b) => (b.clickable - a.clickable) || (b.bounds.w * b.bounds.h - a.bounds.w * a.bounds.h))[0];
      const c = center(best.bounds);
      if (c) return { label: opt.label, x: c.x, y: c.y, how: 'text' };
    }
    // 包含匹配（选项文本被前后缀污染时）
    // 关键约束：节点文本不能比选项长太多，高度不能太大。
    // 否则整块 WebView（一屏所有题的文本）也会「包含」这个选项，
    // 取它的中心 = 屏幕正中 = 点错行。
    const loose = nodes.filter((n) => {
      const t = norm(nodeText(n));
      if (want.length < 4) return false;
      if (!t.includes(want)) return false;
      if (t.length > want.length + 12) return false;
      if (n.bounds.h > 400) return false;
      return true;
    });
    if (loose.length === 1) {
      const c = center(loose[0].bounds);
      if (c) return { label: opt.label, x: c.x, y: c.y, how: 'text~' };
    }
  }

  // ③ 按行号估算
  if (estimate) {
    const est = estimateLine(q, opt, nodes);
    if (est) return { ...est, how: 'estimate' };
  }

  return null;
}

function center(b) {
  if (!b || !b.h) return null;
  return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
}

/** 在整块文本节点里，按选项所在行号估一个 y */
function estimateLine(q, opt, nodes) {
  const stemKey = norm(q.stem).slice(0, 12);
  if (stemKey.length < 4) return null;

  const host = nodes
    .filter((n) => {
      const t = norm(nodeText(n));
      return t.includes(stemKey) && n.bounds && n.bounds.h > 60;
    })
    .sort((a, b) => nodeText(b).length - nodeText(a).length)[0];
  if (!host) return null;

  const raw = nodeText(host);
  if (DANGER_RE.test(raw)) return null;

  const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  const idx = lines.findIndex((l) => {
    const m = l.match(OPT_LABEL_RE);
    return m && m[1].toUpperCase() === opt.label && norm(m[2]).startsWith(norm(opt.text).slice(0, 6));
  });
  if (idx < 0) return null;

  const h = (host.bounds.y2 - host.bounds.y1) / lines.length;
  const y = host.bounds.y1 + (idx + 0.5) * h;
  if (y < host.bounds.y1 + 4 || y > host.bounds.y2 - 4) return null;

  return { label: opt.label, x: host.bounds.x1 + Math.min(160, (host.bounds.x2 - host.bounds.x1) * 0.15), y };
}

/** 把一个答案值映射到具体选项 */
export function matchOption(q, val) {
  const opts = q.options || [];
  if (!opts.length) return null;
  const s = String(val ?? '').trim();
  if (!s) return null;

  // ① 单个字母
  const letter = s.match(/^([A-Ha-h])$/);
  if (letter) {
    const hit = opts.find((o) => o.label.toUpperCase() === letter[1].toUpperCase());
    if (hit) return hit;
  }

  // ② 文本全等
  const ns = norm(s);
  const byText = opts.find((o) => norm(o.text) === ns);
  if (byText) return byText;

  // ③ 判断题语义
  if (q.type === QTYPE.JUDGE || opts.length === 2) {
    const T = /^(正确|对|是|√|true|t|yes|y|1)$/i.test(ns);
    const F = /^(错误|错|否|×|x|false|f|no|n|0)$/i.test(ns);
    if (T || F) {
      const want = T ? /^(正确|对|是|√|true)$/i : /^(错误|错|否|×|false)$/i;
      const hit = opts.find((o) => want.test(norm(o.text)));
      if (hit) return hit;
    }
  }

  // ④ 前缀匹配
  const byPrefix = opts.find((o) => {
    const t = norm(o.text);
    return t.length >= 2 && (t.startsWith(ns.slice(0, 8)) || ns.startsWith(t.slice(0, 8)));
  });
  return byPrefix || null;
}

/* ══════════════ 节奏 ══════════════ */

const rand = ([a, b]) => a + Math.round(Math.random() * (b - a));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════ 引擎 ══════════════ */

/**
 * @param {object} o
 * @param {object} o.dev    设备适配器（sh.mjs）
 * @param {Function} o.solve async (questions) => results[]  已组装好的解题函数
 * @param {object} o.cfg    配置
 * @param {Function} o.log
 */
export function createEngine({ dev, solve, cfg = {}, log = () => {}, screenH = 2400 }) {
  const A = cfg.auto || {};
  // 节奏。默认值原来写的是 [6000,15000]「模拟思考」，实测单题多花 10 秒以上，
  // 50 题要多花 8 分钟。真正决定观感的是「答得快不快」，而不是「停顿像不像人」，
  // 所以默认改成 300-700ms；想更保守就在 config.json 里把 auto.thinkDelayMs 调大。
  const think = A.thinkDelayMs || [300, 700];
  const tapGap = A.tapGapMs || [140, 300];
  // 点完「下一题」后等多久。不需要长等：下一次读屏本身就要 2 秒，
  // 页面早就翻过去了。这里只是给 WebView 一点时间开始过渡。
  const advanceWait = A.advanceWaitMs || [350, 650];
  const settleRounds = A.settleRounds ?? 2;
  const estimateTap = A.estimateTap !== false;
  const allowSubmit = A.submit === true;
  const autoAdvance = A.autoAdvance !== false;
  const scrollAdvance = A.scrollAdvance !== false;
  const maxRounds = A.maxRounds ?? 400;

  const state = {
    done: new Map(),      // key → {round}
    pending: new Map(),   // 待验证：key → {question, labels}
    bad: new Map(),       // key → 尝试次数，超过 2 次不再重解（省 token）
    round: 0,
    answered: 0,
    skipped: 0,
    lastAlert: null,
    finished: false,
  };

  let idleStreak = 0;
  let lastSig = '';

  /** 抓一次界面 */
  async function grab() {
    const xml = await dev.dump();
    const nodes = parseNodes(xml);
    return { xml, nodes, blob: allText(nodes) };
  }

  /**
   * 抓界面，并处理「WebView 突然不暴露无障碍树」这个真机故障。
   *
   * 实测（iQOO Neo9 / 学习通 WebView）：连续答十几题后，整棵树会突然
   * 从 58 个节点 / 17 段文字掉到 26 个节点 / 1 段文字（只剩标题栏），
   * 此时无论怎么重读都是空的 —— 程序就「瞎」了，只能空转。
   * 原因在 Chromium 的虚拟节点缓存失效后不再主动上报；轻点一下标题区域
   * 会产生一次新的无障碍事件，树立刻恢复（实测 3128B → 10130B）。
   *
   * 为什么要自动做：考场上没人能帮你点。不自动唤醒，答到一半就停了。
   */
  /** 这一屏到底有没有题 —— 这才是「醒没醒」唯一可靠的判据 */
  function readQuestions(snap) {
    try {
      return extractQuestions(snap.xml, { screenH });
    } catch (_) {
      return { questions: [] };
    }
  }

  /**
   * 抓一次界面。
   *
   * 这里**故意不做**任何唤醒动作。唤醒必须靠真实触摸，而触摸落在人脸页、
   * 交卷确认框上会有副作用，所以唤醒统一放在 step() 里、等危险界面判完之后再做。
   * 之前把唤醒塞在这里，结果人脸页会先滑两下才停手（测试当场抓到）。
   */
  async function grabAwake() {
    return grab();
  }

  /**
   * 把哑掉的 WebView 重新弄醒。
   *
   * 做法分两级，代价从低到高：
   *
   * ① 小幅上下滑（无副作用，覆盖「只是没重排」的情况）
   * ② 点底部原生导航「上一题」→ 树恢复 → 点「下一题」回到原来那一题
   *
   * 为什么第 ② 级是非点不可：实测（iQOO Neo9，第 33 题起）WebView 失明后，
   * 无论怎么滑、怎么点题干文字，节点树都停在 10KB / 1 段文字不动；
   * 而底部那两个导航按钮是**原生控件**（带 content-desc、clickable=true），
   * 点一下会让 WebView 整体换页重绘，树立刻恢复到 22KB。
   * 这就是「手动点一下下一题就好了」的真正原因。
   *
   * 为什么先点「上一题」而不是「下一题」：
   * 最后一题的「下一题」位置会变成「提交」，点下去就是交卷 —— 绝不能赌。
   * 「上一题」永远存在、永远只是往回翻。翻回去读到树之后，
   * 再确认右侧按钮确实是「下一题」，才点回来。
   */
  async function revive() {
    try {
      const { w, h } = await dev.screenSize();
      const cx = Math.round(w / 2);

      // ① 无副作用：轻微上下滑，净位移 0
      for (const [a, b] of [
        [0.70, 0.60],
        [0.60, 0.70],
      ]) {
        await dev.swipe(cx, Math.round(h * a), cx, Math.round(h * b), 220);
        await wait(650);
        const s = await grab();
        if (readQuestions(s).questions.length) return s;
      }

      // ② 底部原生导航（位置按屏幕比例算，实测 1260×2800 上约 202/805 × 2699）
      const prevPt = { x: Math.round(w * 0.16), y: Math.round(h * 0.964) };
      const nextPt = { x: Math.round(w * 0.639), y: Math.round(h * 0.964) };
      const SUBMIT = /^(提交|交卷|提交试卷|确认交卷)$/;

      await dev.tap(prevPt.x, prevPt.y);
      await wait(1400);
      let s = await grab();

      if (!readQuestions(s).questions.length) {
        // 「上一题」也没能把树弄回来（多半本来就在第一题）。
        // 退而点「下一题」，但必须确认它不是提交按钮。
        if (s.nodes.some((n) => SUBMIT.test(nodeText(n).trim()))) return null;
        await dev.tap(nextPt.x, nextPt.y);
        await wait(1400);
        s = await grab();
        return readQuestions(s).questions.length ? s : null;
      }

      // 树回来了，但页面现在停在**前一题** —— 必须点回原来那一题。
      // 只有确认右侧按钮写的确实是「下一题」才点，防止最后一题变成提交。
      const hasNext = s.nodes.some((n) => /^下一题$/.test(nodeText(n).trim()));
      if (hasNext) {
        await dev.tap(nextPt.x, nextPt.y);
        await wait(1400);
        const back = await grab();
        if (readQuestions(back).questions.length) return back;
      }
      // 点不回去也不要紧：state.done 里有前一题，下一轮会被跳过，不会重复点。
      return s;
    } catch (_) {
      return null;
    }
  }

  // 为什么滑动不一定够：瞎的时候我们并不知道屏幕上是什么，点选项可能把它点掉，
  // 所以第 ① 级只用滑动；真正的唤醒交给原生导航按钮（见上面第 ② 级）。

  /** 主循环一步 */
  async function step() {
    state.round++;

    // 安全闸（第一优先级）：前台不是学习通时绝不碰屏幕。
    // 引擎的全部动作就是 tap/swipe —— 一旦意外离开了考试页（退到桌面、
    // 被别的应用覆盖），这些动作会点在别处：在桌面上点一下图标就是
    // 打开应用。2026-10-24 实测发生过：卷子答完后界面落到桌面，
    // 引擎盲点把联系人应用点开了。挂起，等用户切回学习通自动恢复。
    let inCx = true;
    try {
      inCx = await dev.inChaoxing();
    } catch (_) {
      /* 查询失败时不拦，走原有流程 */
    }
    if (!inCx) {
      return { action: 'paused', alert: 'not-chaoxing' };
    }

    let snap;
    try {
      snap = await grabAwake();
    } catch (e) {
      return { action: 'error', message: e.message };
    }
    let { nodes, blob } = snap;

    /* --- 1. 危险界面：立刻停 --- */
    const alert = detectAlert(blob);

    // 人脸 / 登录 / 确认交卷：这些是真会挡住答题的，见到就停。
    // 「切屏提示」不能一律停 —— 答题页本身就带「请勿切屏」之类的提示文字，
    // 实测一场下来误停 4 次，每次都白等几十秒。真正的切屏弹窗会盖住题目，
    // 所以留到抽题之后再判断：抽得出题 = 没有被挡住。
    if (alert && alert.kind !== 'proctor') {
      state.lastAlert = alert;
      return { action: 'paused', alert };
    }

    if (isFinished(blob)) {
      state.finished = true;
      return { action: 'finished' };
    }

    /* --- 2. 抽题 --- */
    let parsed = extractQuestions(snap.xml, { screenH });

    // 切不出题，先怀疑是 WebView 又「哑」了（真机实测：答十几题后必发生）。
    // 唤醒一次再解析；不唤醒就只能一直空转，考场上等于停摆。
    if (!parsed.questions.length) {
      const woke = await revive();
      if (woke) {
        const re = extractQuestions(woke.xml, { screenH });
        if (re.questions.length) {
          snap = woke;
          nodes = woke.nodes;
          blob = woke.blob;
          parsed = re;
        }
      }
    }

    const { questions, strategy, debug } = parsed;
    if (!questions.length) {
      // 一题都抽不出来，而且前面看到过切屏提示 → 这次是真的被弹窗挡住了，停手
      if (alert) {
        state.lastAlert = alert;
        return { action: 'paused', alert };
      }
      // 启动时序是「先跑引擎，再由人点进考试」，所以引擎启动后的头一段
      // 时间看到的是学习通目录页/列表页 —— 没有题是【正常状态】。
      // 在答到第一题之前：不翻页（advance 会盲滑目录）、不唤醒、绝不收工，
      // 安静轮询，等真正的答题页出现。
      if (state.answered === 0) {
        return { action: 'idle', debug, strategy, waiting: true };
      }
      idleStreak++;
      if (idleStreak >= settleRounds + 1) return { action: 'nothing', debug, strategy };
      return { action: 'idle', debug, strategy };
    }

    for (const q of questions) q.key = qkey(q);

    /* 考试须知 / 承诺书里的「已阅读并知晓…」不是题目，是勾选项。
     * 2026-10-24 实测：它们被当填空题送进模型 → 模型没答案 → 记一次
     * 「放弃」，日志被污染，每轮还重复处理。识别出来直接记入已处理。 */
    const NOTICE = /已阅读并知晓|我已阅读|本人承诺|考试承诺|考试须知|考试纪律|不离开或退出考试/;
    for (const q of questions) {
      if (NOTICE.test(q.stem || '')) state.done.set(q.key, { round: state.round, notice: true });
    }

    /* --- 3. 验证上一轮点的有没有生效 --- */
    verifyPending(questions, nodes);

    /* --- 4. 挑出还没答的（解不出的题最多试 2 次，之后放弃，避免空烧 token） --- */
    const fresh = questions.filter(
      (q) =>
        !state.done.has(q.key) &&
        (state.bad.get(q.key) || 0) < 2 &&
        !visuallyAnswered(q, nodes)
    );
    if (!fresh.length) {
      // 界面完全没变 → 说明滚动/翻页也到头了，加速收敛
      const sig = qkey({ type: 'page', stem: blob.slice(0, 400) });
      if (sig === lastSig) idleStreak += 2;
      else idleStreak++;
      lastSig = sig;

      // 先看这一屏到底有没有翻页入口。
      //
      // 真机实测：失明会在同一场里反复犯，第二次常在三十几题。症状是节点树里
      // 「下一题」直接消失，advance() 于是只能盲上滑；滑两次页面没变化，
      // 就被判定「没有更多可答的题了」并 return 0 退出 —— 后面的题全漏，
      // 而屏幕上明明还停在第 33 题。
      // 所以：找不到导航入口时，先当成失明去唤醒，绝不能直接收工。
      const NAV = /^(下一题|下一页|继续|下一步|下一部分|提交|交卷|提交试卷|确认交卷)$/;
      const hasNav = nodes.some((n) => NAV.test(nodeText(n).trim()));
      if (!hasNav) {
        const woke = await revive();
        if (woke) {
          nodes = woke.nodes;
          blob = woke.blob;
          const re = extractQuestions(woke.xml, { screenH });
          const left = re.questions.filter((q) => {
            const k = qkey(q);
            return !state.done.has(k) && (state.bad.get(k) || 0) < 2;
          });
          if (left.length) {
            // 唤醒后确实还有没答的题 → 立刻回到正常流程
            idleStreak = 0;
            lastSig = '';
            return { action: 'idle', debug, strategy };
          }
        }
      }

      const adv = await advance(nodes, { singlePage: questions.length === 1 });
      if (adv === 'submit') {
        return { action: allowSubmit ? 'submitting' : 'ready-to-submit', strategy };
      }
      if (adv === 'none' || idleStreak >= settleRounds + 4) {
        return { action: 'finished-likely', strategy };
      }
      await wait(rand([700, 1500]));
      return { action: 'advanced', how: adv, strategy };
    }

    idleStreak = 0;
    lastSig = '';

    /* --- 5. 解题 --- */
    let results;
    try {
      results = await solve(fresh);
    } catch (e) {
      return { action: 'error', message: `解题失败：${e.message}` };
    }

    /* --- 6. 逐题落点 + 点击 ---
       一次只点一题：某个选项被选中后，页面可能回流（选项展开/换行），
       打包一整屏的点击会按旧坐标打到错的位置。 */
    let tapCount = 0;
    const applied = [];
    const unresolved = [];

    for (let i = 0; i < fresh.length; i++) {
      const q = fresh[i];
      const r = results[i] || {};
      if (r.answer == null) {
        // 必须留下题干和内核原因（no_valid_candidate / error / missing）：
        // 否则日志只有一句「模型没给答案」，事后不知道是哪道题、为什么。
        unresolved.push({
          q,
          reason: r.reason === 'error' ? 'llm-error' : 'no-answer',
          text: String(q.stem || '').slice(0, 40),
          detail: r.reason || '',
        });
        continue;
      }

      const letters = Array.isArray(r.answer) ? r.answer : [r.answer];

      // 填空题/简答：走输入法注入（ADBKeyboard）
      if (q.type === QTYPE.FILL || q.type === QTYPE.QA || q.type === QTYPE.WORD_FILL) {
        const okFill = await fillText(q, r.answer, nodes, fresh);
        if (okFill) {
          applied.push(q);
          // 点输入框 + 键盘弹出/收起会让页面滚动，后续选择题的旧坐标不可信。
          // 混排卷（填空+选择同屏）必须重抓，否则选项会点错位置。
          try {
            const rg = await grab();
            if (rg && rg.nodes && rg.nodes.length) {
              nodes = rg.nodes;
              blob = rg.blob || blob;
            }
          } catch (_) {
            /* 重抓失败就沿用旧坐标，好过中断 */
          }
        } else {
          unresolved.push({
            q,
            reason: 'fill-manual',
            detail: lastFillFail,
            text: fmtText(r.answer),
          });
        }
        continue;
      }

      const local = [];
      for (const v of letters) {
        const t = resolveOptionTarget(q, v, nodes, { estimate: estimateTap });
        if (t) local.push(t);
      }

      if (!local.length) {
        unresolved.push({ q, reason: 'no-target', answer: letters.join('') });
        continue;
      }
      if (local.length < letters.length) {
        // 多选只解出一部分 —— 宁可整题放弃，也不能只点一半（只点一半必错）
        unresolved.push({ q, reason: 'partial', answer: letters.join(''), got: local.length });
        continue;
      }

      // 人类节奏：点与点之间留出手指移动的时间
      await dev.taps(local, { gapMs: rand(tapGap) });
      tapCount += local.length;
      applied.push(q);
      state.pending.set(q.key, { q, labels: local.map((t) => t.label) });

      // 每题之间停一下，模拟思考
      await wait(rand(think));
    }

    // applied 里的题不管有没有点，都记入已处理（填空题是粘贴成功的）
    for (const q of applied) state.done.set(q.key, { round: state.round });
    state.answered += applied.length;

    // 这一屏该点的都点完了 → 直接用**同一张快照**里的「下一题」坐标翻页。
    // 以前是下一轮循环再读一次屏幕，才发现「这屏没新题了」再去翻页，
    // 等于每题白白多读一次（2.3 秒）。
    let advanced = null;
    if (applied.length && !unresolved.length && autoAdvance) {
      advanced = await advance(nodes, { singlePage: fresh.length === 1 });
    }

    // 记失败次数：同一题多轮解不出就不再重试
    for (const a of unresolved) {
      const k = a.q.key;
      state.bad.set(k, (state.bad.get(k) || 0) + 1);
      state.skipped++;
    }

    return {
      action: 'answered',
      count: applied.length,
      taps: tapCount,
      advanced,
      unresolved: unresolved.map((u) => ({
        n: u.q.number,
        type: u.q.type,
        reason: u.reason,
        text: u.text || u.answer || '',
      })),
      strategy,
    };
  }

  function fmtText(v) {
    if (v == null) return '';
    return Array.isArray(v) ? v.join(' / ') : String(v);
  }

  /**
   * 这个界面到底暴不暴露「选中」状态。
   *
   * 真机实测（iQOO Neo9 / 学习通 WebView）：点完选项后整棵 UI 树
   * **字节级完全不变**，没有 checkable、没有 checked、没有 selected。
   * 也就是说程序永远无法从无障碍层确认自己点中了没有。
   * 不先探测就直接用，会出现「每轮都以为没点上」的假象，白攒一堆 pending。
   */
  function selectionObservable(nodes) {
    return nodes.some((n) => n.checkable || n.checked || n.selected);
  }

  /** 视觉上已经选过的题（比如自己手动点过）不再动 */
  function visuallyAnswered(q, nodes) {
    const range = questionRange(q);
    if (!range) return false;
    return nodes.some(
      (n) =>
        (n.checked || n.selected) &&
        n.bounds.h > 0 &&
        n.bounds.y1 >= range.y1 - 6 &&
        n.bounds.y2 <= range.y2 + 6
    );
  }

  /**
   * 上一轮点完的题，这轮看看有没有真的选中。
   *
   * 只观测，不重试。原因：如果选项是 checkbox，盲点第二次会把它取消选中，
   * 那比「没点上」更糟。所以这里只负责把「确认选中」的题移出待验证集合，
   * 剩下的靠最终统计提示用户自己核对。
   */
  function verifyPending(questions, nodes) {
    if (!state.pending.size) return;
    // 界面根本不暴露选中态 → 验证不了，直接清空，别让用户看到一堆虚假告警
    if (!selectionObservable(nodes)) { state.pending.clear(); return; }
    const byKey = new Map(questions.map((q) => [q.key, q]));
    for (const [key, p] of [...state.pending]) {
      const q = byKey.get(key);
      if (!q) continue; // 翻页了，验证不了，放过
      const range = questionRange(q);
      if (!range) continue;
      const marks = nodes.filter(
        (n) => (n.checked || n.selected) && n.bounds.y1 >= range.y1 - 6 && n.bounds.y2 <= range.y2 + 6
      );
      if (!marks.length) continue; // 该界面根本不暴露选中态，无法判断
      state.pending.delete(key);
    }
  }

  /** 推进到下一屏 */
  async function advance(nodes, opts = {}) {
    const t = (n) => nodeText(n).trim();
    // singlePage = 当前屏只有一道题（一题一页布局）。只有这种布局才敢
    // 用「空白区轻点」和「固定坐标点下一题」两级兜底 —— 多题同屏的
    // 滚动页里，那些位置可能站着还没答的选项，点了就是选错答案。
    const singlePage = opts.singlePage === true;

    // 「提交 / 交卷」是终点标志。除非显式允许，只报告，不点。
    let submitNode = nodes.find((n) => /^(提交|交卷|提交试卷|确认交卷)$/.test(t(n)));

    // 翻页按钮：优先「下一题」，其次「下一页 / 继续」
    let nextNode = nodes.find((n) => /^(下一题|下一页|继续|下一步|下一部分)$/.test(t(n)));

    // 节点树陈旧自愈（2026-10-24 实测）：一题一页的考试布局里，WebView 的
    // 无障碍树会整棵卡在旧页面 —— 「下一题」按钮肉眼可见，树里却没有，
    // 引擎于是只会盲上滑；这种布局滑动不翻页，滑两次就被误判「没有更多
    // 的题」提前收工（实测卡死在第 27 题、还剩 23 题时退出）。
    // 滑动救不回这种树（滑完树还是旧的），但一次普通 tap 会触发刷新。
    // 处理：先收键盘（防盲区被键盘占据），再在选项下方的空白区轻点一下
    // （一题一页布局里那里没有任何可点控件），重抓一次把 下一题 找回来。
    if (singlePage && !nextNode && !submitNode) {
      try {
        await hideKeyboard();
        const { w, h } = await dev.screenSize();
        await dev.tap(Math.round(w / 2), Math.round(h * 0.72));
        await wait(700);
        const rg = await grab();
        if (rg && rg.nodes && rg.nodes.length) {
          nodes = rg.nodes;
          submitNode = nodes.find((n) => /^(提交|交卷|提交试卷|确认交卷)$/.test(t(n)));
          nextNode = nodes.find((n) => /^(下一题|下一页|继续|下一步|下一部分)$/.test(t(n)));
        }
      } catch (_) {
        /* 自愈失败就按原路走，好过中断 */
      }
    }

    if (nextNode && autoAdvance) {
      const c = center(nextNode.bounds);
      if (c) {
        await dev.tap(c.x, c.y);
        await wait(rand(advanceWait));
        return 'next';
      }
    }

    if (submitNode && !allowSubmit) return 'submit';

    // 树还是旧的、下一题依然找不到 → 一题一页布局的最后兜底：
    // 「下一题」按钮位置固定（底部右侧），按坐标直点。
    // 前提依然是整棵树连 提交/交卷 的字样都没有 —— 万一真到了尾页，
    // 那个位置站着的是交卷按钮，绝不能盲点。就算极端情况下盲点命中
    // 交卷，后面弹的「确认交卷」对话框也会被 detectAlert 拦下停手。
    if (singlePage && !nextNode && !submitNode && autoAdvance) {
      try {
        const { w, h } = await dev.screenSize();
        await dev.tap(Math.round(w * 0.64), Math.round(h * 0.958));
        await wait(rand(advanceWait));
        return 'next-fixed';
      } catch (_) {
        /* 落空就落空，交给下一轮 */
      }
    }

    // 没有导航按钮 → 上滑一屏找下面的题
    if (scrollAdvance) {
      const { w, h } = await dev.screenSize();
      await dev.swipe(w / 2, h * 0.78, w / 2, h * 0.3, 320);
      await wait(rand([600, 1200]));
      return 'scroll';
    }
    return 'none';
  }

  /* ── 中文写入通道：ADBKeyboard（IME 注入） ────────────────
   *
   * 为什么不是剪贴板：
   *   Termux:API 的 GitHub 版 APK 在 v0.50.1 / v0.53.0 上实测都【缺
   *   TermuxApiReceiver 组件】—— dumpsys 里只剩 NfcActivity 与
   *   NotificationService，`am broadcast -n .../.TermuxApiReceiver`
   *   返回 result=0（无人接收），termux-clipboard-set 于是必然卡到超时。
   *   签名一致（db86cf3c）也没用，组件本身不在包里，这不是配置问题。
   *   再加上 Android 12+ 禁止后台应用读剪贴板，这条路两头都堵。
   *
   * 为什么不是 `input text`：
   *   它走 KeyCharacterMap，只认 ASCII，中文一个字节都进不去。
   *
   * 剩下的唯一通道是输入法：临时把默认输入法切成 ADBKeyboard，
   * 用广播把整段文本一次性塞进当前焦点框，填完立刻切回原输入法。
   * 不进任何界面、不动剪贴板、不需要后台权限，也不影响用户自己打字。
   */
  const IME_ADB = 'com.android.adbkeyboard/.AdbIME';
  // 原输入法 id 落盘一份：进程在切换中途被杀时，下次启动能靠它救回来。
  // 没有这个文件的话，用户会发现「手打时没有键盘」，而那时又不敢切出去修。
  const IME_STATE = join(homedir(), '.cx_ime_backup');
  let imeBackup = null; // 原输入法 id，首次切换前备份

  async function imeCurrent() {
    try {
      const out = await dev.raw('settings get secure default_input_method', {
        timeout: 8000,
      });
      return String(out).trim().split(/\r?\n/)[0].trim();
    } catch (_) {
      return '';
    }
  }

  async function imeSet(id) {
    if (!id) return false;
    try {
      await dev.raw(`ime set ${id}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 软键盘当前是否弹着（mInputShown） */
  async function keyboardShown() {
    try {
      const out = await dev.raw(
        "dumpsys input_method 2>/dev/null | grep -q 'mInputShown=true' && echo YES || echo NO",
        { timeout: 8000 }
      );
      return /YES/.test(String(out));
    } catch (_) {
      return false; // 查不到就当作没开，宁可少收也不误按返回
    }
  }

  /**
   * 收起软键盘。
   *
   * 为什么必须收：键盘是独立窗口，盖在「下一题」按钮上面。dump 里按钮
   * 坐标还在，但 tap 会落在键盘的按键上 —— ADBKeyboard 的按键区正好
   * 覆盖底部导航，一次误按就可能切走或清空输入框。
   *
   * 为什么用 BACK 还要带条件：键盘开着时 BACK 只关键盘、不退出应用；
   * 键盘没开时 BACK 会触发返回导航（考试页可能弹「确认退出」）。
   * 所以必须先确认 mInputShown=true 才按。
   */
  async function hideKeyboard() {
    if (!(await keyboardShown())) return;
    try {
      await dev.raw('input keyevent 4', { timeout: 8000 });
      await wait(500); // 等布局回流，旧快照坐标才重新有效
    } catch (_) {
      /* 收不掉就收不掉，下一轮 grab 会重新拿坐标 */
    }
  }

  /**
   * 填空题/简答题写入。
   *
   * 只认「落在本题题干下方、且下一题上方」的输入框 —— 一屏可能有好几道
   * 填空题，盲取第一个 EditText 会把答案填进别的题里。
   *
   * 空的数量必须和框的数量对得上：
   *   1 个框 + n 个空 → 用 # 拼（学习通单框多空的约定）
   *   n 个框 + n 个空 → 逐个填
   *   其它情况一律放弃，交给人工。填错比不填更糟。
   */
  /** 上一次填空为什么没填上——只用于日志定位，不影响行为 */
  let lastFillFail = '';

  /** 从一份节点树里挑出「属于本题」的输入框 */
  function pickBoxes(list, qy, limit) {
    return list
      .filter((n) => /EditText/.test(n.cls) && n.bounds.h > 20)
      .filter((n) => n.bounds.y1 >= qy - 60 && n.bounds.y1 < limit)
      .sort((a, b) => a.bounds.y1 - b.bounds.y1);
  }

  async function fillText(q, rawAnswer, nodes, siblings = []) {
    lastFillFail = '';
    const answers = (Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    if (!answers.length) {
      lastFillFail = 'empty-answer';
      return false;
    }

    const qy = q.bounds?.y1 ?? -Infinity;
    const next = siblings
      .filter((s) => s !== q && s.bounds && s.bounds.y1 > qy)
      .sort((a, b) => a.bounds.y1 - b.bounds.y1)[0];
    const limit = next ? next.bounds.y1 - 10 : Infinity;

    let mine = pickBoxes(nodes, qy, limit);

    // ① 找不到输入框：多半又是 WebView 树陈旧（实测第 49 题就这样被跳过）。
    //    先重抓两次（uiautomator 重试常能拿到新树），仍不行就在题干里轻点一下
    //    唤醒（点题干顶部而非空白处，避免误点到别题的选项）。
    if (!mine.length) {
      lastFillFail = 'no-input';
      for (let k = 0; k < 2 && !mine.length; k++) {
        await wait(320);
        try {
          const rg = await grab();
          if (rg && rg.nodes && rg.nodes.length) {
            mine = pickBoxes(rg.nodes, qy, limit);
          }
        } catch (_) {
          /* 重抓失败继续下一轮 */
        }
      }
      if (!mine.length && Number.isFinite(qy)) {
        try {
          const { w } = await dev.screenSize();
          await dev.tap(Math.round(w / 2), Math.round(qy + 18));
          await wait(420);
          const rg2 = await grab();
          if (rg2 && rg2.nodes && rg2.nodes.length) {
            mine = pickBoxes(rg2.nodes, qy, limit);
          }
        } catch (_) {
          /* 唤醒失败就走下面的兜底 */
        }
      }
      // ② 兜底：整屏只有一个输入框时，它必然是本题的（一题一页布局无歧义）。
      //    整屏有多个就不敢猜——填错题比留空更糟。
      if (!mine.length) {
        const all = nodes.filter((n) => /EditText/.test(n.cls) && n.bounds.h > 20);
        if (all.length === 1) mine = all;
      }
      if (mine.length) lastFillFail = '';
      else return false;
    }

    let texts;
    if (mine.length === 1) texts = [answers.join('#')];
    else if (mine.length === answers.length) texts = answers;
    else if (answers.length === 1) {
      // 多个空只给了一个答案：至少填第一个空，空着必然是 0 分
      texts = [answers[0]];
      mine = [mine[0]];
      lastFillFail = 'partial-boxes';
    } else {
      lastFillFail = 'count-mismatch';
      return false;
    }

    // 切输入法：一条题内多个框只切一次
    let switched = false;
    if (!imeBackup) {
      imeBackup = await imeCurrent();
      // 落盘备份：万一进程在下面这几行里挂掉，下次启动还能自动切回来
      if (imeBackup && !/adbkeyboard/i.test(imeBackup)) {
        try {
          writeFileSync(IME_STATE, imeBackup, 'utf8');
        } catch (_) {
          /* 写不了就算了，不影响主流程 */
        }
      }
    }
    if (!/adbkeyboard/i.test(await imeCurrent())) {
      switched = await imeSet(IME_ADB);
      if (!switched) {
        lastFillFail = 'ime-unavailable';
        return false;
      }
      await wait(400);
    }

    let filled = 0;
    let failed = false;
    try {
      for (let i = 0; i < mine.length; i++) {
        const box = mine[i];
        const c = center(box.bounds);
        if (!c) {
          failed = true;
          break;
        }
        // 每次点之前重算：键盘弹出会把页面顶上去，旧坐标就偏了
        let pt = c;
        if (i > 0) {
          try {
            const fresh = await grab();
            const again = fresh.nodes
              .filter((n) => /EditText/.test(n.cls) && n.bounds.h > 20)
              .filter((n) => n.bounds.y1 >= qy - 60 && n.bounds.y1 < limit)
              .sort((a, b) => a.bounds.y1 - b.bounds.y1)[i];
            const c2 = again && center(again.bounds);
            if (c2) pt = c2;
          } catch (_) {
            /* 读不到就沿用原坐标 */
          }
        }
        await dev.tap(pt.x, pt.y);
        await wait(340);
        // 顺序不能反：先 clear 再 input，否则是追加到已有内容后面
        await dev.raw('am broadcast -a ADB_CLEAR_TEXT', { timeout: 10000 });
        await dev.raw(
          `am broadcast -a ADB_INPUT_TEXT --es msg ${shq(texts[i])}`,
          { timeout: 10000 }
        );
        await wait(240);
        filled++;
      }
    } catch (_) {
      failed = true;
      lastFillFail = 'inject-error';
    } finally {
      // 无论成败都切回：留着 ADBKeyboard 用户想手打时就没键盘了
      if (switched) {
        await imeSet(imeBackup);
        try {
          unlinkSync(IME_STATE);
        } catch (_) {
          /* 文件可能不存在，忽略 */
        }
      }
      // 收键盘：键盘盖着底部「下一题」，不收的话 advance 会点在键盘上
      await hideKeyboard();
    }

    return !failed && filled === mine.length;
  }

  return { step, state };
}

export { wait, rand };
