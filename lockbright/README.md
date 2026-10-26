# LockBright

锁屏后如果房间关灯了，就把屏幕调到最暗；每天早上固定时间再把亮度拉满。
**一套 Python 代码同时支持 Windows 和 macOS**，平台差异封装在 `lb/platform_*.py` 里。

> 名字直译：Lock（锁屏）+ Bright（亮度）。

---

## 它到底做什么

```
每 60 秒醒一次（可配）
  ├─ 早上到点了吗？        → 亮度拉到 morning_brightness（默认 100%），每天一次，睡醒/开机后补做（补做时若还在夜间时段则顺延到次日）
  ├─ 在夜间时段吗？         → 默认 20:00 到次日 07:30
  ├─ 电脑锁屏了吗？         → 未锁屏什么都不做（也不开摄像头）；Windows 上「远程登录(RDP)」也算锁屏
  ├─ 需要判断吗？           → 只有“锁屏+夜间”或“已经调暗、要检查是否开灯”时才开摄像头
  └─ 测环境亮度：
       连续 2 次都 < dark_luma_threshold（默认 20）
         → 屏幕调到 dim_brightness（默认 0%），记住调暗前的亮度
       已调暗后，亮度 > restore_luma_threshold（默认 40，开灯了）
         → 恢复到调暗前的亮度
```

- 白天锁屏不会调暗（有夜间时段兜底，避免开会/午休时把屏幕搞黑）。
- 锁屏状态检测失败、摄像头打不开、亮度写不进去：只记日志，**绝不乱改亮度**、不会退出。
- 解锁时默认恢复亮度；早上到点无论锁没锁屏都会拉满（这是明确需求）。
- **远程登录也算“锁屏”（Windows/RDP）**：当工具跑在 RDP 远程会话里时，物理电脑显示的是
  console/锁屏界面，所以默认按“已锁屏”处理：同样会测光、夜间关灯就调暗物理屏幕。
  不想要这个行为就把 `treat_remote_as_locked` 设为 `false`。
  macOS 的屏幕共享/远程登录暂未识别，仍按实际锁屏状态判断。
- 状态持久化在 `~/.lockbright/state.json`，重启、睡眠唤醒后继续，早上会补触发（夜间窗口内不补，避免半夜闪屏）。

## 平台支持情况（重要，请先看）

| | Windows | macOS |
| --- | --- | --- |
| 状态 | ✅ 已在本机实测（亮度、摄像头、决策、安装） | ⚠️ 已实现、**未在真机 Mac 上运行过**，待验证 |
| 锁屏检测 | `OpenInputDesktop` 桌面名（未锁=`Default`，锁屏=`Winlogon`）+ LogonUI 兜底 | `ioreg -n Root -d1 -a` 解析 `IOConsoleUsers[*].CGSSessionScreenIsLocked` |
| 亮度控制 | WMI `WmiMonitorBrightnessMethods`（只支持笔记本内置屏） | ctypes 多级回退：IOKit → DisplayServices 私有 API → CoreDisplay SPI → `brightness` CLI |
| 摄像头 | OpenCV DirectShow，测光时锁手动短曝光（已实测） | OpenCV AVFoundation **不支持**手动曝光属性 → 自动回退 auto，阈值必须用 `probe` 现场校准 |
| 开机自启 | 计划任务（pythonw 隐藏窗口） | LaunchAgent |
| 相机权限 | 桌面应用直接可用（隐私设置允许即可） | TCC 权限，**按“负责进程”记账**，LaunchAgent 下可能被静默拒绝，见下 |

**亮度控制只对笔记本内置屏有效**：WMI / IOKit 都不控制外接显示器。台式机 + 外接屏
需要 DDC/CI 方案，不在本项目范围内。合盖外接屏的用法也不支持。

### 文档

- [docs/MACOS-NOTES.md](docs/MACOS-NOTES.md)：macOS 调研与实现说明（亮度 API 选择依据、
  ioreg 锁屏检测、**TCC 相机权限**、未实测风险清单、上 Mac 后最先验证的 3 件事）。
- [docs/WINDOWS-NOTES.md](docs/WINDOWS-NOTES.md)：Windows 实测笔记（摄像头序号、
  锁屏检测、安装/卸载、踩坑）。
- [docs/SPEC.md](docs/SPEC.md)：内部规格/接口/验收清单（改代码前先看）。

### macOS 必读：摄像头权限（TCC）

macOS 的摄像头权限记在“负责弹权限框的进程”名下。从 LaunchAgent 直接启动的 python
没有 App Bundle，可能**不弹框、直接被拒**。推荐流程：

1. 先在 Terminal 前台跑一次 `python3 run.py probe`，允许“Terminal 想要访问摄像头”，
   确认能读到亮度值（会亮一下摄像头指示灯）；
2. 再运行 `bash scripts/install_macos.sh`，让 LaunchAgent 启动；
3. 如果 LaunchAgent 下相机打不开（日志里会反复出现“摄像头测光失败”），最稳的办法是
   晚上直接用 Terminal 前台跑 `python3 run.py run`（见 `docs/MACOS-NOTES.md` 的替代方案）。

## 快速开始（Windows）

已验证环境：Windows 11（Dell Inspiron 5493）、Python 3.14、OpenCV 4.13。

```powershell
cd lockbright

# 1) 依赖（OpenCV 测光用；numpy 会随 opencv-python 一起装）
python -m pip install -r requirements.txt

# 2) 探测：平台/亮度/锁屏状态 + 每颗摄像头的测光值（会短暂亮摄像头灯）
python run.py probe

# 2b) 多摄像头：列出名称/测光，实时预览并选中要用的那颗
python run.py cameras
python run.py preview --index 1          # 实时画面：0-9 切换、s 截图、q 退出
python run.py preview --index 1 --set    # 窗口里按 Enter 选中，写入 ~/.lockbright/config.json

# 3) 开机自启（复制到 %LOCALAPPDATA%\LockBright\app + 注册计划任务 LockBright 并立即启动）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1

# 4) 看日志 / 状态
python run.py status
Get-Content "$env:USERPROFILE\.lockbright\lockbright.log" -Tail 30

# 卸载（保留配置和日志；加 -Purge 连数据一起删）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1
```

也可以不安装、直接前台运行：`python run.py run`（Ctrl+C 退出）。

### 自启与故障排查（Windows）

安装脚本会注册**两个**计划任务：

- `LockBright`：用户登录后自动启动守护进程（相机/亮度必须在登录会话里，所以**开机停在登录界面时
  不会跑**，必须有人登录；这是 Windows 系统限制，不是 bug）；
- `LockBrightWatchdog`：每 2 分钟检查一次，发现守护进程没了就自动把它拉起来（`pythonw` 隐藏运行，
  不弹窗；只在用户登录后运行）。

`LockBright` 任务设置：

- 触发器：AtLogOn（当前用户）；
- 执行时不弹窗（`pythonw`），电池供电也运行、不因切换电池停止；
- **MultipleInstances = StopExisting**：每次登录/切换会话时，先杀掉旧会话里残留的实例再启动新的
  （以前用 IgnoreNew，RDP 断开后留在旧会话的进程会挡住新登录的实例，表现就是“看着像没自启”）；
- **RestartOnFailure**：任务失败时 1 分钟内重试，最多 3 次（外部强杀不一定触发，所以还有看门狗兜底）；
- 无执行时限（PT0S）。

检查是否在跑：

```powershell
Get-ScheduledTask -TaskName LockBright,LockBrightWatchdog | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName LockBright | Select-Object LastRunTime,LastTaskResult
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'LockBright' } |
  Select-Object ProcessId,SessionId,CreationDate,CommandLine
Get-Content "$env:USERPROFILE\.lockbright\lockbright.log" -Tail 20 -Encoding UTF8
Get-Content "$env:USERPROFILE\.lockbright\watchdog.log" -Tail 5 -Encoding UTF8   # 看门狗重启记录
```

如果任务不在跑：先重跑一次 `scripts\install_windows.ps1`（会重建两个任务并启动）；
自启没触发时可看 `事件查看器 → 应用程序和服务日志 → Microsoft → Windows → TaskScheduler → Operational`，
或直接把任务历史/日志发我。

### 校准阈值（推荐做一次）

默认 `camera_exposure = -4`（这台摄像头能接受的最长手动曝光；再短会太暗）配合
`dark_luma_threshold = 20`：实测开灯读数≈58、关灯≈9~11。不同房间/摄像头差异很大，装好后建议：

1. 开着灯跑一次 `python run.py probe`，看 **“手动”** 那一列的读数，记为 `亮值`；
2. 关灯再跑一次 `python run.py probe`，记为 `暗值`；
3. 把 `dark_luma_threshold` 设成两者之间（尽量靠近暗值，比如 `暗值 + (亮值-暗值)*0.25`），
   `restore_luma_threshold` 设成明显高于 `dark_luma_threshold` 的值（默认 40）。
   如果“手动”列开灯时也很低（<40），说明曝光太短：把 `camera_exposure` 往 `-3`/`-2` 调
   （部分驱动会钳到最长值，`probe` 的“手动”读数会直接反映出来）。

> 自动曝光的读数不要拿来定阈值：同一黑暗房间，自动曝光会把画面拉到 70~85。
> 所以本工具在 Windows 上测光时**强制手动短曝光**，测完恢复自动曝光（不影响你之后用微信/Teams 开摄像头）。
>
> **macOS 注意**：OpenCV 4.x 的 AVFoundation 后端**没有实现**曝光属性（源码可证），
> 无法锁定手动曝光，会回退自动曝光。因此 Mac 上必须用 `probe` 的 **“自动”** 列做上面
> 的亮/暗两次校准；如果两次读数差距太小（自动曝光把黑房间也拉得很亮），调暗判断会不可靠，
> 此时可以改 `camera_index` 换一颗视野里没有屏幕/光源的摄像头再试。详见 `docs/MACOS-NOTES.md`。

## 多摄像头：列出 / 预览 / 选择

电脑上有多个摄像头（笔记本内置、USB、虚拟摄像头、RDP 重定向的都算）时，按三步选：

```powershell
# 1) 列出所有摄像头：名称、分辨率、自动/手动测光值、截图、推荐 index
python run.py cameras

# 2) 实时预览某颗摄像头（会弹一个窗口）
python run.py preview --index 1
#   窗口快捷键：q/Esc 退出，s 保存截图，0-9 直接切换摄像头

# 3) 选中并写入配置：窗口里切到想要的那颗，按 Enter（必须带 --set）
python run.py preview --index 1 --set
#   然后重启后台服务生效
Stop-ScheduledTask -TaskName LockBright; Start-ScheduledTask -TaskName LockBright
```

- Windows 下名称来自 DirectShow 枚举顺序，**和 OpenCV index 一一对应**（本机实测：
  `0 = Integrated Webcam`、`1 = Integrated Camera`；RDP 重定向/ToDesk 虚拟摄像头也会占 index）。
- macOS 下 OpenCV 不提供设备名，`cameras` 会显示"未命名"；用 `preview` 看画面确认 index 即可。
- 也可以直接改配置：`camera_index` 指定序号；或者 `camera_name` 填设备名片段（如
  `"Integrated Camera"`，大小写不敏感，启动时解析成 index，**设备插拔导致序号变化时更稳**）。
- 测光（守护进程）用的是当前选中的那颗；`cameras`/`preview` 只是帮你看清楚它们分别拍什么。
- 预览窗口用的是自动曝光（方便看清画面），实际测光会临时锁手动短曝光，两者亮度读数不同，正常。

## 快速开始（macOS）

前置：Python ≥ 3.9 + OpenCV（没有的话 LaunchAgent 起不来）。

```bash
cd /path/to/lockbright
python3 -m pip install -r requirements.txt

# 先在前台做一次探测并完成 TCC 摄像头授权（关键！）
python3 run.py probe

# 安装 LaunchAgent（会复制到 ~/Library/Application Support/LockBright/app）
bash scripts/install_macos.sh

# 查看日志/状态
tail -f ~/.lockbright/lockbright.log
python3 "$HOME/Library/Application Support/LockBright/app/run.py" status

# 卸载（保留 ~/.lockbright）
bash scripts/uninstall_macos.sh
```

Homebrew Python 遇到 `externally-managed-environment` 时用 venv（安装脚本会打印具体命令），
装好后用 `PYTHON_BIN=.../venv/bin/python3 bash scripts/install_macos.sh` 指定解释器。
**注意**：以后升级/移动 Python 会让相机授权失效，需要重新授权并重跑安装脚本。

## 配置

首次运行自动生成 `~/.lockbright/config.json`（Windows: `%USERPROFILE%\.lockbright\config.json`）。
`LOCKBRIGHT_HOME` 环境变量可整体改数据目录（测试/多套配置用）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `check_interval_seconds` | `60` | 轮询间隔（秒） |
| `night_start` | `"20:00"` | 夜间开始时间，可跨零点 |
| `morning_time` | `"07:30"` | 早上拉满时间，同时是夜间结束时间 |
| `morning_brightness` | `100` | 早上目标亮度（%） |
| `dim_brightness` | `0` | 调暗目标亮度（%） |
| `fallback_restore_brightness` | `80` | 没记录到原亮度时的恢复值 |
| `dark_luma_threshold` | `20.0` | 手动曝光下，平均亮度低于它算“黑” |
| `restore_luma_threshold` | `40.0` | 已调暗时，高于它算“开灯了” |
| `dark_confirm_samples` | `2` | 连续几次确认黑才调暗（防手挡镜头误判） |
| `restore_on_unlock` | `true` | 解锁时恢复亮度 |
| `treat_remote_as_locked` | `true` | 把 RDP 远程登录也当作“锁屏”（Windows；macOS 暂不识别） |
| `camera_index` | `0` | OpenCV 摄像头序号（`probe` 会给出建议，截图能确认拍到的是房间） |
| `camera_name` | `null` | 可填设备名片段（如 `"Integrated Camera"`，Windows）；启动时解析成 index，优先级高于 `camera_index` |
| `camera_samples` | `5` | 每次测光取样帧数（取最亮帧） |
| `camera_warmup_frames` | `3` | 丢弃预热帧数 |
| `camera_backend` | `"auto"` | Windows 默认 `dshow`，macOS 默认 `avfoundation` |
| `camera_manual_exposure` | `true` | 测光时锁手动短曝光、测完恢复自动 |
| `camera_exposure` | `-4.0` | 手动曝光值（对数秒，-4≈1/16s；这是本机摄像头可用的最长值；驱动不支持会自动回退） |
| `log_level` | `"INFO"` | `DEBUG`/`INFO`/`WARNING`/`ERROR` |
| `log_max_bytes` / `log_backup_count` | `1048576` / `3` | 日志轮转 |

## 命令行

| 命令 | 作用 |
| --- | --- |
| `python run.py run` | 前台守护循环（自启任务/LaunchAgent 跑的就是它） |
| `python run.py run --once` | 只做一次观察+决策，打印结果 |
| `python run.py probe` | 环境探测：平台、亮度、锁屏、每颗摄像头的自动/手动测光与截图 |
| `python run.py cameras` | 列出所有摄像头：名称、分辨率、测光值、截图；给出推荐 index |
| `python run.py preview --index N` | 实时预览某颗摄像头；窗口里 0-9 切换、s 截图、q 退出；`--set` 时按 Enter 选中并写入配置 |
| `python run.py status` | 配置、运行状态、当前亮度、当前是否锁屏/夜间 |
| `python run.py set-brightness 30` | 手动设亮度（测试用） |
| `python run.py simulate --locked --luma 3 --at 23:00` | 用给定条件跑决策（默认 dry-run，不改亮度） |
| `python run.py simulate ... --apply` | 真执行（会改亮度并保存状态） |
| `python run.py init` | 只生成默认配置 |

无锁屏环境下想验证整条链路，可以用诊断参数（**会真改亮度**，测完记得恢复）：

```powershell
$env:LOCKBRIGHT_HOME="$env:TEMP\lockbright-test"   # 用临时配置，不污染真实状态
python run.py run --once --force-locked             # 第一次：累计“黑”次数
python run.py run --once --force-locked             # 第二次：真调暗到 0%
python run.py run --once --force-unlocked           # 恢复亮度
python run.py set-brightness 100                    # 收尾
```

## 文件与隐私

- 数据目录：`~/.lockbright/`（配置 `config.json`、状态 `state.json`、日志
  `lockbright.log`、`probe/` 里的探测截图）。
- 守护进程**不保存任何摄像头画面**；只有你手动跑 `probe` / `cameras` / `preview` 才会把测光帧存成 jpg 方便确认画面。
- 摄像头只在“锁屏 + 夜间”或“已调暗需要检查是否开灯”时打开，每次约 2~4 秒，指示灯会亮一下。
- 不联网、不传数据。跨平台安装脚本只在各系统自己的机制里注册自启。

## 常见问题

- **probe 显示摄像头全失败**：被 Teams/微信等占用、Windows 隐私设置关闭了相机、
  或者用了带物理遮挡的摄像头。关掉占用程序再试。
- **probe 里建议的 index 不对**：打开 `~/.lockbright/probe/camera-*.jpg` 看画面，
  选一只能拍到房间的，把 `camera_index` 改成它。
- **白天屏幕也被调暗 / 早上没拉满**：确认 `night_start`、`morning_time` 配置正确；
  电脑睡眠时守护进程不运行，唤醒后会补做早上的动作（如果补做时还在夜间时段，
  会顺延到次日 07:30；整晚关机则当天不补）。
- **亮度设置后又自己变回去**：系统/厂商的自动亮度在覆盖，关掉“自动调节亮度”。
- **外接显示器调不了亮度**：WMI/IOKit 只控制笔记本内置屏，属预期行为。
- **锁屏检测一直是 unknown**：Windows 看日志里的桌面名/错误码；macOS 看 `ioreg` 解析错误信息
  （贴日志给维护者）。RDP/远程会话下的锁屏检测行为可能与物理机不同。
- **RDP / 远程会话注意**：工具只在“当前登录会话是活动会话”时才动亮度。远程安装后建议
  注销 RDP（或到物理机 console 重新登录一次再 Stop/Start 任务），否则任务进程留在已断开的
  RDP 会话里：虽然不会再误调物理亮度（会话非活动时自动跳过动作），但也就不会正常工作。
  同理，RDP 断开期间早上的动作也会跳过；重连后如果还在夜间时段，会顺延到次日早上再拉满。
- **摄像头灯经常闪**：把 `check_interval_seconds` 调大（比如 120~180 秒），
  或把 `camera_manual_exposure` 保持开启（测光窗口很短）。

## 开发与测试

```powershell
python -m unittest discover -s tests -v    # 53 个决策/配置/daemon/摄像头名称解析单元测试，无需摄像头
```

目录：

```
run.py                  CLI 入口
lb/platform_base.py     平台接口
lb/platform_windows.py  Windows 锁屏检测 + WMI 亮度
lb/platform_mac.py      macOS 锁屏检测 + IOKit/DisplayServices 亮度
lb/camera.py            OpenCV 测光（手动短曝光 + 恢复自动）
lb/decide.py            纯决策（无 I/O，全部可单测）
lb/daemon.py            主循环、动作落地、状态持久化
lb/config.py            配置解析/校验
lb/paths.py             数据目录
scripts/                各平台安装/卸载脚本
docs/                   验收规格、Windows/macOS 实测笔记
tests/                  单元测试
```

## 已知限制

- macOS 部分**尚未在真机运行**，亮度/锁屏/LaunchAgent 的实测清单见 `docs/MACOS-NOTES.md`；
  第一次在 Mac 上跑请先 `probe` 再装自启，并留意日志。
- macOS 上 OpenCV 不支持手动曝光，只能回退自动曝光，暗/亮读数差距可能较小，
  **必须**按 README 的校准步骤设置阈值；差距太小则判断不可靠（属已知限制）。
- Windows 真锁屏的端到端行为需要你锁屏一次验证（日志里会看到 `locked=True` 和亮度读数）；
  锁屏检测方案本身已在本机验证未锁屏时返回 `Default`。
- 手动曝光依赖摄像头驱动；不支持时自动回退自动曝光，此时阈值必须手工校准。
- 只支持内置屏；屏幕亮度被系统自动亮度覆盖时以系统为准。
- `camera_index` 会随设备插拔/虚拟摄像头出现而变化；想稳定就用 `camera_name` 指定设备名
  （Windows 有效，macOS 无设备名只能靠 index/预览确认）。
