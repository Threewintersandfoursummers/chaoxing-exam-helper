#!/data/data/com.termux/files/usr/bin/bash
#
# termux-setup.sh — 手机端一键配置（在 Termux 里跑一次就够）
#
# 前提（这两步必须先在手机上手动完成）：
#   1. 装好 Termux（务必从 F-Droid 装，Play 商店版本有 bug）
#   2. 装好 Shizuku，并用「无线调试」启动过它（显示「运行中」）
#
# 用法：
#   bash termux-setup.sh
#
set -u

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
RED=$'\033[31m'; YEL=$'\033[33m'; CYA=$'\033[36m'; RST=$'\033[0m'

ok()   { echo "  ${GREEN}✓${RST} $*"; }
warn() { echo "  ${YEL}!${RST} $*"; }
bad()  { echo "  ${RED}✗${RST} $*"; }
step() { echo; echo "${BOLD}$*${RST}"; }

SHIZUKU_DIR="/storage/emulated/0/Android/data/moe.shizuku.privileged.api/files"
HOME_DIR="$HOME/chaoxing"

echo
echo "${BOLD}学习通单机版 · 环境配置${RST}"
echo "${DIM}手机跑，不需要电脑${RST}"

# ─────────────────────────────────────────────
step "1. 安装依赖"

if ! command -v node >/dev/null 2>&1; then
  echo "  ${DIM}安装 Node.js（约 30MB，等 1-3 分钟）…${RST}"
  pkg install -y nodejs >/dev/null 2>&1 || {
    bad "Node.js 安装失败"; echo "  ${DIM}手动跑：pkg install nodejs${RST}"; exit 1; }
fi
ok "Node $(node -v)"

# termux-api 是可选的，但填空题自动粘贴、通知都靠它
if [ ! -d "$PREFIX/lib/termux-api" ] && ! command -v termux-clipboard-set >/dev/null 2>&1; then
  echo "  ${DIM}安装 termux-api …${RST}"
  pkg install -y termux-api >/dev/null 2>&1
fi
if command -v termux-clipboard-set >/dev/null 2>&1; then
  ok "termux-api 就位"
else
  warn "termux-api 没装上（不影响选择题，填空题会跳过）"
fi

# ─────────────────────────────────────────────
step "2. 定位项目目录"

SRC=""
for cand in "$HOME/chaoxing_app" "/sdcard/Download/chaoxing_app" "/sdcard/chaoxing_app" "$(pwd)"; do
  if [ -f "$cand/src/single.mjs" ]; then SRC="$cand"; break; fi
done

if [ -z "$SRC" ]; then
  bad "找不到项目目录"
  echo "  ${DIM}把 chaoxing_app 整个文件夹放到手机的 Download 目录，然后重跑本脚本。${RST}"
  echo "  ${DIM}如果 Download 里看不到，先执行：termux-setup-storage 并允许权限${RST}"
  exit 1
fi
ok "项目在 $SRC"

if [ "$SRC" != "$HOME_DIR" ]; then
  rm -rf "$HOME_DIR"
  cp -r "$SRC" "$HOME_DIR"
  ok "已复制到 $HOME_DIR"
  echo "  ${DIM}（Termux 私有目录访问更快，也避免存储权限问题）${RST}"
fi

# ─────────────────────────────────────────────
step "3. 配置 Shizuku 的 rish"

if [ ! -d "$SHIZUKU_DIR" ]; then
  bad "读不到 Shizuku 目录"
  echo "  ${DIM}先确认：${RST}"
  echo "  ${DIM}  · Shizuku 已安装并且是「运行中」${RST}"
  echo "  ${DIM}  · 执行过 termux-setup-storage 并允许了存储权限${RST}"
  exit 1
fi

cp -f "$SHIZUKU_DIR/rish" "$PREFIX/bin/rish" 2>/dev/null
cp -f "$SHIZUKU_DIR/rish_shizuku.dex" "$PREFIX/bin/rish_shizuku.dex" 2>/dev/null
chmod 700 "$PREFIX/bin/rish" 2>/dev/null

if [ -f "$PREFIX/bin/rish" ]; then
  ok "rish 已安装"
else
  bad "rish 复制失败"
  echo "  ${DIM}手动执行：cp $SHIZUKU_DIR/rish* \$PREFIX/bin/ && chmod 700 \$PREFIX/bin/rish${RST}"
  exit 1
fi

# ─────────────────────────────────────────────
step "4. 测试 shell 通道"

OUT=$(rish -c "echo __cx_ok__" 2>&1)
if echo "$OUT" | grep -q "__cx_ok__"; then
  ok "Shizuku 通道正常"
else
  bad "Shizuku 通道不通"
  echo "  ${DIM}输出：${RST}$OUT"
  echo "  ${DIM}常见原因：${RST}"
  echo "  ${DIM}  · Shizuku 显示「已停止」→ 打开 Shizuku，用无线调试重新启动${RST}"
  echo "  ${DIM}  · 授权被拒绝 → 在 Shizuku 的「授权应用」里给 Termux 打开开关${RST}"
  exit 1
fi

# ─────────────────────────────────────────────
step "5. 配置文件"

if [ ! -f "$HOME_DIR/config.json" ]; then
  cp "$HOME_DIR/config.example.json" "$HOME_DIR/config.json"
  warn "已生成 config.json，还需要填 API Key"
else
  ok "config.json 已存在"
fi

# ─────────────────────────────────────────────
step "完成"

cat <<EOF

  ${BOLD}接下来三步：${RST}

  1) 填 API Key
     ${CYA}nano $HOME_DIR/config.json${RST}
     找到 ${CYA}"apiKey": "sk-..."${RST} ，换成你自己的

  2) 自检
     ${CYA}cd $HOME_DIR && node src/single.mjs doctor${RST}

  3) 正式用
     ${CYA}cd $HOME_DIR && node src/single.mjs${RST}

  ${DIM}提示：${RST}
  ${DIM}  · 自检时先切到学习通里有题目的页面，才能验证读屏和抽题${RST}
  ${DIM}  · 用 tmux 跑，防止切出去被系统挂起：${RST}
  ${DIM}      pkg install tmux${RST}
  ${DIM}      tmux new -s cx  →  cd ~/chaoxing && node src/single.mjs  →  Ctrl+B D 挂起${RST}
  ${DIM}  · 跑之前先 termux-wake-lock，避免息屏被杀${RST}

EOF
