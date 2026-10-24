/**
 * sh.mjs — 统一 shell 通道
 *
 * 一台手机的封闭考场里，没有电脑可以当「外部读屏器」，
 * 所以读屏 + 点击必须全部在手机本地完成。
 *
 * 三种后端，按可用性自动选：
 *   rish  Shizuku 提供的 shell（推荐）——不 root、不装无障碍、不挂悬浮窗
 *   adb   无线调试自连（adb connect 127.0.0.1:端口）
 *   su    已 root 的机器
 *
 * 为什么 Shizuku 是首选，而不是「一直开着无线调试」：
 *   Shizuku 用无线调试启动后，会以独立进程（shell uid）常驻；
 *   此时可以【关掉无线调试】，adb_enabled 归 0，连接照样在。
 *   学习通去读 Settings.Global.adb_enabled 只会读到 0。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
const TMP_XML = '/data/local/tmp/cx_ui.xml';

/**
 * 找 adb：环境变量 → 项目自带 tools/platform-tools → PATH
 * 小白不会配 PATH，所以项目里带一份是最省事的。
 */
export function findAdb() {
  if (process.env.ADB_PATH && existsSync(process.env.ADB_PATH)) return process.env.ADB_PATH;

  const exe = isWin ? 'adb.exe' : 'adb';
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, '..'),          // chaoxing_app/
    resolve(here, '..', '..'),    // 工作区根
  ];
  for (const r of roots) {
    for (const sub of ['tools/platform-tools', 'platform-tools', '../tools/platform-tools']) {
      const p = join(r, sub, exe);
      if (existsSync(p)) return p;
    }
  }
  // 电脑侧常见安装位置
  if (isWin) {
    for (const p of [
      'C:\\platform-tools\\adb.exe',
      join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    ]) {
      if (p && existsSync(p)) return p;
    }
  }
  return 'adb'; // 交给 PATH
}

/** 直接执行一个本地可执行文件（Termux 内的 termux-api 工具走这里） */
export function localExec(bin, args = [], { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout?.toString('utf8') ?? '';
        const e = stderr?.toString('utf8') ?? '';
        if (err) {
          const msg = (e || out || err.message || '').trim();
          return reject(new Error(msg || `${bin} 执行失败`));
        }
        resolve(out);
      }
    );
  });
}

/** 外壳转义：把一段文本安全地塞进 shell 字符串的单引号里 */
export function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/* ══════════════ 执行器工厂 ══════════════ */

function runner(mode, { serial = '', adb = '' } = {}) {
  switch (mode) {
    case 'rish':
      // rish -c "<命令串>"，Shizuku 以 shell uid 执行
      return (cmd) => [process.env.RISH_PATH || 'rish', ['-c', cmd]];

    case 'adb': {
      // adb shell 后面接一个命令串，交给设备端 sh 解析（管道可用）
      const bin = adb || findAdb();
      const base = serial ? ['-s', serial, 'shell'] : ['shell'];
      return (cmd) => [bin, [...base, cmd]];
    }

    case 'su':
      return (cmd) => ['su', ['-c', cmd]];

    case 'sh':
      return (cmd) => [isWin ? 'bash' : 'sh', ['-c', cmd]];

    default:
      throw new Error(`未知 shell 模式：${mode}`);
  }
}

/** 构造一个设备对象（不校验连通性） */
export function makeDevice(mode, opts = {}) {
  const build = runner(mode, opts);

  const dev = {
    mode,
    serial: opts.serial || '',
    /** 原始 shell 执行 */
    async raw(cmd, { timeout = 25000 } = {}) {
      const [bin, args] = build(cmd);
      return localExec(bin, args, { timeout });
    },

    /**
     * 通道自愈（仅 adb 模式）：把自连端口重新 connect 一次。
     * 2026-10-24 实测：拔 USB 的瞬间 vivo 会重置 adbd，引擎所有命令
     * 瞬间全挂；即使 adbd 恢复监听，客户端的 transport 映射仍是断的，
     * 必须重新 connect 才能连回来。连上后引擎自动恢复，不用人管。
     */
    async reconnect() {
      if (mode !== 'adb') return false;
      try {
        const bin = opts.adb || findAdb();
        const out = await localExec(
          bin,
          ['connect', opts.serial || '127.0.0.1:5555'],
          { timeout: 10000 }
        );
        return /connected to|already connected/i.test(String(out));
      } catch (_) {
        return false;
      }
    },

    /**
     * 抓 UI 树。dump + cat 合成一次往返，省一半启动开销。
     *
     * 三个必须处理的真实故障（都踩过）：
     *   ① 上一轮的 xml 还在 → 失败时会读到【上一屏】的坐标 → 点错位置。
     *      所以先 rm，再确认文件是本轮新写的。
     *   ② uiautomator 是 Java 进程，低内存机器会被 OOM 杀掉（Killed / RC=137）。
     *   ③ 屏幕动画不停时 dump 会卡在等 idle。--compressed 通常能过去。
     * 任何失败都必须把原始报错带出去，不能吞进 /dev/null。
     */
    async dump({ timeout = 20000, retries = 3 } = {}) {
      let lastErr = '';
      for (let attempt = 0; attempt < retries; attempt++) {
        // 先删旧文件：这是防止「读到上一屏」的关键
        const out = await dev
          .raw(
            `rm -f ${TMP_XML}; ` +
              `r=$(uiautomator dump ${TMP_XML} 2>&1); rc=$?; ` +
              `echo "__RC:$rc"; echo "__MSG:$r"; ` +
              `if [ -f ${TMP_XML} ]; then echo "__XML:"; cat ${TMP_XML}; fi`,
            { timeout }
          )
          .catch((e) => `__RC:1\n__MSG:${e.message}`);

        const rc = Number((out.match(/__RC:(\d+)/) || [])[1] ?? 1);
        const msg = (out.match(/__MSG:(.*)/) || [])[1]?.trim() || '';
        const i = out.indexOf('<hierarchy');
        if (rc === 0 && i >= 0) return out.slice(i);

        lastErr = msg || `dump 返回码 ${rc}`;
        // 等 idle 超时 → 用压缩模式再试一次（少了冗余节点，更容易过）
        if (/idle|timeout|Waited/i.test(lastErr)) {
          const out2 = await dev
            .raw(
              `rm -f ${TMP_XML}; uiautomator dump --compressed ${TMP_XML} >/dev/null 2>&1; ` +
                `if [ -f ${TMP_XML} ]; then cat ${TMP_XML}; fi`,
              { timeout }
            )
            .catch(() => '');
          const j = out2.indexOf('<hierarchy');
          if (j >= 0) return out2.slice(j);
        }
        await new Promise((r) => setTimeout(r, 700));
      }

      const why = /Killed|137/.test(lastErr)
        ? '读屏进程被系统杀掉（内存不足）——关掉几个后台 app 再试'
        : /idle|Waited/i.test(lastErr)
          ? '页面一直在动，读不到静态画面——等动画停下再试'
          : lastErr;
      throw new Error(`UI 树读取失败：${why}`);
    },

    /** 单点 */
    async tap(x, y) {
      await dev.raw(`input tap ${Math.round(x)} ${Math.round(y)}`);
    },

    /**
     * 批量点击：一次 shell 往返打完全部点
     * 每两次之间插 sleep，模拟手指移动间隔
     */
    async taps(list, { gapMs = 520 } = {}) {
      if (!list.length) return 0;
      const parts = list.map(
        (p) => `input tap ${Math.round(p.x)} ${Math.round(p.y)}`
      );
      const cmd = parts.join(`; sleep ${(gapMs / 1000).toFixed(2)}; `);
      await dev.raw(cmd, { timeout: 15000 + parts.length * 1000 });
      return parts.length;
    },

    /** 滑动 */
    async swipe(x1, y1, x2, y2, ms = 320) {
      await dev.raw(
        `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`
      );
    },

    /** 长按（用于唤起粘贴菜单） */
    async longPress(x, y, ms = 750) {
      await dev.raw(`input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x)} ${Math.round(y)} ${ms}`);
    },

    /** 屏幕尺寸 */
    async screenSize() {
      try {
        const out = await dev.raw('wm size');
        const m = out.match(/(\d+)\s*x\s*(\d+)/);
        if (m) return { w: Number(m[1]), h: Number(m[2]) };
      } catch (_) {}
      return { w: 1080, h: 2400 };
    },

    /** 当前前台窗口 */
    async foreground() {
      try {
        return (
          await dev.raw('dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp"')
        ).trim();
      } catch (_) {
        return '';
      }
    },

    /** 是否在学习通里 */
    async inChaoxing() {
      const f = await dev.foreground();
      return /chaoxing|xuexitong|edu\.cn|fanya/i.test(f) || f === '';
    },
  };

  return dev;
}

/* ══════════════ 自动探测 ══════════════ */

/** 列出 adb 设备：[{serial, state, model}] */
export async function listAdbDevices() {
  const bin = findAdb();
  try {
    const out = await localExec(bin, ['devices', '-l'], { timeout: 15000 });
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        const m = l.match(/model:(\S+)/);
        return { serial, state, model: m ? m[1].replace(/_/g, ' ') : '' };
      });
  } catch (_) {
    return [];
  }
}

/** 自动挑一台可用的 adb 设备（优先真机，跳过未授权） */
export async function pickAdbSerial() {
  const all = await listAdbDevices();
  const ok = all.filter((d) => d.state === 'device');
  if (!ok.length) return { serial: '', all };
  const real = ok.find((d) => !/^emulator-/.test(d.serial)) || ok[0];
  return { serial: real.serial, all };
}

/** 探测可用后端，返回第一个能跑通 `echo` 的设备 */
export async function openDevice({ mode = 'auto', serial = '', adb = '', noisy = false } = {}) {
  // adb 放最前：手机端 rish 已知会偶发 timeout，先试它每次白等 15 秒
  const order = mode === 'auto' ? ['adb', 'rish', 'su'] : [mode];
  const errors = [];

  // adb 模式下没指定序列号 → 先看环境变量，再自动挑
  let useSerial = serial || process.env.CX_ADB_SERIAL || '';
  if ((mode === 'auto' || mode === 'adb') && !useSerial) {
    const picked = await pickAdbSerial();
    useSerial = picked.serial;
    if (noisy && useSerial) console.error(`  设备：${useSerial}`);
  }

  for (const m of order) {
    if (m === 'rish' && !hasRish()) {
      errors.push('rish: 未找到（Termux 里要先跑 setup）');
      continue;
    }
    if (m === 'adb' && !useSerial) {
      errors.push('adb: 没有已授权的设备');
      continue;
    }
    try {
      const dev = makeDevice(m, { serial: useSerial, adb });
      const out = await dev.raw('echo __cx_ok__', { timeout: 15000 });
      if (!String(out).includes('__cx_ok__')) throw new Error('shell 无响应');
      if (noisy) console.error(`  shell 通道：${m}`);
      return dev;
    } catch (e) {
      errors.push(`${m}: ${String(e.message).split('\n')[0]}`);
    }
  }

  const hint = [
    '没有可用的 shell 通道。三种情况：',
    '  ① 手机在用 Shizuku（推荐）：确认 Shizuku 是「运行中」，且已把 rish 复制到 Termux',
    '  ② 手机用无线调试自连：adb connect 127.0.0.1:<端口> 之后重试',
    '  ③ 电脑连着手机：数据线插上、USB 调试授权',
  ].join('\n');

  const err = new Error(`${hint}\n\n探测详情：\n  ${errors.join('\n  ')}`);
  err.details = errors;
  throw err;
}

/** rish 是否就位（Shizuku 的 deb 包 + 脚本都要在同目录） */
export function hasRish() {
  const p = process.env.RISH_PATH || 'rish';
  if (p.includes('/') || p.includes('\\')) return existsSync(p);
  const prefix = process.env.PREFIX || '';
  // Termux 里 PREFIX 一定有值，这时文件不存在就是真的没装
  if (prefix) return existsSync(`${prefix}/bin/${p}`);
  return true; // 非 Termux 环境交给实际执行去判断
}

export { TMP_XML };
