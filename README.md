# 学习通答题引擎 · Chaoxing Auto-Answer Engine

> 通过 Android 系统自带的 **ADB 通道**读取界面节点树 + 模拟点击，由大模型给出答案。
> **不 root、不装无障碍服务、不修改学习通 APK、截图也不需要**（学习通开了 `FLAG_SECURE`，截屏本来就是纯黑）。
>
> 支持两种跑法：**手机单机版**（Termux，考场无电脑也能用）和 **电脑＋手机版**。

---

## 为什么这条路能走通

反作弊防的是三样东西：装了额外 APP、开了无障碍服务、改了包。本方案三样都不碰。

| 常见做法 | 卡在哪 |
|---|---|
| 截屏 → OCR | 学习通设了 `FLAG_SECURE`，截图是**纯黑** |
| 装无障碍 APP 读屏 | 手机上**多了一个包**，能被扫到 |
| Root / 改 APK | 检测 Root 与签名，封号风险高 |
| **ADB 读 UI 节点树（本方案）** | 走系统自带调试通道，手机零安装 |

关键点：`FLAG_SECURE` 只挡像素，不挡无障碍节点树。

```
截屏：  [纯黑图片]                       ← FLAG_SECURE 生效
读树：  text="根据《建筑法》..."           ← 依然拿得到
        bounds="[42,370][1038,500]"
```

---

## 两种模式

| | 手机单机版（推荐） | 电脑＋手机版 |
|---|---|---|
| 入口 | `src/single.mjs`（`run.sh` 拉起） | `src/main.mjs` |
| 需要电脑 | ❌ 不需要 | ✅ 需要 |
| 通道 | Termux 内 `adb connect 127.0.0.1:5555`（手机连自己） | USB / 无线 adb |
| 适合 | 封闭考场、只有一部手机 | 家里调试、批量刷题 |

---

## 快速开始（手机单机版）

前提：Android 手机 + [Termux](https://f-droid.org/packages/com.termux/)（**请用 F-Droid 版**）+ 一个能注入文本的输入法（如 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)）。

```bash
# 1. 装依赖（只需一次）
pkg update && pkg install nodejs android-tools

# 2. 放代码
#    把本项目放到 ~/chaoxing，然后：
cd ~/chaoxing
cp config.example.json config.json     # 填一个 apiKey，见下

# 3. 让手机的 adbd 监听本地端口（电脑上执行，或手机无线调试）
adb tcpip 5555

# 4. 启动
bash run.sh
```

自检全绿后：**按 Home → 打开学习通 → 进考试 → 不要碰屏幕**。

- 停止：`Ctrl+C`，或另开会话 `touch ~/chaoxing/STOP`
- 日志：`~/run.log`、`~/chaoxing/dump/session-*.log`

---

## 配置

复制 `config.example.json` 为 `config.json`，**只需要填 `apiKey`**，没填的模型会自动跳过、不会报错：

```jsonc
{
  "providers": [
    { "id": "deepseek", "apiKey": "sk-你的key", "enabled": true, "weight": 1.5 }
  ]
}
```

`config.json` 已在 `.gitignore` 里，**不会被提交**。真正的密钥只存在你本机。

---

## 目录结构

```
start.sh              自检（node/通道/读屏/密钥/网络/输入法）后启动引擎
run.sh                用户入口：后台拉起 start.sh，日志写 ~/run.log
src/single.mjs        手机单机版主循环（永不自动退出、单实例锁、断线重连）
src/main.mjs          电脑版入口
src/auto.mjs          核心：解析题目、翻页、点选项、填空注入
src/llm.mjs           批量送题、失败重试、题库记忆
src/sh.mjs            adb / rish 通道封装
lib/solver.mjs        答案归一化与校验
lib/bank.mjs          本地题库（做过的题不再问模型）
test/                 单元测试，node --test 即可
docs/                 操作手册、真机验证报告、重装恢复手册
```

零 npm 依赖，只用 Node 内置模块，Node 18+ 即可运行。

```bash
node --test test/auto.test.mjs     # 解析与答题内核测试
```

---

## 工程上踩过的坑（都已修）

| 坑 | 现象 | 解法 |
|---|---|---|
| WebView 节点树"变瞎" | 节点数从 58 掉到 26，屏幕有按钮但树里没有 | 轻点唤醒 + 固定坐标兜底点击（整树无"交卷"字样才敢盲点） |
| 填空找不到输入框 | 该屏只有 2 段文字，读不到 `EditText` | 重抓两次 → 点题干唤醒 → 整屏唯一输入框兜底 |
| 拔线进程静默死亡 | 无任何提示，进程消失 | 未捕获异常全吞、断线自动重连、降级 rish |
| 自动收工 | 答完一套后引擎自己退出 | 四个退出出口全改待命，只有用户能停 |
| `termux-toast` 挂起 | 启动后进程永不返回 | `start.sh` 里禁用一切 termux-api 调用 |
| adb 把手机认成模拟器 | 出现 `emulator-5554`，`-s` 找不到设备 | 始终指定设备序列号 |

更多细节见 [`docs/学习通引擎-交接与重装恢复手册.md`](docs/学习通引擎-交接与重装恢复手册.md)。

---

## 已知限制

- **交卷永远由人点**：引擎看到"提交/交卷"只停手，不自动点，防误触。
- 填空题依赖注入式输入法，切换输入法瞬间页面可能重排。
- 考试须知页的承诺勾选项按规则直接跳过，若某试卷强制勾选才能进题，需要人工勾一次。
- 只在 **vivo / Android 16 / 1260×2800** 上做过真机验证，其他机型需要重新标定坐标。

---

## 免责声明

本项目仅供**自动化技术与 UI 自动化测试的学习研究**。使用它参加考试可能违反学校的学术诚信规定，后果由使用者自行承担。作者不对任何成绩、处分或法律后果负责。请在你**有权测试**的环境中使用。

---

## 文档

- [考场版-操作手册](docs/考场版-操作手册.md) — 考场当天逐步操作
- [真机验证报告](docs/真机验证报告.md) — 实测数据与失败案例
- [交接与重装恢复手册](docs/学习通引擎-交接与重装恢复手册.md) — 换机器 / 重装系统怎么接上
