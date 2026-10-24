/**
 * uia.mjs — Android UI 树 → 题目结构
 *
 * 和网页端最大的不同：这里没有 DOM。uiautomator 给的是一棵节点树，
 * 每个节点只有 text / bounds / class / clickable。题目结构必须靠
 * 「坐标排序 + 文本模式」重建。
 *
 * 两种真实情况都要处理：
 *   A. 节点级：每个选项是独立节点（原生渲染）  → 按 bounds 排序后逐节点识别
 *   B. 文本级：整个 H5 内容塞在一个大节点里      → 按换行 + 题号正则切分
 */

/* ══════════════ XML 解析（不用第三方库，uiautomator 的 XML 很规整） ══════════════ */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#10;': '\n', '&#13;': '\r', '&#9;': '\t',
};

function unescape(s) {
  if (!s) return '';
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
}

function parseBounds(s) {
  const m = String(s || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 };
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

/**
 * 把 XML 拍平成节点数组（保留父子关系）
 * 一个正则同时匹配开标签、自闭合标签、闭标签，用栈维护层级。
 */
export function parseNodes(xml) {
  const nodes = [];
  const stack = [];
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m;

  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') {
      stack.pop();
      continue;
    }

    const attrs = m[1];
    const selfClose = m[2] === '/';

    const get = (name) => {
      const am = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
      return am ? unescape(am[1]) : '';
    };
    const flag = (name) => get(name) === 'true';

    const node = {
      text: get('text'),
      desc: get('content-desc'),
      cls: get('class'),
      rid: get('resource-id'),
      clickable: flag('clickable'),
      checkable: flag('checkable'),
      checked: flag('checked'),
      selected: flag('selected'),
      enabled: get('enabled') !== 'false',
      bounds: parseBounds(get('bounds')),
      index: Number(get('index') || 0),
      depth: stack.length,
      children: [],
    };

    if (stack.length) stack[stack.length - 1].children.push(node);
    nodes.push(node);

    if (!selfClose) stack.push(node);
  }

  return nodes;
}

/** 节点的可读文本（text 优先，其次 content-desc） */
function nodeText(n) {
  return (n.text || n.desc || '').trim();
}

/* ══════════════ 题型识别 ══════════════ */

const QTYPE = {
  SINGLE: 'single', MULTIPLE: 'multiple', JUDGE: 'judge',
  FILL: 'fill', WORD_FILL: 'wordfill', QA: 'qa', COMPOSITE: 'composite',
};

const TYPE_PATTERNS = [
  [/单选|单项选择|single\s*choice/i, QTYPE.SINGLE],
  [/多选|多项选择|不定项/i, QTYPE.MULTIPLE],
  [/判断/i, QTYPE.JUDGE],
  [/选词填空/i, QTYPE.WORD_FILL],
  [/填空/i, QTYPE.FILL],
  [/简答|问答|论述|名词解释|计算题|分析题|案例分析/i, QTYPE.QA],
  [/阅读|完形|共用选项|材料题/i, QTYPE.COMPOSITE],
];

function detectType(text, optionCount) {
  for (const [re, t] of TYPE_PATTERNS) {
    if (re.test(text)) return t;
  }
  if (optionCount >= 2) return optionCount === 2 ? QTYPE.JUDGE : QTYPE.SINGLE;
  return QTYPE.QA;
}

/**
 * 压掉汉字之间的空格。
 * 学习通选项用 text-align: justify，短选项会被拉成「从 严」「治 理」。
 * 不压掉的话，拿去和题库比对、或按选项原文匹配，全都对不上。
 * 只删「两个汉字之间」的空格，英文单词之间的空格必须留着。
 */
export function squeezeCJK(s) {
  let out = String(s ?? '');
  let prev;
  do {
    prev = out;
    out = out.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1');
  } while (out !== prev);
  return out;
}

/** 题干清洗：去题号、去题型标记、去分值 */
const NOISE = [
  /^\s*\d+\s*[.、．)）]\s*/,
  /^\s*[（(【\[]\s*(单选题?|多选题?|判断题?|填空题?|简答题?|问答题?|论述题?|名词解释|不定项选择题?|选词填空|阅读理解|完形填空|计算题|分析题|材料题)\s*[)）】\]]\s*/i,
  // 分值节点。必须同时吃全角「（）」和半角「()」——
  // 真机上「（2.0分）」用的是全角括号，只判半角会把整串留在题干开头。
  /^\s*[（(【\[]\s*\d+(?:\.\d+)?\s*分\s*[)）】\]]\s*/,
  /^\s*[（(]\s*共\s*\d+\s*题[^)）]*[)）]\s*/,
  /^\s*(标记|收藏)\s+/,
];

/**
 * 题干尾部噪声。
 * 真机上「（2.0分）」是独立的节点，会跟在题干后面被拼进去；
 * 全角括号「（）」和小写「分」都要覆盖，否则题干会带个尾巴，
 * 拿去和题库比对就永远命不中。
 */
const TRAILING = [
  /\s*[（(【\[]\s*\d+(?:\.\d+)?\s*分\s*[)）】\]]\s*$/,
  /\s*[（(]\s*共\s*\d+\s*题[^)）]*[)）]\s*$/,
  /\s*下一题\s*$/,
  /\s*标记\s*$/,
];

export function cleanStem(raw) {
  let s = squeezeCJK(String(raw || '').replace(/\u00a0/g, ' ')).replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of NOISE) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; changed = true; }
    }
    for (const re of TRAILING) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; changed = true; }
    }
  }
  return s.trim();
}

/* ══════════════ 策略 A：节点级重建 ══════════════ */

/** 把节点按阅读顺序排（先 y 后 x，容忍同一行的微小 y 差） */
function readingOrder(nodes) {
  return [...nodes].sort((a, b) => {
    const dy = a.bounds.y1 - b.bounds.y1;
    if (Math.abs(dy) > 12) return dy;
    return a.bounds.x1 - b.bounds.x1;
  });
}

const OPTION_RE = /^\s*([A-Za-z])\s*[.、．)）:：]\s*([\s\S]*)$/;
const QNUM_RE = /^\s*(\d{1,3})\s*[.、．)）]\s*([\s\S]*)$/;
/**
 * 光秃秃的选项标签：整段文本就是一个字母。
 *
 * 学习通新版 WebView（真机实测）就是这种结构 ——
 *   TextView "A"          ← 标签单独一个节点，后面【不带任何标点】
 *   TextView "中国共产党"   ← 选项正文是它右边的兄弟节点
 * 没有这条规则，4 个选项一个都认不出来，整题会退化成「简答题」。
 */
const BARE_LABEL_RE = /^\s*([A-Ha-h])\s*$/;

/**
 * 判断一段文本是不是「新题目的开头」
 * 难点：题干里的「3.14」「1.5倍」会被误判成题号。
 * 判据：点号后面紧跟数字 → 是小数的概率极高，不算题号。
 */
function asQuestionStart(text) {
  const m = text.match(QNUM_RE);
  if (!m) return null;
  const after = m[2];
  if (/^\d/.test(after)) return null;   // "3.14" → 小数，不是题号
  return { num: Number(m[1]), rest: after.trim() };
}

/**
 * 策略 A：文本节点足够多时，逐节点重建
 * 适用：原生渲染的答题界面（选项各自是 TextView）
 */
export function extractByNodes(xml, { screenH = 2400 } = {}) {
  const nodes = parseNodes(xml);
  const textNodes = nodes.filter((n) => {
    const t = nodeText(n);
    return t.length > 0 && n.bounds.h > 0;
  });

  // 4 个文本节点就可能是完整一题（题号 + 题型 + 题干 + 2 选项）。
  // 阈值定太高三题以内的页面（尤其判断题）会被直接判成「不是节点式渲染」。
  if (textNodes.length < 4) return null;

  const ordered = readingOrder(textNodes);
  const questions = [];
  let cur = null;
  /** 章节标题声明的题型（「单选题 （共30题，60.0分）」），作为题型的第一依据 */
  let sectionType = null;

  /**
   * 收题。
   * 注意：stem 是惰性拼接的（解析过程中只累积 stemParts），
   * 所以这里必须先算出来再判断，不能直接读 cur.stem —— 那样永远是空串，
   * 结果是一道题都推不进去。
   */
  const pushQuestion = () => {
    if (cur) {
      // 题型判断必须用「未清洗」的原文 —— cleanStem 会把「（多选题）」这种标记剥掉，
      // 剥完之后就再也分不出单选和多选了（两者选项数一样）。
      const rawStem = (cur.stemParts || []).join(' ');
      const stem = cleanStem(rawStem);
      if (stem) {
        cur.stem = stem;
        // 章节标题优先，其次看题干原文，最后才按选项数猜
        cur.type =
          cur.options.length >= 2 && sectionType
            ? sectionType
            : cur.type ?? detectType(rawStem, cur.options.length);
        // 两个选项且是「正确/错误」→ 判断题
        if (cur.type === QTYPE.SINGLE && cur.options.length === 2 &&
            cur.options.every((o) => /^(正确|错误|对|错|是|否|true|false)$/i.test(o.text))) {
          cur.type = QTYPE.JUDGE;
        }
        questions.push(cur);
      }
    }
    cur = null;
  };

  const openQuestion = (num, firstPiece, bounds) => {
    pushQuestion();
    cur = {
      index: num,
      number: num,
      stemParts: firstPiece ? [firstPiece] : [],
      stem: '',
      options: [],
      type: null,
      bounds,
    };
  };

  /** 选项入列。bounds 用「标签 + 正文」合并后的行，落点才稳 */
  const addOption = (label, text, a, b) => {
    if (!cur) return;
    const bounds = b
      ? {
          x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
          x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
          w: Math.max(a.x2, b.x2) - Math.min(a.x1, b.x1),
          h: Math.max(a.y2, b.y2) - Math.min(a.y1, b.y1),
        }
      : a;
    cur.options.push({
      label: label.toUpperCase(),
      text: squeezeCJK(String(text).trim()),
      bounds,
      cx: (bounds.x1 + bounds.x2) / 2,
      cy: (bounds.y1 + bounds.y2) / 2,
    });
  };

  const skip = new Set();

  for (let i = 0; i < ordered.length; i++) {
    if (skip.has(i)) continue;
    const n = ordered[i];
    const t = nodeText(n);

    // ① 章节标题：还没进题时，用来锁定整段的题型
    if (!cur) {
      const hdr = TYPE_PATTERNS.find(([re]) => re.test(t));
      if (hdr) { sectionType = hdr[1]; continue; }
    }

    const qs = asQuestionStart(t);

    if (qs) {
      // 什么时候算新题：当前没题 / 当前题已有选项 / 题号正好接续
      const isNew =
        !cur ||
        cur.options.length > 0 ||
        qs.num === (cur.number ?? -99) + 1 ||
        qs.num === 1;
      if (isNew) {
        openQuestion(qs.num, qs.rest, n.bounds);
        continue;
      }
    }

    if (!cur) continue;

    // ② 完整的「A、xxx」写在同一节点里
    const om = t.match(OPTION_RE);
    if (om) {
      addOption(om[1], om[2], n.bounds, null);
      continue;
    }

    // ③ 标签单独一个字母，正文在右边的兄弟节点（学习通新版就是这个）
    const bare = t.match(BARE_LABEL_RE);
    if (bare) {
      const nx = ordered[i + 1];
      if (nx && !skip.has(i + 1)) {
        const nt = nodeText(nx);
        const sameRow = Math.abs(nx.bounds.y1 - n.bounds.y1) < Math.max(n.bounds.h, 40) * 0.9;
        const toRight = nx.bounds.x1 >= n.bounds.x2 - 4;
        const usable =
          nt && nt.length >= 1 && nt.length <= 200 &&
          !BARE_LABEL_RE.test(nt) && !OPTION_RE.test(nt) && !asQuestionStart(nt);
        if (sameRow && toRight && usable) {
          skip.add(i + 1);
          addOption(bare[1], nt, n.bounds, nx.bounds);
          continue;
        }
      }
      continue; // 光秃秃一个字母，配不到正文就丢掉，别污染题干
    }

    if (!cur.options.length) {
      // 选项之前 → 题干组成部分（题型标记、分值、正文）
      cur.stemParts.push(t);
    } else if (t.length > 12 && /[。？?]/.test(t)) {
      // 选项之后又出现长句 → 大概率是下一题，只是题号节点没抓到
      openQuestion((cur.number ?? questions.length) + 1, t, n.bounds);
    }
  }
  pushQuestion();

  // 收尾：兜底（pushQuestion 已处理过的跳过）
  for (const q of questions) {
    if (!q.stem) q.stem = cleanStem((q.stemParts || []).join(' '));
    delete q.stemParts;
    q.type = q.type ?? detectType(q.stem, q.options.length);
  }

  return questions.filter((q) => q.stem.length >= 2);
}

/* ══════════════ 策略 B：整块文本切分 ══════════════ */

/**
 * 策略 B：内容全部在一个大节点里时，按换行 + 正则切分
 * 适用：H5 / WebView 渲染的答题界面
 */
export function extractByTextFlow(xml) {
  const nodes = parseNodes(xml);
  const texts = nodes
    .filter((n) => nodeText(n).length > 0 && n.bounds.h > 0)
    .sort((a, b) => a.bounds.y1 - b.bounds.y1)
    .map((n) => nodeText(n));

  // 找最长的那个（通常是 WebView 的整体文本）
  const blob = texts.join('\n');
  if (!blob || blob.length < 20) return [];

  // 按题号切块：行首的 数字. 或 数字、
  const parts = blob.split(/(?:^|\n)\s*(?=\d+\s*[.、．])/);
  const questions = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const qm = trimmed.match(/^(\d+)\s*[.、．]\s*([\s\S]*)$/);
    if (!qm) continue;

    const num = Number(qm[1]);
    let body = qm[2];

    // 选项切分
    const lines = body.split(/\n+/);
    const stemLines = [];
    const options = [];
    let inOptions = false;

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const om = t.match(/^([A-Za-z])\s*[.、．)）:：]\s*([\s\S]*)$/);
      if (om) {
        inOptions = true;
        options.push({ label: om[1].toUpperCase(), text: squeezeCJK(om[2].trim()) });
      } else if (!inOptions) {
        stemLines.push(t);
      } else if (options.length) {
        // 选项的续行
        options[options.length - 1].text += ' ' + t;
      }
    }

    const stem = cleanStem(stemLines.join(' '));
    if (!stem || stem.length < 2) continue;

    questions.push({
      index: num,
      number: num,
      stem,
      options,
      type: detectType(stem, options.length),
    });
  }

  return questions;
}

/* ══════════════ 统一入口 ══════════════ */

/**
 * 从 UI XML 抽题：两种策略都跑，取题目数更多且质量更高的
 */
export function extractQuestions(xml, opts = {}) {
  const a = extractByNodes(xml, opts) || [];
  const b = extractByTextFlow(xml);

  const score = (qs) => {
    if (!qs.length) return -1;
    const withOpts = qs.filter((q) => q.options.length >= 2).length;
    const avgStem = qs.reduce((s, q) => s + q.stem.length, 0) / qs.length;
    return withOpts * 10 + qs.length * 3 + Math.min(avgStem, 80) / 10;
  };

  // 诊断信息要能直接看出「是没读到节点」还是「读到节点但没切出题」
  // —— 这两种情况的修法完全不同，混在一起会误判。
  const all = parseNodes(xml);
  const withText = all.filter((n) => nodeText(n).length > 0 && n.bounds.h > 0);

  const best = score(a) >= score(b) ? a : b;
  return {
    questions: best,
    strategy: score(a) >= score(b) ? 'node' : 'text',
    debug: {
      nodes: all.length,        // UI 树里的节点总数
      textNodes: withText.length, // 其中带文字的
      byNode: a.length,         // 节点策略抽到的题数
      byText: b.length,         // 文本流策略抽到的题数
    },
  };
}

/** 判断当前界面是不是答题页 */
export function looksLikeQuiz(xml) {
  const nodes = parseNodes(xml);
  const blob = nodes.map(nodeText).join(' ');
  if (!blob) return false;
  const hasOption = /(^|\s)[A-D]\s*[.、．]/.test(blob) || /\b[A-D]\s*[.、．]\s*\S/.test(blob);
  const hasType = /单选题|多选题|判断题|填空题|简答题|不定项/.test(blob);
  const hasNum = /(^|\n)\s*1\s*[.、．]/.test(blob) || /\b1\s*[.、．]\s*\S/.test(blob);
  return (hasType && hasNum) || (hasOption && hasNum);
}

export { QTYPE, nodeText, readingOrder, parseBounds };
