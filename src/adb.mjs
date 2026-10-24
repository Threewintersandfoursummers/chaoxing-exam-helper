/**
 * adb.mjs — ADB 通信层
 *
 * 为什么走 ADB 而不是在手机上装 APP：
 *   学习通考试页会声明 FLAG_SECURE，截屏/录屏/投屏拿到的全是黑屏。
 *   但 uiautomator 走的是无障碍节点树，读到的是「文本 + 坐标」，不是像素 —— 不受影响。
 *   而且 ADB 是外部通道，手机上不装任何东西，APP 扫不到第三方包。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const ADB_NAME = isWin ? 'adb.exe' : 'adb';

/** 按顺序找 adb：项目内 → PATH → 常见安装位置 */
function locateAdb() {
  const candidates = [
    path.join(process.cwd(), 'bin', ADB_NAME),
    path.join(process.cwd(), '..', 'bin', ADB_NAME),
    process.env.ADB_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', ADB_NAME),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', ADB_NAME),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', ADB_NAME),
    'C:\\platform-tools\\adb.exe',
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return ADB_NAME; // 交给 PATH 解析
}

export const ADB = locateAdb();

/** 执行 adb 命令，返回 stdout 字符串（UTF-8） */
export function run(args, { timeout = 20000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      args,
      { timeout, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout?.toString('utf8') ?? '';
        const errOut = stderr?.toString('utf8') ?? '';
        if (err && !raw) {
          const msg = (errOut || out || err.message || '').trim();
          return reject(new Error(msg || `adb ${args.join(' ')} 失败`));
        }
        resolve(raw ? { out, err: errOut, code: err?.code ?? 0 } : out);
      }
    );
  });
}

/** 已连接设备列表 */
export async function devices() {
  const out = await run(['devices', '-l']);
  const list = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
    if (!m) continue;
    if (m[1] === 'List') continue;
    list.push({
      serial: m[1],
      state: m[2],
      model: (m[3].match(/model:(\S+)/) || [])[1] || '',
    });
  }
  return list;
}

/** 确保有且仅有一台可用设备 */
export async function requireDevice() {
  const list = await devices();
  if (!list.length) {
    throw new Error(
      '没有检测到设备。请：\n' +
      '  1) 手机用数据线连电脑\n' +
      '  2) 手机设置 → 关于手机 → 连点「版本号」7 次开启开发者选项\n' +
      '  3) 开发者选项 → 打开「USB 调试」\n' +
      '  4) 手机上弹窗点「允许」\n' +
      '  然后重跑本程序'
    );
  }
  const ready = list.filter((d) => d.state === 'device');
  if (!ready.length) {
    const bad = list[0];
    if (bad.state === 'unauthorized') {
      throw new Error('设备未授权。看手机屏幕，在「允许 USB 调试吗？」弹窗上点「允许」。');
    }
    throw new Error(`设备状态异常：${bad.state}`);
  }
  return ready[0];
}

/** 屏幕分辨率 */
export async function screenSize(serial) {
  const out = await run(['-s', serial, 'shell', 'wm', 'size']);
  const m = out.match(/(\d+)\s*x\s*(\d+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1080, h: 2400 };
}

/**
 * 抓取当前界面的 UI 树（XML）
 *
 * 关键：不用 screencap（会被 FLAG_SECURE 挡），用 uiautomator dump（走无障碍节点）。
 */
export async function dumpUI(serial, { retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      await run(['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/cx_ui.xml'], { timeout: 15000 });
      const xml = await run(['-s', serial, 'shell', 'cat', '/sdcard/cx_ui.xml'], { timeout: 15000 });
      if (xml && xml.includes('<hierarchy')) return xml;
      throw new Error('dump 内容为空');
    } catch (e) {
      if (i === retries) {
        throw new Error(
          `抓取界面失败：${e.message}\n` +
          '常见原因：屏幕锁着、当前是系统弹窗、或者 uiautomator 服务卡住。\n' +
          '试试：重开一次学习通页面，或拔插一次数据线。'
        );
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

/** 点击坐标 */
export async function tap(serial, x, y) {
  await run(['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

/** 滑动（翻页/滚动） */
export async function swipe(serial, x1, y1, x2, y2, ms = 300) {
  await run([
    '-s', serial, 'shell', 'input', 'swipe',
    String(Math.round(x1)), String(Math.round(y1)),
    String(Math.round(x2)), String(Math.round(y2)),
    String(ms),
  ]);
}

/** 当前前台窗口（用于确认在学习通里，而不是桌面） */
export async function currentPackage(serial) {
  try {
    // 注意：execFile 不走 shell，管道必须整体作为「一个参数」交给设备端 shell
    const out = await run(['-s', serial, 'shell', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"']);
    return out.trim();
  } catch (_) {
    return '';
  }
}

/** 无线调试连接（Android 11+ 配对码模式） */
export async function connectWireless(hostPort, pairCode, pairHostPort) {
  if (pairCode && pairHostPort) {
    await run(['pair', pairHostPort, pairCode], { timeout: 30000 });
  }
  const out = await run(['connect', hostPort], { timeout: 30000 });
  return out.trim();
}

/** 环境自检 */
export async function selfCheck() {
  const report = { adbPath: ADB, adbOk: false, version: '', devices: [] };
  try {
    report.version = (await run(['version'])).split('\n')[0].trim();
    report.adbOk = true;
  } catch (e) {
    report.error = e.message;
    return report;
  }
  try {
    report.devices = await devices();
  } catch (_) {}
  return report;
}
