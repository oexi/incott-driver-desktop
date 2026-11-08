<div align="center">

<img src="docs/logo.png" width="112" alt="INCOTT Driver" />

# INCOTT Driver

**INCOTT 鼠标的跨平台桌面驱动**

调整 DPI、回报率、按键与宏，设置写入鼠标板载内存，关掉软件也一直生效。

[![Release](https://img.shields.io/github/v/release/oexi/incott-driver-desktop?style=flat-square&color=ff7a1a&label=最新版本)](https://github.com/oexi/incott-driver-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/oexi/incott-driver-desktop/total?style=flat-square&color=2ea043&label=下载)](https://github.com/oexi/incott-driver-desktop/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/oexi/incott-driver-desktop/release.yml?style=flat-square&label=构建)](https://github.com/oexi/incott-driver-desktop/actions/workflows/release.yml)
[![License](https://img.shields.io/github/license/oexi/incott-driver-desktop?style=flat-square&color=8b5cf6&label=协议)](LICENSE)

![Windows](https://img.shields.io/badge/Windows-x64%20%7C%20arm64-0078D4?style=flat-square&logo=windows11&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-Intel%20%7C%20Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-x64%20%7C%20arm64-FCC624?style=flat-square&logo=linux&logoColor=black)

[**⬇ 下载**](#-下载安装) · [功能](#-功能一览) · [常见问题](#-常见问题) · [从源码构建](#️-开发)

<br />

<img src="docs/buttons.webp" width="900" alt="按键设置界面" />

</div>

<br />

## ✨ 亮点

<table>
<tr>
<td width="33%" valign="top">

### 🎯 与官方一致
通信协议从官方 WebHID 网页驱动逐条移植。自动化测试会直接运行**原版代码**，与本项目**逐字节对比**发往鼠标的数据。

</td>
<td width="33%" valign="top">

### 🎨 全新界面
深色 / 浅色主题、5 种强调色、中英文双语。实时显示电量、当前 DPI 和回报率，插拔自动识别。

</td>
<td width="33%" valign="top">

### 🛡️ 放心使用
首次连接先从鼠标**读取**现有映射，你修改之前不写入任何数据。完全离线，不收集任何信息。

</td>
</tr>
</table>

## 📸 界面预览

<table>
<tr>
<td width="50%"><img src="docs/performance.webp" alt="性能设置" /><p align="center"><sub><b>性能</b> · DPI 档位 / 回报率 / 传感器模式 / LOD</sub></p></td>
<td width="50%"><img src="docs/advanced.webp" alt="高级设置" /><p align="center"><sub><b>高级</b> · 传感器算法 / 消抖 / 休眠 / 接收器灯效</sub></p></td>
</tr>
<tr>
<td width="50%"><img src="docs/macros.webp" alt="宏录制" /><p align="center"><sub><b>宏</b> · 录制键鼠操作，精确编辑延迟</sub></p></td>
<td width="50%"><img src="docs/light.webp" alt="浅色主题" /><p align="center"><sub><b>浅色主题</b> · 也可跟随系统自动切换</sub></p></td>
</tr>
</table>

## 🧩 功能一览

| | 功能 |
|:---:|---|
| 🖱️ **按键** | 6 个按键自定义：鼠标功能、DPI 循环 / ±、配置切换（新固件）、禁用、16 种多媒体键、任意键盘键、组合键（Ctrl / Shift / Alt / Win）、火力键（间隔 + 连发次数）、宏<br />左右键一键互换，并保护"至少保留一个左键" |
| ⚡ **性能** | 1–6 档 DPI，步进 50，X / Y 轴可分离（PAW3395 最高 32000，PAW3950 最高 45000；另两种新传感器 200–16000 / 50–12000，不能分开设 X / Y；范围与官方一致）<br />回报率 125 – 8000 Hz（2000 Hz 以上需要 8K 接收器）· 传感器模式（节能 / 标准 / 电竞，PAW3950 新固件另有「最高性能」：帧率约 12000 → 20000 fps）· LOD 静默高度 |
| 🔧 **高级** | Motion Sync · 直线修正 · 波纹修正 · 按键消抖 0–30 ms · 休眠时间 · 8K 接收器灯效 · 恢复出厂设置 |
| ⏺️ **宏** | 录制键盘与鼠标按键及间隔，手动修改按键 / 按下抬起 / 延迟，三种循环方式，最多 71 个动作 |
| 💾 **配置** | 4 套板载配置存在鼠标里，点击即切换，鼠标上的「配置切换」键切换时界面跟随（新固件，如 1.4.0.3；更早的固件为电脑端配置，连接时自动判断）；兼容官方 `.ict` 配置文件与 `.icm` 宏文件的导入导出 |
| 🔌 **设备** | 自动识别与热插拔，电量（显示实际百分比）与充电状态；DPI、回报率、消抖、LOD、Motion Sync 在鼠标上改了也会实时同步 |

**支持型号**：G23 · G24 · G23V2 · 零29 · 零39 · Ghero · G39（与官方网页驱动和新版桌面驱动相同）

## 📦 下载安装

前往 **[Releases 页面](https://github.com/oexi/incott-driver-desktop/releases/latest)** 下载对应文件：

| 系统 | x64（Intel / AMD） | arm64 |
|---|---|---|
| <img src="https://img.shields.io/badge/-Windows-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | `win-x64-setup.exe` 安装版<br />`win-x64-portable.exe` 免安装版 | `win-arm64-setup.exe`<br />`win-arm64-portable.exe` |
| <img src="https://img.shields.io/badge/-macOS-111111?style=flat-square&logo=apple&logoColor=white" /> | `mac-x64.dmg` | `mac-arm64.dmg`（M 系列芯片） |
| <img src="https://img.shields.io/badge/-Linux-FCC624?style=flat-square&logo=linux&logoColor=black" /> | `.AppImage` · `.deb` · `.rpm` · `.pacman` · `.tar.gz` | 同上（文件名含 `arm64` / `aarch64`） |

<details>
<summary><b>🍎 macOS：提示"已损坏"或"无法验证开发者"</b></summary>

<br />

应用没有 Apple 开发者证书（仅 ad-hoc 签名），把应用拖进"应用程序"后，在终端执行一次：

```bash
xattr -cr "/Applications/Incott Driver.app"
```

</details>

<details>
<summary><b>🐧 Linux：设备权限（udev 规则）</b></summary>

<br />

普通用户访问 `/dev/hidraw*` 需要 udev 规则：

- **deb / rpm / pacman**：安装时自动放入 `/usr/lib/udev/rules.d/70-incott-mouse.rules`
- **AppImage / tar.gz**：首次运行若权限不足，界面会出现「一键安装 udev 规则」按钮（通过 `pkexec` 授权）

安装后重新插拔接收器即可。也可以手动安装：

```bash
sudo cp build/linux/70-incott-mouse.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

</details>

## ❓ 常见问题

<details>
<summary><b>第一次打开，会改掉鼠标里原来的设置吗？</b></summary>

<br />

不会。首次使用时，软件先从鼠标读取现有的设置（按键、DPI、回报率、消抖等）：新固件每个板载配置在第一次切到它时从鼠标读出；更早的固件 4 个配置都从当前设置开始。**在你修改设置之前，软件不会向鼠标写入任何数据。**

想沿用网页驱动里保存的配置：在网页驱动里导出 `.ict` 文件，再点本软件右上角的「导入」按钮。

</details>

<details>
<summary><b>配置是怎么工作的？</b></summary>

<br />

连接时软件会问鼠标支不支持由软件切换板载配置，按结果用下面两种方式之一。

**板载配置（新固件，例如升级包 1.4.0.3 里的；与官方新版桌面驱动 incott-app 1.4.0.3 相同）**：配置 1–4 就是鼠标里的 4 个板载配置，每个都存着一整套设置（回报率、DPI、传感器、消抖、休眠、按键与宏）。页头显示「板载配置」。

- **连接后立即显示鼠标当前所在的配置**，不用等鼠标动起来。
- **点击配置 1–4**：鼠标自己切过去，不用重写设置；软件记着每个配置里是什么，在别的配置里改过的项（例如改了宏）切过去时补写。
- **「配置切换」按键**：可以设在中键、侧键或 DPI 键上（和官方一样不能设在左 / 右键）。这个键由鼠标统一保存，设上或换掉时 4 个配置一起改。按它切换时界面跟着切，关掉软件也照样能用。
- 在软件外改过的项（鼠标上的 DPI 键、别的驱动）切过去或连接时读进配置；写入中途断开的话，下次把配置补写进去。

**电脑端配置（更早的固件，软件无法切换板载配置）**：与官方旧版桌面驱动（GamingMouse.exe）相同，4 套配置保存在电脑上，点击即切换并把它写进鼠标，关掉软件后鼠标一直按最后写入的配置工作。

- **切换很快**：软件记着鼠标里现在的设置，只写不一样的项，一般零点几秒。
- **连接时**先读出鼠标里的设置；在软件外改过的项会读进当前配置。上次写入中途断开的话，会把当前配置补写完。
- 这类固件不支持「配置切换」按键，有按键设成了它的话会恢复成该键的默认功能。

想把某个配置的设置搬到当前配置：打开顶部的「配置一览」，点那一列的「复制到当前」。

</details>

<details>
<summary><b>提示「设备被占用」或连接不上？</b></summary>

<br />

同一时间只能有一个程序控制鼠标。请先关闭浏览器里的官方网页驱动，再重新插拔接收器后重试。

</details>

<details>
<summary><b>遇到问题怎么反馈？</b></summary>

<br />

打开右上角「设置 → 问题反馈」，点「复制」或「保存」（连接失败或找不到设备时，欢迎页上也有「复制诊断信息」按钮），然后[新建 Issue](https://github.com/oexi/incott-driver-desktop/issues/new/choose)，按模板填写并附上诊断信息。内容太长贴不进去时，用「保存」导出 .txt 文件，直接拖进 Issue。

诊断信息开头是「自动判断」，例如"接收器报告鼠标不在线""连接后一直没有状态包""写入失败在哪一步"，可以先自己对照排查。后面是给开发者的原始数据：软件 / 系统版本，型号码、PID 与连接时的原始回包，状态包数量和最近几包，各条读命令的原始回包与解码，鼠标实际设置与本地配置的对照，HID 错误与超时，软件事件与错误日志（包括上一次运行的），HID 设备结构，板载配置，宏的结构摘要，以及上次连接失败的现场。

- 读取过程只发送只读命令，不会改动鼠标里的设置；鼠标正在写入或连接卡住时，连读命令也不发，只导出已有记录。
- 不含用户名、文件路径等个人信息；宏只包含动作数量、循环方式和绑定的按键，不含录制的按键内容；其它厂商的 HID 设备只列出 VID / PID，不列名称。
- 桌面版会把软件事件和错误写入本机日志文件，只保存在本机、不会上传：Windows `%APPDATA%\Incott Driver\logs`，macOS `~/Library/Application Support/Incott Driver/logs`，Linux `~/.config/Incott Driver/logs`。

如果官方驱动能做到、本软件做不到（例如某个按键改不了），请参考[抓包指南](docs/usb-capture.md)录一段官方驱动的 USB 通信。

</details>

## 🛠️ 开发

需要 Node.js 20+。

```bash
npm install
npm run dev          # 开发模式（Vite 热更新 + Electron）
npm test             # 协议差分测试
npm run web          # 浏览器预览界面，打开 http://localhost:5178/?mock 使用模拟设备
```

<details>
<summary><b>打包</b></summary>

<br />

```bash
npm run dist:linux   # Linux x64 + arm64
npm run dist:win     # Windows x64 + arm64
npm run dist:mac     # macOS x64 + arm64（需在 macOS 上执行）
```

</details>

<details>
<summary><b>发布新版本</b></summary>

<br />

推送 `v*` 标签即可触发 GitHub Actions：测试 → 6 个平台 / 架构并行打包 → 自动创建 Release，并附上全部安装包和 `SHA256SUMS.txt`。

```bash
npm version patch && git push --follow-tags
```

</details>

<details>
<summary><b>项目结构</b></summary>

<br />

```
electron/            主进程：窗口、WebHID 授权与设备选择、托盘、文件对话框、Linux udev
src/protocol/        协议层（移植自原版 CBAccess / StProfile / STMacro）
  device.js          HID 收发、读取设备信息、apply() 写入流程
  profile.js         板载配置（.ict 文本格式）
  macro.js           宏（.icm 文本格式、320 字节硬件缓冲区）
  constants.js       功能码、DPI 表、回报率等常量
src/store.js         业务逻辑（配置切换、按键校验、写入队列…）
src/pages/           按键 / 性能 / 高级 / 宏 页面
tests/               差分测试：沙箱运行原版代码，与移植版逐字节比对 HID 报文
  original/          官方网页驱动的原始 JS（仅作测试基准，不打包进应用）
```

</details>

<details>
<summary><b>协议说明</b></summary>

<br />

所有命令都是 Report ID 9 的 8 字节 Feature Report。读取时先发送命令，等待 25 ms 后调用 `receiveFeatureReport`，回包第 1 字节是命令回显。宏数据先发 Feature 头 `[7, 10, i, 32, 按键号]`，再通过 Output Report 分 10 包、每包 32 字节下发。

| 写入 | 含义 | 读取 | 含义 |
|---|---|---|---|
| `1` | 回报率 | `143` | 型号 / 接收器 / 传感器 |
| `2` | DPI 档位数值（X / Y） | `142` | 配对状态 |
| `3` | DPI 档位数与当前档 | `137` | 设备信息 |
| `4, 1…5` | LOD / 波纹 / 直线 / Motion Sync / 传感器模式 | `131` | 档位数与当前档 |
| `5, 1…3` | 消抖 / 火力键参数 / 休眠 | `134` | 按键映射（`134, 9` 是网页驱动记的板载配置编号） |
| `5, 6, N` | 切到板载配置 N（新固件） | `133, 1…3` | 消抖 / 火力键参数 / 休眠时间 |
| `6` | 按键映射（`6, 9` 只记一个编号、不切换，本软件不发；`61706` 配置切换键写进全部板载配置） | `133, 6` | 当前板载配置（有线回包 `r[1]`，经接收器 `r[2]`） |
| `7` | 宏数据头 | | |
| `8` | 接收器灯效 | | |

</details>

## 📄 许可证

本项目自有代码以 **[MIT 协议](LICENSE)** 开源。以下第三方内容**不适用** MIT 协议，版权归各自所有者（详见 [NOTICE](NOTICE)）：

| 路径 | 内容 | 版权 / 协议 |
|---|---|---|
| `tests/original/` | 官方网页驱动原始 JS（测试基准） | © INCOTT（因科特） |
| `public/mice/` · `public/products/` | 鼠标产品图 | © INCOTT（因科特） |
| `src/assets/fonts/` | HarmonyOS Sans 字体 | © 华为，HarmonyOS Sans Fonts License |

> [!NOTE]
> 本项目是非官方第三方工具，与 INCOTT（因科特）无关联。使用本软件修改鼠标设置的风险由使用者自行承担。

<div align="center">
<sub>如果这个项目对你有帮助，欢迎点个 ⭐</sub>
</div>
