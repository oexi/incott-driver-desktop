# INCOTT Driver · 桌面版

INCOTT 鼠标的跨平台桌面驱动，基于官方 WebHID 网页驱动（[oexi/incott-driver-offline](https://github.com/oexi/incott-driver-offline)）移植。支持 **Windows / macOS / Linux**，**x64 与 arm64** 双架构。

- 通信协议从原版逐条移植，自动化测试会直接运行原版代码做**逐字节对比**，保证写入鼠标的数据与网页驱动完全一致
- 全新界面：深色 / 浅色主题、5 种强调色、中英文
- 设置直接写入鼠标板载内存，软件关闭后依然生效；不联网
- 内置原版网页界面（"经典界面"），随时可以切回

![按键设置](docs/buttons.webp)

| 性能设置 | 高级设置 |
|---|---|
| ![性能](docs/performance.webp) | ![高级](docs/advanced.webp) |
| **宏录制** | **浅色主题** |
| ![宏](docs/macros.webp) | ![浅色](docs/light.webp) |

## 功能

| 模块 | 内容 |
|---|---|
| 按键 | 6 个按键自定义：鼠标功能、DPI 循环 / ± 、配置切换、禁用、16 种多媒体键、任意键盘键、组合键（Ctrl / Shift / Alt / Win）、火力键（间隔 + 连发次数）、宏；左右键互换；"至少保留一个左键"保护 |
| 性能 | 1–6 档 DPI（3395：50 – 32000，3950：50 – 45000，步进 50，X/Y 可分离；范围与原版一致）、回报率 125 – 8000Hz（2K 以上需 8K 接收器）、传感器模式（节能 / 标准 / 电竞）、LOD |
| 高级 | Motion Sync、直线修正、波纹修正、按键消抖 0 – 30ms、休眠时间、8K 接收器灯效、恢复出厂设置 |
| 宏 | 录制键盘与鼠标按键（含间隔）、手动编辑按键 / 按下抬起 / 延迟、三种循环方式，最多 71 个动作 |
| 配置 | 4 个板载配置，可导入 / 导出原版 `.ict` 配置文件（`.icm` 宏文件同样兼容） |
| 设备 | 自动识别与热插拔、电量 / 充电状态、当前 DPI 与回报率实时同步 |

支持型号：G23 / G24 / G23V2 / 零29 / 零39 / Ghero / FM23（与官方网页驱动相同），PAW3395 / PAW3950 传感器。

## 下载安装

到 [Releases](https://github.com/oexi/incott-driver-desktop/releases) 下载对应平台的安装包：

| 系统 | 文件 |
|---|---|
| Windows | `*-win-x64-setup.exe` / `*-win-arm64-setup.exe`（安装版），`*-portable.exe`（便携版） |
| macOS | `*-mac-arm64.dmg`（Apple Silicon）/ `*-mac-x64.dmg`（Intel） |
| Linux | `.AppImage`、`.deb`、`.rpm`、`.pacman`、`.tar.gz`（x64 与 arm64） |

### macOS 首次打开

应用没有 Apple 开发者签名（仅 ad-hoc 签名）。若提示"已损坏"或"无法验证开发者"，执行：

```bash
xattr -cr "/Applications/Incott Driver.app"
```

### Linux 设备权限

普通用户访问 `/dev/hidraw*` 需要 udev 规则：

- `deb` / `rpm` / `pacman` 包会自动安装 `/usr/lib/udev/rules.d/70-incott-mouse.rules`
- AppImage / tar.gz：首次运行如果检测到权限不足，界面上会出现"一键安装 udev 规则"按钮（通过 `pkexec` 获取管理员权限）

安装规则后重新插拔接收器即可。手动安装：

```bash
sudo cp build/linux/70-incott-mouse.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules && sudo udevadm trigger
```

## 使用提示

- **首次使用**：软件会从鼠标读取当前按键映射和 DPI 档位数；DPI 具体数值、消抖等参数鼠标无法读回，会先显示默认值，**在你修改之前不会写入鼠标**。想完整沿用网页驱动里的设置，可以在网页驱动中导出 `.ict` 再在这里导入。
- **板载配置**：与原版逻辑一致——切换配置时会把该配置的全部设置写入鼠标；按鼠标上的"配置切换"键时，软件需要在运行中才能同步（可在设置里开启"关闭时最小化到托盘"）。
- **同时只能有一个程序控制鼠标**：使用本软件时请关闭浏览器里的网页驱动。

## 从源码构建

需要 Node.js 20+。

```bash
npm install
npm run dev          # 开发模式（Vite 热更新 + Electron）
npm test             # 协议差分测试
npm run dist:linux   # 打包 Linux x64 + arm64
npm run dist:win     # 打包 Windows x64 + arm64
npm run dist:mac     # 打包 macOS x64 + arm64（需在 macOS 上执行）
```

浏览器里预览界面（不需要鼠标）：`npm run web`，然后打开 `http://localhost:5178/?mock`。

## 发布新版本

推送 `v*` 标签即可触发 GitHub Actions：测试 → 6 个平台 / 架构并行打包 → 自动创建 Release 并上传全部安装包与 `SHA256SUMS.txt`。

```bash
npm version patch    # 或手动修改 package.json 的 version
git push --follow-tags
```

## 项目结构

```
electron/            主进程：窗口、WebHID 授权与设备选择、托盘、文件对话框、Linux udev
src/protocol/        协议层（移植自原版 CBAccess / StProfile / STMacro）
  device.js          HID 收发、读设备信息、apply() 写入流程
  profile.js         板载配置（.ict 文本格式）
  macro.js           宏（.icm 文本格式、320 字节硬件缓冲区）
  constants.js       功能码、DPI 表、回报率等常量
src/store.js         业务逻辑（对应原版界面逻辑：配置切换、按键校验、写入队列…）
src/pages/           按键 / 性能 / 高级 / 宏 页面
classic/             原版网页驱动（经典界面，同时作为差分测试的基准）
tests/               差分测试：沙箱运行原版代码，与移植版逐字节比对 HID 报文
```

## 协议说明

所有命令均为 Report ID 9 的 8 字节 Feature Report；读取时先发送命令，等待 25ms 后 `receiveFeatureReport`，回包第 1 字节为命令回显。宏数据先发 Feature 头 `[7, 10, i, 32, 按键号]`，再通过 Output Report 分 10 包、每包 32 字节下发。

| 命令 | 含义 | | 命令 | 含义 |
|---|---|---|---|---|
| `1` | 回报率 | | `143` | 读型号 / 接收器 / 传感器 |
| `2` | DPI 档位数值（X / Y） | | `142` | 读配对状态 |
| `3` | DPI 档位数与当前档 | | `137` | 读设备信息 |
| `4,1..5` | LOD / 波纹 / 直线 / Motion Sync / 传感器模式 | | `131` | 读档位数与当前档 |
| `5,1..3` | 消抖 / 火力键参数 / 休眠 | | `134` | 读按键映射（`134,9` 为当前板载配置） |
| `6` | 按键映射（`6,9` 切换板载配置） | | `133` | 读无线信号 |
| `7` | 宏数据头 | | | |
| `8` | 接收器灯效 | | | |

## 声明

本项目为非官方第三方工具，与 INCOTT（因科特）无关联。`classic/` 目录为官方网页驱动的离线镜像，版权归原作者所有。使用本软件修改鼠标设置的风险由使用者自行承担。
