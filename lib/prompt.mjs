/**
 * Prompt 构建层
 *
 * 目标：让模型输出「机器可直接消费」的 JSON，而不是「人能看懂的漂亮答案」。
 * 这两者的差距，就是自动答题 50% 失败率的来源。
 */

import { QTYPE } from './normalize.mjs';

const OUTPUT_RULES = `
输出格式规则（必须严格遵守，违反任意一条都会导致答案无法填入）：

- 单选题：answer 为单个大写字母字符串，如 "A"
- 多选题：answer 为大写字母数组，按字母升序，如 ["A","C","D"]
- 判断题：answer 为 "正确" 或 "错误" 两个汉字之一
- 填空题：answer 为字符串数组，按空位从左到右排列，如 ["80","443"]
- 选词填空：answer 为字母数组，按空位从左到右排列，如 ["B","A"]。绝不允许按字母排序
- 阅读理解/完形填空/共用选项：answer 为字母数组，按子题顺序排列，如 ["C","A","B"]
- 简答题/名词解释：answer 为纯文本字符串，分点用 \\n 分隔
- 其他题型：answer 为纯文本字符串`;

const HARD_RULES = `
硬性约束（违反会导致整个答案作废）：

1. 只输出一个 JSON 对象，不要输出 markdown 代码围栏（不要出现 \`\`\`），不要输出任何解释性文字
2. 必须为输入的每一道题都给出答案，数量不能少
3. 必须原样回传输入里的 id 字段，不要自己编号，不要改大小写
4. 选择题只给字母，绝对不要附带选项内容
5. 多选题必须给全部正确选项，漏选比错选扣分更狠
6. 填空题的答案数量必须等于该题的空数（blankCount）
7. 选词填空按空位顺序给，不要按字母排序
8. 如果某道题你完全无法判断，answer 给 null，不要编造
9. 所有答案用中文（选择题字母除外），除非题目明确要求英文`;

const FEW_SHOT = `示例输入：
[
  {"id":"q1","type":"单选题","content":"以下哪个是面向对象编程的特征？","options":["A. 封装","B. 递归","C. 排序","D. 遍历"]},
  {"id":"q2","type":"多选题","content":"以下哪些是 HTTP 请求方法？","options":["A. GET","B. POST","C. SELECT","D. DELETE"]},
  {"id":"q3","type":"判断题","content":"TCP 是无连接协议。"},
  {"id":"q4","type":"填空题","content":"HTTP 默认端口____，HTTPS 默认端口____","blankCount":2},
  {"id":"q5","type":"选词填空","content":"Many people are ____1____ of the risks. 词库: A. privacy B. unaware","blankCount":2},
  {"id":"q6","type":"简答题","content":"简述 TCP 三次握手"}
]

示例输出：
{"answers":[{"id":"q1","answer":"A"},{"id":"q2","answer":["A","B","D"]},{"id":"q3","answer":"错误"},{"id":"q4","answer":["80","443"]},{"id":"q5","answer":["B","A"]},{"id":"q6","answer":"1. 客户端发送 SYN\\n2. 服务端返回 SYN+ACK\\n3. 客户端发送 ACK"}]}`;

/**
 * 序列化题目给模型看
 *
 * 关键：只送模型需要的字段。
 * 送 id 之外的东西（如 globalOrder、rawTypeName）会干扰模型。
 */
export function serializeQuestions(questions) {
  const payload = questions.map((q) => {
    const o = {
      id: q.id,
      type: q.typeName ?? q.type,
      content: q.content,
    };
    if (q.options?.length) {
      o.options = q.options.map((opt) => `${opt.label}. ${opt.text}`);
    }
    if (q.blankCount > 0) o.blankCount = q.blankCount;
    if (q.subQuestions?.length) {
      o.subQuestions = q.subQuestions.map((s) => ({
        index: s.index,
        content: s.content,
        options: (s.options ?? []).map((opt) => `${opt.label}. ${opt.text}`),
      }));
    }
    return o;
  });
  // 紧凑输出，省 token
  return JSON.stringify(payload);
}

/** 组装 system prompt */
export function buildSystemPrompt() {
  return [
    '你是一个精准的考试答题引擎。你的输出会被程序直接解析并填入答题框，任何格式偏差都会导致答案丢失。',
    OUTPUT_RULES,
    HARD_RULES,
    FEW_SHOT,
  ].join('\n\n');
}

/**
 * 组装 user prompt
 * @param {object} opts
 * @param {boolean} opts.askConfidence 是否要求返回置信度（会显著增加 token，但也显著提升可用性）
 */
export function buildUserPrompt(questions, { askConfidence = true } = {}) {
  const body = serializeQuestions(questions);
  if (!askConfidence) {
    return `题目列表：\n${body}\n\n直接输出 {\"answers\":[...]}`;
  }
  return [
    `题目列表：\n${body}`,
    '',
    '输出格式（在每条答案里额外带 confidence 和 brief）：',
    '{"answers":[{"id":"q1","answer":"A","confidence":0.0-1.0,"brief":"10字以内理由"}]}',
    '',
    'confidence 是你对这道题的把握程度。不要为了显得自信而虚报 —— 这个数值会被用于决定是否自动提交。',
  ].join('\n');
}
