#!/usr/bin/env node
// 独立自检：只验证「配置 → 模型 → 答案」这条链路，不读屏幕、不点屏幕。
// 用法：node src/llmtest.mjs [--verbose]
// 用途：考前 30 秒确认 key 有效、模型能出答案、投票正常。
//       这一步失败，考场上一定出不了答案；这一步过了，剩下只是读屏和点击。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveQuestions, isUsableKey } from './llm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const verbose = process.argv.includes('--verbose');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
} catch (e) {
  console.error('✗ 读不到 config.json：' + e.message);
  process.exit(1);
}

// 用两道有确定答案的题做探针：答对说明链路真通，答错说明模型或提示词有问题
const probes = [
  {
    key: 'single',
    stem: '中国共产党的最高理想和最终目标是（　）。',
    type: 'single',
    options: [
      { label: 'A', text: '实现社会主义现代化' },
      { label: 'B', text: '实现共产主义' },
      { label: 'C', text: '实现中华民族伟大复兴' },
      { label: 'D', text: '全面建成小康社会' },
    ],
    expect: ['B'],
  },
  {
    key: 'multiple',
    stem: '下列属于四项基本原则内容的有（　）。',
    type: 'multiple',
    options: [
      { label: 'A', text: '坚持社会主义道路' },
      { label: 'B', text: '坚持人民民主专政' },
      { label: 'C', text: '坚持改革开放' },
      { label: 'D', text: '坚持中国共产党的领导' },
    ],
    expect: ['A', 'B', 'D'],
  },
  {
    key: 'judge',
    stem: '判断：中华人民共和国的根本制度是社会主义制度。',
    type: 'judge',
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' },
    ],
    // 判断题的答案可能是 "A"、"正确"、"√"、"true"，都算对；
    // 这里只比对语义，因为真实点击靠 auto.mjs 的 matchOption 做映射。
    expect: '正确',
  },
];

const asJudge = (v) => {
  const s = String(Array.isArray(v) ? v.join('') : (v ?? '')).trim();
  if (/^(正确|对|是|√|✓|t|true|y|yes|1|a)$/i.test(s)) return '正确';
  if (/^(错误|错|否|×|✗|f|false|n|no|0|b)$/i.test(s)) return '错误';
  if (/(不正确|错误|不对)/.test(s)) return '错误';
  if (/正确/.test(s)) return '正确';
  return null;
};

const usable = (cfg.providers || []).filter((p) => p.enabled !== false && isUsableKey(p.apiKey));
console.log('可用 provider：' + (usable.length ? usable.map((p) => p.name).join(' / ') : '无'));
if (!usable.length) {
  console.error('✗ 没有任何可用 key，先把 config.json 里的 apiKey 填上');
  process.exit(1);
}

const t0 = Date.now();
let out;
try {
  out = await solveQuestions(probes, cfg, null);
} catch (e) {
  console.error('✗ 调用失败：' + e.message);
  process.exit(1);
}
const ms = Date.now() - t0;

let pass = 0;
for (const r of out) {
  const p = probes.find((x) => x.key === r.id);
  let ok;
  if (typeof p.expect === 'string') {
    ok = asJudge(r.answer) === p.expect;
  } else {
    // 答案可能是 'B'、['B']、'A,B,D' 等形态，统一成大写字母数组比较
    const got = (Array.isArray(r.answer) ? r.answer.join('') : String(r.answer ?? ''))
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .split('')
      .filter(Boolean)
      .sort();
    ok = got.join('') === [...p.expect].sort().join('');
  }
  if (ok) pass++;
  console.log(
    `${ok ? '✓' : '✗'} ${p.key.padEnd(9)} 答案=${JSON.stringify(r.answer)}` +
      (ok ? '' : `  期望=${JSON.stringify(p.expect)}`) +
      `  置信度=${r.confidence ?? 0}${r.reason ? '  (' + r.reason + ')' : ''}` +
      (r.error ? '  错误=' + r.error : '')
  );
  if (verbose) console.log('   ' + JSON.stringify(r));
}

console.log(`\n${pass}/${probes.length} 正确 · 耗时 ${(ms / 1000).toFixed(1)}s`);
if (pass === probes.length) {
  console.log('✓ 链路通：read → solve 里的 solve 这一段正常，可以进考场');
  process.exit(0);
}
if (pass === 0) {
  console.log('✗ 一个都没答对：key 无效 / 余额不足 / 模型名写错，别带着这个状态进考场');
} else {
  console.log('⚠ 部分答错：能用，但准确率不保险，建议把 DeepSeek 放到唯一 provider');
}
process.exit(2);
