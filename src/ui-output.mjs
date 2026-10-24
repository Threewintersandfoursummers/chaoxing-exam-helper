/**
 * ui-output.mjs — 答案显示层
 *
 * 两种输出同时开：
 *   1. 终端 —— 就地打印，程序跑着就能看到
 *   2. 本地网页 —— 大字、深色、适合放在旁边屏幕上照着点
 *
 * 网页版是主输出。手机在做题，PC 屏幕（或第二台设备）显示答案，
 * 这是唯一不会被 APP 检测到的方式 —— 因为它压根不在这台手机的进程里。
 */
import http from 'node:http';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', gray: '\x1b[90m', magenta: '\x1b[35m',
};

const TYPE_LABEL = {
  single: '单选', multiple: '多选', judge: '判断', fill: '填空',
  wordfill: '选词', qa: '简答', composite: '复合',
};

/* ══════════════ 终端 ══════════════ */

export function printAnswers(questions, results, { compact = false } = {}) {
  const lines = [];
  lines.push('');
  lines.push(`${C.gray}${'─'.repeat(66)}${C.reset}`);

  questions.forEach((q, i) => {
    const r = results[i] || {};
    const conf = r.confidence ?? 0;
    const ansColor = r.answer == null ? C.red : conf >= 0.85 ? C.green : conf >= 0.7 ? C.yellow : C.red;

    let ansText;
    if (r.answer == null) ansText = '未解出';
    else if (Array.isArray(r.answer)) ansText = r.answer.join('');
    else ansText = String(r.answer);

    const src = r.reason === 'bank' ? '题库' : r.reason === 'unanimous' ? '全票' :
                r.reason === 'qa_pick' ? '主观' : r.reason === 'majority' ? '多数' : '';

    lines.push(
      `${C.bold}${String(q.number ?? i + 1).padStart(2)}.${C.reset} ` +
      `${C.gray}[${TYPE_LABEL[q.type] || q.type}]${C.reset} ` +
      `${ansColor}${C.bold}${ansText}${C.reset}` +
      `${C.dim}  ${conf.toFixed(2)}${src ? ' ' + src : ''}${C.reset}`
    );

    if (!compact) {
      const stem = q.stem.length > 62 ? q.stem.slice(0, 61) + '…' : q.stem;
      lines.push(`    ${C.dim}${stem}${C.reset}`);

      // 把答案对应到选项原文，避免"选 B"但不知道 B 是什么
      if (q.options.length && r.answer != null && q.type !== 'fill' && q.type !== 'qa') {
        const picked = Array.isArray(r.answer) ? r.answer : [r.answer];
        for (const o of q.options) {
          const hit = picked.some((p) => String(p).toUpperCase() === o.label);
          if (hit) {
            const t = o.text.length > 54 ? o.text.slice(0, 53) + '…' : o.text;
            lines.push(`    ${C.green}▸ ${o.label}. ${t}${C.reset}`);
          }
        }
      }
      // 填空/简答直接显示答案全文
      if ((q.type === 'fill' || q.type === 'qa') && r.answer != null) {
        const full = Array.isArray(r.answer) ? r.answer.join(' | ') : String(r.answer);
        lines.push(`    ${C.cyan}${full.slice(0, 200)}${C.reset}`);
      }
    }
  });

  lines.push(`${C.gray}${'─'.repeat(66)}${C.reset}`);
  console.log(lines.join('\n'));
}

/* ══════════════ 网页 ══════════════ */

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>答题台</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font:16px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    background:#0d1117;color:#e6edf3;padding:20px 18px 60px;min-height:100vh;
  }
  .top{display:flex;align-items:center;gap:12px;margin-bottom:18px;position:sticky;top:0;
       background:#0d1117;padding:8px 0 12px;z-index:9;border-bottom:1px solid #21262d}
  .dot{width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
  .dot.busy{background:#d29922;box-shadow:0 0 8px #d29922;animation:p 1s infinite}
  @keyframes p{50%{opacity:.3}}
  h1{font-size:15px;font-weight:600;flex:1}
  .meta{font-size:12px;color:#8b949e}
  .card{
    background:#161b22;border:1px solid #21262d;border-radius:12px;
    padding:16px 18px;margin-bottom:14px;
  }
  .card.low{border-color:#9e6a03;background:#1c1710}
  .card.none{border-color:#8b2c2c;background:#1c1010}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .num{font-size:13px;color:#8b949e;font-weight:600}
  .tag{font-size:11px;color:#8b949e;background:#21262d;padding:2px 8px;border-radius:20px}
  .conf{font-size:11px;color:#6e7681;margin-left:auto}
  .ans{
    font-size:44px;font-weight:700;line-height:1.15;letter-spacing:2px;
    color:#3fb950;margin:6px 0 12px;word-break:break-word;
  }
  .low .ans{color:#d29922}
  .none .ans{color:#f85149;font-size:22px;letter-spacing:0}
  .ans.text{font-size:19px;letter-spacing:0;line-height:1.55;font-weight:500;color:#79c0ff}
  .stem{font-size:14px;color:#8b949e;line-height:1.55;margin-bottom:10px;
        padding-left:10px;border-left:2px solid #21262d}
  .opt{font-size:14px;color:#6e7681;padding:3px 0 3px 10px}
  .opt.pick{color:#3fb950;font-weight:600;background:#0f2417;border-radius:6px}
  .empty{text-align:center;color:#484f58;padding:80px 20px;font-size:14px;line-height:2}
  .hint{position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #21262d;
        padding:10px 18px;font-size:12px;color:#6e7681;text-align:center}
</style>
</head><body>
  <div class="top">
    <div class="dot" id="dot"></div>
    <h1>答题台</h1>
    <div class="meta" id="meta">连接中…</div>
  </div>
  <div id="app"><div class="empty">等待抓取…<br><span style="font-size:12px">在终端按 r 重新抓取当前屏幕</span></div></div>
  <div class="hint">答案按置信度着色：绿 ≥0.85 · 黄 0.7-0.85 · 红 未解出</div>
<script>
const TYPE={single:'单选',multiple:'多选',judge:'判断',fill:'填空',wordfill:'选词',qa:'简答',composite:'复合'};
let lastStamp='';
async function poll(){
  try{
    const r=await fetch('/api/state?_='+Date.now());
    const d=await r.json();
    document.getElementById('dot').className='dot'+(d.busy?' busy':'');
    if(d.busy){document.getElementById('meta').textContent=d.status||'解题中…';}
    else if(d.stamp!==lastStamp){
      lastStamp=d.stamp; render(d);
      document.getElementById('meta').textContent=d.count?d.count+' 题':'';
    }
  }catch(e){document.getElementById('meta').textContent='连接断开';}
  setTimeout(poll,1200);
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function render(d){
  const app=document.getElementById('app');
  if(!d.questions||!d.questions.length){
    app.innerHTML='<div class="empty">当前屏幕没有识别到题目<br><span style="font-size:12px">翻到有题的一页，然后在终端按 r</span></div>';
    return;
  }
  app.innerHTML=d.questions.map((q,i)=>{
    const a=d.results[i]||{};
    const conf=a.confidence??0;
    const cls=a.answer==null?'none':(conf<0.7?'none':(conf<0.85?'low':''));
    let ans='未解出', isText=false;
    if(a.answer!=null){
      if(Array.isArray(a.answer)){ans=a.answer.join('');}
      else {ans=String(a.answer);}
      if(q.type==='qa'||q.type==='fill'||ans.length>16){isText=true;}
    }
    const picked=Array.isArray(a.answer)?a.answer:(a.answer!=null?[a.answer]:[]);
    const opts=q.options&&q.options.length?q.options.map(o=>{
      const hit=picked.some(p=>String(p).toUpperCase()===o.label);
      return '<div class="opt'+(hit?' pick':'')+'">'+esc(o.label+'. '+o.text)+'</div>';
    }).join(''):'';
    return '<div class="card '+cls+'">'
      +'<div class="head"><span class="num">'+(q.number??i+1)+'</span>'
      +'<span class="tag">'+(TYPE[q.type]||q.type)+'</span>'
      +'<span class="conf">'+(a.reason==='bank'?'题库':conf.toFixed(2))+'</span></div>'
      +'<div class="ans'+(isText?' text':'')+'">'+esc(ans)+'</div>'
      +'<div class="stem">'+esc(q.stem)+'</div>'
      +opts
      +'</div>';
  }).join('');
}
poll();
</script>
</body></html>`;

/**
 * 启动本地答题台
 * @returns {{port:number, update:Function, setBusy:Function, close:Function}}
 */
export async function startDashboard({ port = 7802, openBrowser = true } = {}) {
  let state = { stamp: '', questions: [], results: [], busy: false, status: '', count: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return;
    }

    if (url.pathname === '/api/state') {
      // 只传出页面需要的字段，别把整个节点树发过去
      const payload = {
        stamp: state.stamp,
        busy: state.busy,
        status: state.status,
        count: state.count,
        questions: state.questions.map((q) => ({
          number: q.number,
          type: q.type,
          stem: q.stem,
          options: q.options.map((o) => ({ label: o.label, text: o.text })),
        })),
        results: state.results.map((r) => ({
          answer: r.answer,
          confidence: r.confidence,
          reason: r.reason,
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = `http://127.0.0.1:${port}`;
  console.log(`${C.gray}答题台：${C.cyan}${url}${C.reset}`);

  if (openBrowser) {
    const { spawn } = await import('node:child_process');
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {}
  }

  return {
    url,
    update(questions, results) {
      state = {
        ...state,
        stamp: `${Date.now()}`,
        questions,
        results,
        count: questions.length,
        busy: false,
        status: '',
      };
    },
    setBusy(busy, status = '') {
      state = { ...state, busy, status };
    },
    close() {
      try { server.close(); } catch (_) {}
    },
  };
}

/* ══════════════ 兜底：导出成 HTML 文件 ══════════════ */

/** 服务器起不来时，直接落一个静态 HTML（手机传过去也能看） */
export function exportHtml(questions, results, outDir = '.') {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const data = {
    stamp: String(Date.now()),
    busy: false, status: '', count: questions.length,
    questions: questions.map((q) => ({
      number: q.number, type: q.type, stem: q.stem,
      options: q.options.map((o) => ({ label: o.label, text: o.text })),
    })),
    results: results.map((r) => ({ answer: r.answer, confidence: r.confidence, reason: r.reason })),
  };
  const file = path.join(outDir, 'answers.html');
  const html = PAGE.replace(
    '<div id="app">',
    `<script>window.__BOOT__=${JSON.stringify(data)};</script><div id="app">`
  ).replace('poll();', 'if(window.__BOOT__){lastStamp=__BOOT__.stamp;render(__BOOT__);}');
  writeFileSync(file, html, 'utf8');
  return file;
}
