#!/data/data/com.termux/files/usr/bin/bash
#
# start.sh — 考试当天一条命令启动
#
#   用法：
#     bash start.sh          正式自动答题
#     bash start.sh dry      演练（解题但不点任何东西）
#     bash start.sh doctor   自检
#     bash start.sh llm      只验 AI 出答案（不读屏不点屏，3 秒）
#
# 设计原则：把「启动前必须成立的条件」逐条验一遍，全绿才真正启动。
# 任意一条红，它停下并告诉你修哪里 —— 而不是让你带着问题进考场，
# 在考试中途才发现读不到屏幕。
#
set -u
cd "$(dirname "$0")" || exit 1

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
RED=$'\033[31m'; YEL=$'\033[33m'; RST=$'\033[0m'

ok()   { echo "  ${GREEN}✓${RST} $*"; }
warn() { echo "  ${YEL}!${RST} $*"; }
bad()  { echo "  ${RED}✗${RST} $*"; }
die()  { bad "$1"; shift; for l in "$@"; do echo "    ${DIM}$l${RST}"; done; cleanup; exit 1; }

# 参数解析：允许把「无线调试端口」直接当参数传进来
#   bash start.sh 37123        端口写在第一位（重启后救场用）
#   bash start.sh dry 37123    模式 + 端口
MODE="run"
EXTRA_PORT=""
for a in "$@"; do
  case "$a" in
    '') ;;
    *[!0-9]*) MODE="$a" ;;
    *) EXTRA_PORT="$a" ;;
  esac
done

LOCKED=0
cleanup() { if [ "$LOCKED" = "1" ]; then termux-wake-unlock 2>/dev/null; LOCKED=0; fi; }
trap cleanup EXIT INT TERM

PORTFILE="$HOME/.cx_port"
CHAN=""
DEVICE=""

# 统一的"在手机上执行 shell 命令"入口，屏蔽 adb / rish 差异
dev_sh() {
  if [ "$CHAN" = "adb" ]; then
    adb -s "$DEVICE" shell "$1" 2>/dev/null
  else
    rish -c "$1" 2>/dev/null
  fi
}

echo
echo "${BOLD}学习通单机版 · 启动检查${RST}"
echo "${DIM}$(date '+%H:%M:%S')  模式：$MODE${RST}"
echo

# ── 1. Node ────────────────────────────────────
command -v node >/dev/null 2>&1 \
  || die "没有 node" "pkg install nodejs"
ok "node $(node -v 2>/dev/null)"

# ── 2. shell 通道：adb 优先，rish 兜底 ──────────
discover_adb() {
  command -v adb >/dev/null 2>&1 || return 1

  # 所有 adb 调用都必须带超时：2026-10-24 实测 adbd 刚重启时
  # `adb connect` 会无限期挂住，start.sh 卡死在自检里，日志停在一半。
  TO=""
  command -v timeout >/dev/null 2>&1 && TO="timeout 6"

  # 清掉上一次留下的 offline 条目，否则后面会自动选到它
  $TO adb devices 2>/dev/null | awk '/offline/{print $1}' | while read -r d; do
    $TO adb disconnect "$d" >/dev/null 2>&1
  done

  PORTS=""
  [ -f "$PORTFILE" ] && PORTS=$(cat "$PORTFILE" 2>/dev/null)
  # 命令行传进来的端口最优先（手机重启后 5555 会失效，无线调试端口每次都不一样）
  PORTS="$EXTRA_PORT $PORTS 5555 40681"

  for p in $PORTS; do
    case "$p" in ''|*[!0-9]*) continue ;; esac
    $TO adb connect "127.0.0.1:$p" >/dev/null 2>&1
    if $TO adb -s "127.0.0.1:$p" shell "echo __cx__" 2>/dev/null | grep -q "__cx__"; then
      DEVICE="127.0.0.1:$p"
      CHAN="adb"
      echo "$p" > "$PORTFILE" 2>/dev/null
      return 0
    fi
    $TO adb disconnect "127.0.0.1:$p" >/dev/null 2>&1
  done

  # 兜底（2026-10-24 实测）：adbd 被 adb tcpip 重启后，本机 adb 服务器重新
  # 扫端口会把手机自己注册成 emulator-5554 这样的别名 —— 127.0.0.1:端口
  # 反而查不到，上面的循环就永远失败。直接扫设备表里所有本地序列号，
  # 哪个能跑 shell 用哪个。
  for d in $($TO adb devices 2>/dev/null | awk '/\tdevice$/{print $1}'); do
    case "$d" in
      emulator-*|127.0.0.1:*)
        if $TO adb -s "$d" shell "echo __cx__" 2>/dev/null | grep -q "__cx__"; then
          DEVICE="$d"
          CHAN="adb"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

if discover_adb; then
  ok "shell 通道 adb · $DEVICE"
else
  command -v rish >/dev/null 2>&1 || die "没有可用的 shell 通道" \
    "手机自己连自己有两条路，按顺序试：" \
    "" \
    "① 固定端口（推荐，考前在电脑上做一次，之后不重启手机就一直有效）" \
    "   设置 → 开发者选项 → 打开「无线调试」" \
    "   电脑插数据线执行：adb tcpip 5555" \
    "   回 Termux：bash start.sh" \
    "" \
    "② 手动看端口（手机重启过、身边没电脑时用）" \
    "   设置 → 开发者选项 → 无线调试 → 看「IP 地址和端口」那行的数字" \
    "   Termux 里执行：adb connect 127.0.0.1:那个数字" \
    "   然后再 bash start.sh"

  if rish -c "echo __cx__" 2>&1 | grep -q "__cx__"; then
    CHAN="rish"
    ok "shell 通道 rish"
  else
    die "adb 和 rish 都不通" \
        "优先修 adb：开发者选项打开「无线调试」，电脑执行 adb tcpip 5555" \
        "rish 那条路已知在本机会偶发 timeout，不作为主力"
  fi
fi

# ── 3. 屏幕亮着（息屏时 dump 必失败）────────────
WAKE=$(dev_sh "dumpsys power 2>/dev/null | grep -m1 'mWakefulness='")
case "$WAKE" in
  *Awake*) ok "屏幕已点亮" ;;
  *) warn "屏幕可能是灭的 —— 息屏后读不到界面，请先点亮屏幕" ;;
esac

# ── 4. dump 真能跑通（这是整个方案的地基）──────
if dev_sh "rm -f /sdcard/.cx_probe.xml; uiautomator dump /sdcard/.cx_probe.xml >/dev/null 2>&1; test -f /sdcard/.cx_probe.xml && echo Y" | grep -q Y; then
  ok "读屏可用（uiautomator dump）"
else
  warn "读屏自检失败 —— 可能是学习通界面正在加载，或系统内存紧张"
  echo "    ${DIM}不影响启动，但进考试后若一直读不到题，回来看这一行${RST}"
fi

# ── 5. 调试开关状态（如实告知，不假装）──────────
ADB_EN=$(dev_sh "settings get global adb_enabled" | tr -d '[:space:]')
if [ "$ADB_EN" = "1" ]; then
  warn "adb_enabled = 1（无线 adb 通道必须开着，关掉连接就断）"
  echo "    ${DIM}这个开关属于常见反作弊检测项之一。要彻底归零只能用 Shizuku 的 rish，${RST}"
  echo "    ${DIM}而 rish 在本机实测会偶发超时，所以默认用更稳的 adb。${RST}"
else
  ok "调试开关 adb_enabled = ${ADB_EN:-读不到}"
fi

# ── 6. API Key ─────────────────────────────────
[ -f config.json ] || die "没有 config.json" "cp config.example.json config.json  然后填 key"
KEY=$(node -e "
  try{
    const c=require('./config.json');
    const p=(c.providers||[]).filter(x=>x.enabled!==false).map(x=>String(x.apiKey||''));
    const good=p.filter(k=>/^[A-Za-z0-9_\-\.]{12,}\$/.test(k)&&!/在这里|你的\s*key|your[\s_-]*api[\s_-]*key|your[\s_-]*key|api[\s_-]*key[\s_-]*here|placeholder|请填|待填|TODO|^sk-x+\$|^xxx+\$/i.test(k));
    console.log(good.length);
  }catch(e){console.log(-1)}
" 2>/dev/null)

if [ "$KEY" = "-1" ]; then
  die "config.json 格式有问题（JSON 解析失败）" \
      "常见原因：中文引号、少了逗号、多了逗号" \
      "用 node -e \"require('./config.json')\" 看报错"
elif [ "$KEY" = "0" ]; then
  die "没有可用的 API Key" \
      "nano config.json" \
      "把 \"apiKey\": \"\" 换成真 key" \
      "（占位符、长度不足 12 位的会被判定为无效，防止带着假 key 进考场）"
fi
ok "可用 Key $KEY 个"

# ── 7. 网络能不能通到模型（考场网络常常挡 API）──
if command -v curl >/dev/null 2>&1; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://api.deepseek.com/ 2>/dev/null)
  case "$CODE" in
    2*|3*|401|403|404|422) ok "网络通 · api.deepseek.com HTTP $CODE" ;;
    ''|000) warn "连不上 api.deepseek.com —— 考场网络可能挡了 API 域名" \
              "    ${DIM}换 4G/5G 再试；校园网常需要先网页认证${RST}" ;;
    *) warn "api.deepseek.com 返回 HTTP $CODE（可能被网关拦截）" ;;
  esac
else
  warn "没有 curl，跳过网络检查（pkg install curl）"
fi

# ── 8. 中文输入通道（填空/简答依赖它写中文）────
# 剪贴板方案已废弃：Termux:API 的 GitHub 版 APK 缺 TermuxApiReceiver 组件，
# termux-clipboard-set 必然超时。改用 ADBKeyboard 走 IME 注入。
#
# 先做崩溃自愈：程序在「切到 ADBKeyboard 之后、切回之前」被杀（或被冻结），
# 输入法就停在 ADBKeyboard 上 —— 症状是用户想手打却没键盘，而那时他不敢
# 切出去修。切换前会把原输入法写进 ~/.cx_ime_backup，这里据此恢复。
CUR_IME=$(dev_sh "settings get secure default_input_method" | tr -d '\r\n')
if echo "$CUR_IME" | grep -qi adbkeyboard; then
  SAVED_IME=$(cat "$HOME/.cx_ime_backup" 2>/dev/null | tr -d '\r\n')
  if [ -n "$SAVED_IME" ]; then
    dev_sh "ime set $SAVED_IME" >/dev/null 2>&1
    if [ "$(dev_sh 'settings get secure default_input_method' | tr -d '\r\n')" = "$SAVED_IME" ]; then
      ok "输入法已从 ADBKeyboard 自动恢复"
      rm -f "$HOME/.cx_ime_backup"
    else
      warn "输入法还停在 ADBKeyboard，自动恢复失败" \
            "    ${DIM}设置 → 系统 → 输入法 手动切回常用输入法${RST}"
    fi
  else
    warn "输入法停在 ADBKeyboard（上次异常退出，且没留备份）" \
          "    ${DIM}设置 → 系统 → 输入法 手动切回，否则手打没键盘${RST}"
  fi
fi

if dev_sh "ime list -s" 2>/dev/null | grep -qi adbkeyboard; then
  ok "中文输入通道可用（填空/简答能自动填）"
else
  warn "没启用 ADBKeyboard —— 填空/简答会留给你手工打" \
        "    ${DIM}装 ADBKeyboard.apk 后：adb shell ime enable com.android.adbkeyboard/.AdbIME${RST}"
fi

# ── 9. 锁住后台，防止 Termux 被冻结 ────────────
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null && LOCKED=1 && ok "已锁后台（termux-wake-lock）"
else
  warn "没有 termux-wake-lock（termux-api 未装），切后台可能被冻结"
fi

echo
echo "${BOLD}即将启动。看到下面这行之后：${RST}"
echo "  ${BOLD}按 Home 键 → 打开学习通 → 进考试，然后不要离开也不要碰屏幕${RST}"
echo

# ⚠ 绝对不要在这里调 termux-toast / termux-clipboard-* 等 termux-api 工具：
# 这台手机的 Termux:API APK 缺 TermuxApiReceiver，广播无人接收，
# 工具会【永久挂起】（实测 timeout 8 杀掉时 RC=124），start.sh 卡死在这一行，
# 后面的 exec node 永远执行不到 —— 表现就是「日志停在横幅、程序无声死亡」。
# 2026-10-24 实锤复现过一次，教训：横幅之后的任何一步都必须是无阻塞的。

# 让 sh.mjs 优先用我们探测到的设备
if [ "$CHAN" = "adb" ]; then
  export CX_ADB_SERIAL="$DEVICE"
fi

# ── 启动 ───────────────────────────────────────
case "$MODE" in
  dry|try)      exec node src/single.mjs dry ;;
  doctor|check) exec node src/single.mjs doctor ;;
  llm|ai)       exec node src/llmtest.mjs ;;
  *)            exec node src/single.mjs ;;
esac
