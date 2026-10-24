#!/data/data/com.termux/files/usr/bin/bash
# 考试当天用：在 Termux 里跑这一句即可
#   bash ~/chaoxing/run.sh            正常自动答题
#   bash ~/chaoxing/run.sh 37123      手机重启后用无线调试端口救场
#   bash ~/chaoxing/run.sh dry        只解题不点击（演练）
#
# 它在后台启动 start.sh，日志写到 ~/run.log
cd "$HOME/chaoxing" || exit 1

# 上一次的日志先留个备份，别让新一次把证据冲掉
[ -f "$HOME/run.log" ] && cp "$HOME/run.log" "$HOME/run.prev.log" 2>/dev/null

nohup bash start.sh "$@" > "$HOME/run.log" 2>&1 &
PID=$!
echo "已启动，pid=$PID"
echo "现在按 Home 键，切到学习通，不要碰屏幕。"
echo "（日志在 ~/run.log，跑完再看，中途别切回来看）"
