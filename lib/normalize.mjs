/**
 * 答案与题干的归一化层
 *
 * 这是整个方案最容易被忽略、但决定成败的一层。
 * 所有现有项目的失分点，一大半都不是"AI 答错了"，而是"答案格式没对上"。
 *
 * 设计原则：只做单向收敛，不做猜测性改写。
 * 宁可标记 uncertain，也不要把 "AB" 猜成 "A" 或 "B"。
 */

/* ────────────── 题型枚举 ────────────── */

export const QTYPE = {
  SINGLE: 'single',      // 单选
  MULTIPLE: 'multiple',  // 多选
  JUDGE: 'judge',        // 判断
  FILL: 'fill',          // 填空
  WORD_FILL: 'wordfill', // 选词填空（位置敏感）
  QA: 'qa',              // 简答 / 名词解释
  COMPOSITE: 'composite',// 阅读理解 / 完形填空 / 共用选项
};

/** 超星表单里的 answertype 编码（不同接口不一样，这里只做记录） */
export const ANS_TYPE_CODE = {
  single: '0',
  multiple: '1',
  fill: '2',
  judge: '3',
  qa: '4',
};

/**
 * 中文题型名 → 标准枚举
 * 按可靠性：直接用 typename 属性 > 隐藏 input > 题干括号里的文字
 */
const TYPE_ALIASES = [
  [/(^|[\s（(])(单选题|单项选择)/, QTYPE.SINGLE],
  [/(^|[\s（(])(多选题|多项选择|不定项)/, QTYPE.MULTIPLE],
  [/(^|[\s（(])(判断题|是非题)/, QTYPE.JUDGE],
  [/(^|[\s（(])(选词填空)/, QTYPE.WORD_FILL],
  [/(^|[\s（(])(填空题|填空)/, QTYPE.FILL],
  [/(^|[\s（(])(阅读理解|阅读分析)/, QTYPE.COMPOSITE],
  [/(^|[\s（(])(完形填空)/, QTYPE.COMPOSITE],
  [/(^|[\s（(])(共用选项|共用备选)/, QTYPE.COMPOSITE],
  [/(^|[\s（(])(简答题|简答|问答题|论述题)/, QTYPE.QA],
  [/(^|[\s（(])(名词解释)/, QTYPE.QA],
];

export function normalizeType(rawType, { hasMultipleOptions = false } = {}) {
  if (!rawType) {
    return hasMultipleOptions ? QTYPE.MULTIPLE : QTYPE.QA;
  }
  const t = String(rawType);
  for (const [re, type] of TYPE_ALIASES) {
    if (re.test(t)) return type;
  }
  // "其他" / 未知：有选项按多选处理（宁可多选也不能漏选），无选项按简答
  return hasMultipleOptions ? QTYPE.MULTIPLE : QTYPE.QA;
}

/* ────────────── 题干归一化（题库匹配用） ────────────── */

/**
 * 题干归一化 —— 用于本地题库匹配的 key
 *
 * 去掉的都是"老师会改、但语义不变"的东西：
 *   分值标注（2分）、题型标注（单选题）、下划线空位、题号、首尾空白
 * 保留的：所有实义字、标点差异（不删标点，因为删了会撞题）
 */
export function normalizeStem(text) {
  if (!text) return '';
  return String(text)
    // 全角括号里的分值/题型标注
    .replace(/[（(][^）)]{0,20}?(分|单选|多选|判断|填空|简答|阅读|完形)[^）)]{0,20}?[）)]/g, '')
    // 独立括号里的纯数字+分
    .replace(/[（(]\s*\d+(\.\d+)?\s*分\s*[）)]/g, '')
    // 竖排标注 【单选题】
    .replace(/【[^】]{0,20}】/g, '')
    .replace(/\[[^\]]{0,20}\]/g, '')
    // 空位统一成年内下划线
    .replace(/[_＿]{2,}/g, '')
    .replace(/[（(]\s*[）)]/g, '')
    // 题号 "1." "1、" "1．"
    .replace(/^\s*\d+\s*[.、．)）]\s*/, '')
    // 空白收敛
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 保序版本 —— 选词填空、阅读理解、完形填空必须用它
 *
 * 为什么不能复用 toLetters：
 *   toLetters 会排序去重，而 ["B","A"] 和 ["A","B"] 在位置敏感题型里
 *   是两个完全不同的答案。排序一下，整题就废了。
 */
export function toLettersOrdered(value) {
  const collectOne = (s) => {
    let str = String(s ?? '').trim();
    if (!str) return [];
    str = str.replace(/(答案是|答案为|正确答案是|应选|应该选|故选|选择|选|是|为)/g, ' ');

    const letters = str.match(LETTERS_RE);
    if (!letters) return [];
    const residue = str.replace(LETTERS_RE, '').replace(/[\s,，、;；.．。)）(（\-—_]/g, '');

    // 纯净 → 按出现顺序返回，不排序
    if (residue.length === 0) return letters.map((c) => c.toUpperCase());

    // 混杂中文 → 只取开头字母
    const head = str.match(/^\s*([A-Ha-h])/);
    return head ? [head[1].toUpperCase()] : [];
  };

  if (Array.isArray(value)) {
    return value.flatMap((v) => collectOne(v));
  }
  return collectOne(value);
}

/* ────────────── 答案归一化（这是核心） ────────────── */

const LETTERS_RE = /[A-Ha-h]/g;

/**
 * 选择题答案 → 大写字母数组
 *
 * 处理这些真实脏数据：
 *   "A." / "A、" / "选A" / "答案是 A" / "A．" / "A)"
 *   "ACD" / "A,C,D" / "A、C、D" / "A C D"
 *   ["C","A"]（顺序错）
 *   卡片式 "A. 封装"
 */
export function toLetters(value) {
  const collect = (s) => {
    let str = String(s ?? '').trim();
    if (!str) return null;

    // 第一步：剥掉中文填充词。"选A" / "答案是 A" / "应选：AC" 都是真实输出
    str = str.replace(/(答案是|答案为|正确答案是|应选|应该选|故选|选择|选|是|为)/g, ' ');

    // 第二步：看剩下的是不是「纯字母 + 分隔符」
    const letters = str.match(LETTERS_RE);
    if (!letters) return null;
    const residue = str
      .replace(LETTERS_RE, '')
      .replace(/[\s,，、;；.．。)）(（\-—_]/g, '');

    // 纯净 → 这就是答案本身（"A、C、D" / "ACD" / "A,C,D"）
    if (residue.length === 0) {
      return letters.map((c) => c.toUpperCase());
    }

    // 混杂中文 → 大概率是 "A. 封装" 这种选项文本，只取开头那个字母
    // 不能用"取全部字母"，否则选项里的字母会污染答案
    const head = str.match(/^\s*([A-Ha-h])/);
    if (head) return [head[1].toUpperCase()];
    return null;
  };

  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      const r = collect(v);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
    }
    return dedupeSorted(out);
  }

  const r = collect(value);
  if (!r) return [];
  return dedupeSorted(Array.isArray(r) ? r : [r]);
}

function dedupeSorted(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}

const TRUE_TOKENS = ['正确', '对', '是', '√', '✓', 'T', 'TRUE', 'Y', 'YES', '1'];
const FALSE_TOKENS = ['错误', '错', '否', '×', '✗', 'X', 'F', 'FALSE', 'N', 'NO', '0'];

/**
 * 判断题答案 → 语义值 '正确' | '错误'
 *
 * 注意：语义值不直接用于提交。
 * 超星表单要的是 "true"/"false"，转换放在 toSubmitValue()。
 * 分开是为了让投票层能统一比较。
 */
export function toJudge(value) {
  if (typeof value === 'boolean') return value ? '正确' : '错误';
  const s = String(value ?? '').trim().toUpperCase().replace(/[。.!！\s]/g, '');
  if (!s) return null;
  if (FALSE_TOKENS.includes(s)) return '错误';
  if (TRUE_TOKENS.includes(s)) return '正确';
  // 兜底：包含否定词
  if (/(错误|不对|不正确|×|✗)/.test(s)) return '错误';
  if (/(正确|对的|√|✓)/.test(s)) return '正确';
  return null;
}

/**
 * 填空题答案 → 按空位顺序的字符串数组
 *
 * 关键：绝不排序。选词填空 ["B","A"] 和 ["A","B"] 是不同答案。
 * blankCount 给了就对齐长度：短了补空串，长了截断 —— 但会标记 mismatch。
 */
export function toBlankArray(value, blankCount = 0) {
  let arr;
  if (Array.isArray(value)) {
    arr = value.map((v) => String(v ?? '').trim());
  } else {
    const s = String(value ?? '').trim();
    // "1. xxx\n2. yyy" / "xxx|yyy" / "xxx；yyy"
    arr = s
      .split(/\n|\||；|;|;/)
      .map((x) => x.replace(/^\s*\d+\s*[.、．)）]\s*/, '').trim())
      .filter((x) => x.length > 0);
  }
  let mismatch = false;
  if (blankCount > 0) {
    if (arr.length > blankCount) {
      arr = arr.slice(0, blankCount);
      mismatch = true;
    } else if (arr.length < blankCount) {
      mismatch = true;
      while (arr.length < blankCount) arr.push('');
    }
  }
  return { values: arr, mismatch };
}

/**
 * 语义答案 → 目标平台的提交值
 *
 * 不同接口要求不同，这是唯一需要按平台改的地方：
 *   - addStudentWorkNewWeb（作业/章节测验）：判断传 "true"/"false"
 *   - 多选传 "ABC"（无分隔符，字母序）
 *   - 填空传数组，部分接口要求 answers{id}1 / answer{id}2 逐空字段
 */
export function toSubmitValue(type, answer) {
  switch (type) {
    case QTYPE.SINGLE:
      return Array.isArray(answer) ? (answer[0] ?? '') : String(answer ?? '');
    case QTYPE.MULTIPLE:
      return Array.isArray(answer) ? answer.join('') : String(answer ?? '');
    case QTYPE.JUDGE:
      return answer === '正确' ? 'true' : 'false';
    case QTYPE.FILL:
    case QTYPE.WORD_FILL:
      return Array.isArray(answer) ? answer : [String(answer ?? '')];
    case QTYPE.COMPOSITE:
      return Array.isArray(answer) ? answer : [String(answer ?? '')];
    default:
      return String(Array.isArray(answer) ? answer.join('\n') : (answer ?? ''));
  }
}

/**
 * 统一归一化入口：把任意 LLM 输出收敛成标准语义答案
 * 返回 { answer, ok, notes[] }
 */
export function normalizeAnswer(question, raw) {
  const notes = [];
  const { type, blankCount = 0 } = question;

  switch (type) {
    case QTYPE.SINGLE: {
      const letters = toLetters(raw);
      if (letters.length === 0) return { answer: '', ok: false, notes: ['no_letter'] };
      if (letters.length > 1) notes.push('single_but_multi_letter');
      return { answer: letters[0], ok: true, notes };
    }
    case QTYPE.MULTIPLE: {
      const letters = toLetters(raw);
      if (letters.length === 0) return { answer: '', ok: false, notes: ['no_letter'] };
      return { answer: letters, ok: true, notes };
    }
    case QTYPE.JUDGE: {
      const j = toJudge(raw);
      if (!j) return { answer: '', ok: false, notes: ['no_judge_token'] };
      return { answer: j, ok: true, notes };
    }
    case QTYPE.FILL: {
      const { values, mismatch } = toBlankArray(raw, blankCount);
      if (mismatch) notes.push('blank_count_mismatch');
      if (values.every((v) => !v)) return { answer: values, ok: false, notes };
      return { answer: values, ok: true, notes };
    }
    case QTYPE.WORD_FILL: {
      // 选词填空：答案必须是词库字母，且严格保序（不能排序！）
      const arr = toLettersOrdered(raw);
      if (arr.length === 0) return { answer: [], ok: false, notes: ['no_letter'] };
      if (blankCount > 0 && arr.length !== blankCount) {
        notes.push('wordfill_count_mismatch');
      }
      return { answer: arr, ok: arr.length > 0, notes };
    }
    case QTYPE.COMPOSITE: {
      // 阅读理解 / 完形填空 / 共用选项：按子题顺序，不能排序
      const ordered = toLettersOrdered(raw);
      if (ordered.length === 0) return { answer: [], ok: false, notes: ['no_letter'] };
      return { answer: ordered, ok: true, notes };
    }
    default: {
      const s = String(Array.isArray(raw) ? raw.join('\n') : (raw ?? '')).trim();
      if (!s) return { answer: '', ok: false, notes: ['empty'] };
      return { answer: s, ok: true, notes };
    }
  }
}

/** 用于投票分桶的稳定 key（保序） */
export function answerKey(answer) {
  if (Array.isArray(answer)) return answer.join('\u0000');
  return String(answer ?? '');
}
