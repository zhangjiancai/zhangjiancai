# Windows 实测笔记（LockBright）

> 注：文中 `reports/...` 是开发时本机的证据文件（截图/JSON），未随仓库上传；相关结论可用仓库代码复现。

> 机器：Dell Inspiron 5493，Windows 11（中文家庭版/专业版环境），**通过 RDP 会话访问**（会话 id=1，客户端为 MacBook Air，客户端启用了摄像头重定向）。
> 工具链：Python 3.14.7（`python`，已装 opencv-python 4.13.0 / numpy 2.4.4）、Windows PowerShell 5.1（`powershell.exe`）、pwsh 7、WMI 亮度可读写。
> 实测时间：2026-10-21 00:2x–00:5x（房间灯全程关闭）。测试期间未锁屏、未强改用户窗口。
>
> **一句话结论**：默认 `camera_index = 0`，`camera_backend = auto`（Windows 上解析为 dshow）；
> 测光必须用手动短曝光（`camera_manual_exposure=true`, `camera_exposure=-6`）；
> 锁屏检测方案可行（未锁屏 = `Default` 已实测，锁屏 = `Winlogon` 待用户真锁屏验证）；
> 安装/卸载脚本已实测可装、可卸、可重装，机器最终处于“已安装且运行中”。

---

## 1. 结论速查

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 默认摄像头序号 | **0**（Integrated Webcam，`VID_0BDA&PID_5520` MI_00） | 手动曝光 -6 读数 8.0；自动 70.0；截图是彩色室内画面 |
| 备选序号 | 1（Integrated Camera，`174F:1811` MI_00） | 手动 0.1，自动 81.6；也是彩色可见光 |
| 摄像头后端 | **DSHOW**（默认 `auto` 在 Windows 即 dshow） | DSHOW 开流 0.8–1.7s；MSMF 开流 13.5–19.3s（极慢） |
| 手动曝光 | **必须**：`CAP_PROP_AUTO_EXPOSURE 0.25`（手动）/ `1.0`（自动），`CAP_PROP_EXPOSURE=-6`（≈1/64s） | 同一黑房间：自动 59–91，手动 0–11 |
| 锁屏检测 | `OpenInputDesktop` + `GetUserObjectInformationW(UOI_NAME)`；未锁屏 = `Default` | 3 次采样 + RDP 连接/断开两种状态 |
| 亮度读写 | WMI 可读可写，读回精确 | `100 → 30 → 100`，status 读回 30/100 |
| 安装 | `%LOCALAPPDATA%\LockBright\app` + 计划任务 `LockBright`（AtLogOn、pythonw 隐藏、电池不限、PT0S 不限时、IgnoreNew） | 已装、已卸、已重装；任务 Running、日志有启动行 |
| 默认暗阈值 | `dark_luma_threshold=20` 在“关灯”场景合理（实测 8.0 / 0.1 / 11.0 < 20） | “开灯”未实测（见 §2.4d），需用户按本文校准 |

---

## 2. 摄像头序号映射（关键结论）

### 2.1 设备清单与 OpenCV 序号

| DSHOW index | 名称（FriendlyName） | 设备 ID / 来源 | 类型 | OpenCV 实测（自动曝光） |
| --- | --- | --- | --- | --- |
| 0 | Integrated Webcam | `USB\VID_0BDA&PID_5520&MI_00`（内置，ACPI `WCAM`） | 彩色 | 彩色室内画面，自动 luma ≈70 |
| 1 | Integrated Camera | `USB\VID_174F&PID_1811&MI_00`（内置，USB 端口 3） | 彩色（WinRT 可出 1920×1080） | 彩色房间画面，自动 luma ≈82 |
| 2 | MacBook Air Camera (redirected) | `RDCAMERA_BUS\...`，RDP 摄像头重定向 | 彩色（拍的是 RDP 客户端方向） | 自动 luma ≈54；**不支持手动曝光** |
| 3 | ToDesk Camera | ToDesk 远程软件的虚拟摄像头 | 虚拟 | 全黑（未推流），自动 luma ≈0.1 |
| 4+ | — | — | — | `isOpened()` 失败 |

- **IR 摄像头**（`Integrated IR Camera`，`174F:1811` MI_02）在 PnP 里存在，但 **WinRT 的 VideoCapture 枚举和 DSHOW 枚举都不列出它**（Windows Hello 保留），OpenCV 无法访问。不要把它当测光摄像头。
- 上表序号是 **ICreateDevEnum 枚举顺序**，也就是 OpenCV `CAP_DSHOW` 的 index 顺序；这一点用“按名字 WinRT 抓图 ↔ 按 index OpenCV 抓图”内容比对验证过（index 0 的墙景 = `Integrated Webcam`，index 1 的房间 = `Integrated Camera`，index 2 的人像 = MacBook Air 重定向）。

### 2.2 映射是怎么确认的（证据链，可复现）

1. **WinRT 枚举**（必须 `powershell.exe` 5.1）：`reports/win/enum_winrt.ps1`
   → 3 个设备，顺序：`Integrated Webcam`、`Integrated Camera`、`MacBook Air Camera (redirected)`；**不含 IR、不含 ToDesk**。
2. **DirectShow COM 枚举**（`ICreateDevEnum`，与 OpenCV DSHOW 同一 API）：`reports/win/enum_dshow_com.ps1`
   → 4 个设备，顺序：`0 Integrated Webcam`、`1 Integrated Camera`、`2 MacBook Air Camera (redirected)`、`3 ToDesk Camera`。
   注意：注册表 `HKLM\SOFTWARE\Classes\CLSID\{860BB310-...}\Instance` 里只有 ToDesk 一个子键（USB 摄像头的 DSHOW 注册不在该子键下），**不能用注册表顺序推断**。
3. **WinRT 按名字抓图**：`reports/win/capture_by_name.ps1 -Name "Integrated Webcam" -Out xxx.jpg`
   与 OpenCV 按 index 抓图（`reports/cam_probe.py`）内容一一对应，确认名字 ↔ index。
4. **MSMF 顺序** = WinRT 顺序（0/1/2）；DSHOW 与 MSMF 的差异是 DSHOW 多了 ToDesk 虚拟摄像头（占 index 3），所以 **两个后端的序号并不完全等价**，不要混用。
5. 辅助脚本 `reports/cam_byname.py` 实测：OpenCV 4.13 的 DSHOW/MSMF **不支持** `cv2.VideoCapture("video=<设备名>")` 按名字打开（报 “can't be used to capture by name”），所以只能靠上面的枚举顺序定位。

### 2.3 为什么默认用 index 0（而不是 1 / 2 / 3）

- **2、3 不可作默认**：
  - index 2 是 RDP 摄像头重定向设备，只在 RDP 客户端连接且允许摄像头时出现，拍的是客户端（MacBook）方向、不是本机环境；RDP 断开后设备消失，序号会漂移。
  - index 3 是 ToDesk 虚拟摄像头，长期注册但默认黑帧。
- **0 比 1 更合适**：
  1. `probe` 的“建议 index”取第一个可用，实测为 0；
  2. ICreateDevEnum 顺序第一个，是系统默认相机，最稳定；
  3. 低光下手动 -6 读数 8.0（仍有非零信号），而 index 1 只有 0.1（接近全黑，作为“黑暗”判据过于灵敏）；
  4. 生产默认配置（维护者 实测）也是 0。
- 若某台机器 index 0 打不开：用 `probe` 里“手动”列明显 >0、且截图是彩色房间画面的那个 index（本机备选是 1）。

### 2.4 实测数据

#### (a) 新代码 `probe`（手动/自动对比；房间灯关）

| index | 状态 | 自动 luma | 手动 luma(-6) | B/G/R（自动帧均值） | 用时 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | OK | 70.0 | **8.0** | 63.7 / 67.2 / 77.3 | 7.2s | 彩色，支持手动曝光 → **推荐** |
| 1 | OK | 81.6 | 0.1 | 81.1 / 80.8 / 83.5 | 6.2s | 彩色，支持手动曝光 |
| 2 | OK | 53.7 | —（不支持手动） | 48.3 / 54.0 / 54.9 | 6.4s | RDP 重定向摄像头 |
| 3 | OK | 0.1 | —（不支持手动） | 0.0 / 0.0 / 0.0 | 10.8s | ToDesk 虚拟摄像头，黑帧 |
| 4 | 失败 | — | — | — | 0.7s | `index=4 打不开（尝试后端: dshow, msmf, any）` |

截图：`reports/probe-new/camera-{0..3}-{auto,manual}.jpg`。
`camera-0-auto.jpg` 是彩色的墙面/置物架；`camera-0-manual.jpg` 在关灯时接近全黑 —— 正是“手动短曝光反映真实环境光”的直观证据。

#### (b) DSHOW 3 轮稳定性（自动曝光；每轮 open → 丢弃 10 帧 → 3 秒内采 15 帧）

| index | 开流 | 关流 | fps | 黑帧比例 | 自动 luma 范围 |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.84–1.46s | 0.02–0.33s | 10.0 | 0% | 69.6–70.4 |
| 1 | 0.80–1.12s | 0.30–0.31s | 9.6–10.8 | 0% | 59.1–85.3 |
| 2 | 1.63–2.03s | 0.14–0.16s | 18.4–19.0 | 1.1% | 76.6–90.8 |

（原始数据 `reports/cam-stability.json`；另有 1 次首开全黑见 §5 第 10 条。）
低光下彩色摄像头自动曝光把曝光时间拉长，fps 只有 ~10；手动 -6 后更快。每次 tick 只开 1–2 秒，无性能问题。

#### (c) DSHOW vs MSMF 开流耗时（自动曝光，单轮）

| backend | index 0 | index 1 | index 2 | 关流 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **DSHOW** | 1.6s | 1.0s | 2.3s | 0.02–0.33s | **采用** |
| MSMF | **13.5s** | **19.3s** | 0.5s | 0.14–0.37s | 打开极慢（MSMF 每次都枚举/初始化全部设备），不采用 |

#### (d) “开灯”读数：未实测

测试期间用户房间灯一直是关的，因此只能确认“关灯 = 手动 8.0 / 0.1（远低于 `dark_luma_threshold=20`）”。
**开灯时的读数需要用户自己校准**：开灯后运行

```powershell
python D:\...\lockbright\run.py probe
```

看 index 0 的“手动”列；若 “手动”读数没有明显高于 `dark_luma_threshold`（默认 20），就把 `~/.lockbright/config.json` 里的 `dark_luma_threshold` 调到“开灯读数”与“关灯读数”之间（比如开灯 60 → 阈值保持 20 或调到 25 都行；若开灯只有 25，则阈值要 <25）。
`restore_luma_threshold`（默认 40，用于“已调暗后开灯恢复”）同理，取开灯读数的 60–80%。

### 2.5 采集说明与坑

- **自动曝光是陷阱**：同一间黑屋子，自动曝光把画面拉到 59–91，用绝对值判断“黑不黑”完全失效 → 生产必须手动短曝光（维护者 已在 `lb/camera.py` 实现“手动测光 + 恢复自动”）。
- **首开偶发全黑**：测试中 index 0 有 2 次刚打开时连续全黑（读帧间隔 ~1.2s，疑似摄像头刚上电/USB 选择性挂起/被其它程序占用），重新打开即恢复。生产 `camera.py` 用 warmup + burst + 取最亮帧，已能缓解；若 `probe` 里某 index 全黑，重跑一次再下结论。
- **IR 摄像头不可用**：Windows Hello 保留，WinRT/DSHOW 都不会把它暴露给普通程序。
- **虚拟摄像头**：ToDesk Camera 永远在枚举里且默认黑帧；RDP 重定向摄像头只在 RDP 连接时出现 —— 两者都会影响“序号 → 设备”的直觉判断，判断默认摄像头时务必按本文证据链。
- 测试时摄像头只短暂打开、用完立即释放；未改动用户窗口、未锁屏。

---

## 3. 锁屏检测实测

### 3.1 方案

`reports/lockscreen_probe.py`：`ctypes` 调 `OpenInputDesktop(0, False, DESKTOP_READOBJECTS)` +
`GetUserObjectInformationW(handle, UOI_NAME)` 打印输入桌面名；另外用
`WTSQuerySessionInformationW(WTSConnectState)` 打印当前会话连接状态（方便理解 RDP 场景）。
生产逻辑在 `lb/platform_windows.py`（维护者 写域），本脚本只做验证。

### 3.2 未锁屏（实测，RDP 会话 Active）

```
desktop_name = "Default"，open_error = 0
own_session = 1 (state = Active)
verdict = unlocked
```

3 次采样连续一致；同一时刻 `run.py status` 输出 `是否锁屏: False` → 未锁屏判断正确。

### 3.3 RDP 断开（实测到的一次，重要）

测试过程中 RDP 客户端短暂断开，观察到：

| 时间点 | `query session` | `lockscreen_probe` | `run --once` |
| --- | --- | --- | --- |
| RDP 连接中 | session 1 **Active** | `OpenInputDesktop` 成功，desktop=`Default` → 未锁屏 | `锁屏=False`，动作无 |
| RDP 断开后 | session 1 **Disc**；console(2) Conn 无用户 | `OpenInputDesktop` 失败 `err=5`；own session(1) 里出现 `LogonUI.exe` → 兜底判定 **locked=True** | `锁屏=True`，真实摄像头手动 luma=11.0 <20，`dark_streak=1` |
| RDP 重连后 | session 1 **Active** | 恢复 `Default` | `锁屏=False` |

### 3.4 锁屏（Winlogon）——未实测

本环境**不允许强行锁屏**（会打断用户、也违反任务约束），因此“锁屏后桌面名 = `Winlogon`”来自 Windows 通用行为，**未在本机实测**。
预期：用户 Win+L 锁屏 2 分钟后，日志里 `locked=True`，若同时是夜间且关灯，会出现 `调暗屏幕: ...` 行；开灯/解锁会恢复。用户可自行用 `~/.lockbright/lockbright.log` 验证（需要更细的 tick 记录可把 `log_level` 调成 `DEBUG`）。

### 3.5 兜底逻辑与 RDP 风险（需要用户知晓）

- 兜底只认**本会话**的 `LogonUI.exe`：实测 RDP 会话（1）里 console 会话（2）的 `LogonUI.exe` **不会**被误判（own_session 匹配为空）→ 设计正确。
- **RDP 风险**：如果安装/启动是在 RDP 会话里做的，计划任务的进程 `SessionId=1`（RDP 会话）。RDP 断开后 Windows 把该会话视为锁屏 → daemon 会按“已锁屏”测光/调暗**物理屏幕**。机器停留在登录界面时这是期望行为；但如果之后用户到本机（console）登录，由于任务 `MultipleInstances=IgnoreNew`，console 上的新实例不会启动，旧实例仍在断开的 RDP 会话里，可能继续按“已锁屏”调暗物理屏幕。
  - 规避：远程装完后，离开 RDP 前**注销 RDP 会话**（不是直接关窗口）；或在本机登录后先 `Stop-ScheduledTask LockBright` 再 `Start-ScheduledTask LockBright`，让新实例落在 console 会话。最稳妥：**在机器本机（console）上重新运行一次 install 脚本并重启任务**。
  - 本机最终状态是在 RDP 会话里安装的（`SessionId=1`），已按上述结论记录风险。

### 3.6 WMI 亮度读写（实测）

| 操作 | 结果 |
| --- | --- |
| `set-brightness 30` | 设置前 100 → 设置后 **30**，成功 |
| `status` | 当前亮度 **30** |
| `set-brightness 100` | 设置前 30 → 设置后 **100**，成功 |
| 最终 `status` | 当前亮度 **100** |

`platform_windows.py` 用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` +
`CREATE_NO_WINDOW` 调 WMI（`root\WMI` 的 `WmiMonitorBrightness` / `WmiMonitorBrightnessMethods`），
在 `pythonw.exe` 下不会弹窗。

---

## 4. 安装 / 卸载

### 4.1 安装脚本做了什么（`scripts/install_windows.ps1`，纯 ASCII）

1. 找 Python：`python.exe` 经 `sys.executable` 归一化（兼容 Microsoft Store 的转发 stub）；
   `pythonw.exe` **优先取 python.exe 同目录**（避免 PATH 上有多个 Python 时 python/pythonw 不是同一解释器），
   同目录没有才退回 PATH 的 `pythonw.exe`，都没有则退回 `python.exe`（会有控制台窗口）并告警。
2. 校验 `import cv2`；失败时：
   - 带 `-InstallDeps` → 自动 `python -m pip install --upgrade opencv-python` 再校验；
   - 不带 → 打印修复命令并以 exit 1 结束（不会留下坏的安装）。
3. 停掉旧的计划任务和旧的 `...\app\run.py` 进程。
4. 复制 `run.py`、`lb\`、`config.example.json`、`requirements.txt` 到
   `%LOCALAPPDATA%\LockBright\app`（不复制 `__pycache__`）。
5. 注册计划任务 `LockBright`：
   - 触发：`AtLogOn`（当前用户，`MSFT_TaskLogonTrigger`，user=当前用户 SID）
   - 动作：`<pythonw.exe> "<app>\run.py" run`，`WorkingDirectory=<app>`（隐藏窗口）
   - 设置：`-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0(PT0S) -MultipleInstances IgnoreNew`
   - 主体：`Interactive` + `Limited`（**不要** SYSTEM/服务：拿不到交互桌面相机）
   - 注册后脚本会**断言** `ExecutionTimeLimit=PT0S`、触发器是 `LogonTrigger`、logonType=`Interactive`（防默认 3 天时限的坑）。
6. 立即 `Start-ScheduledTask`，最多等 25 秒，验证两件事：
   - 存在命令行含 `<app>\run.py` 的 python/pythonw 进程；
   - 日志文件**本次启动后新增的内容**里出现启动行（匹配 ASCII 字样 `platform=windows`，避免旧日志骗过验证）。
7. 打印任务状态/进程/路径/日志尾部/卸载命令；失败 exit 1 并打印日志 + 前台调试命令。

### 4.2 用法

```powershell
# 正常安装（默认 %LOCALAPPDATA%\LockBright\app，任务名 LockBright）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1

# 缺 OpenCV 时自动 pip 安装
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1 -InstallDeps

# 只装不启动（测试用；建议配合 -AppDir/-TaskName 隔离）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1 `
  -AppDir "$env:TEMP\lb-test\app" -TaskName LockBrightTest -NoStart
```

安装完成后：

```powershell
Get-ScheduledTask -TaskName LockBright | Select-Object TaskName,State
(Get-ScheduledTask -TaskName LockBright).Settings | Select-Object ExecutionTimeLimit,MultipleInstances,DisallowStartIfOnBatteries,StopIfGoingOnBatteries
Get-Content "$env:USERPROFILE\.lockbright\lockbright.log" -Tail 10 -Encoding UTF8
```

### 4.3 卸载（`scripts/uninstall_windows.ps1`，纯 ASCII）

```powershell
# 默认卸载：停任务 → 注销任务 → 杀残留进程 → 删 %LOCALAPPDATA%\LockBright\app
# 保留 %USERPROFILE%\.lockbright（配置/状态/日志/截图）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1

# 连配置一起删
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1 -Purge

# 测过隔离安装的卸载
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1 `
  -AppDir "$env:TEMP\lb-test\app" -TaskName LockBrightTest
```

没装时运行也 exit 0（幂等）。`-Purge` 只删默认的 `%USERPROFILE%\.lockbright`（不处理 `LOCKBRIGHT_HOME` 覆盖的情况）。

### 4.4 实测结果（2026-10-21 00:40–00:47）

| 步骤 | 结果 |
| --- | --- |
| 隔离测试 `-NoStart`（`%TEMP%\lb-install-test\app` + 任务 `LockBrightTest`） | 任务注册 OK、设置正确、程序文件齐全 |
| 隔离测试启动 | 任务 Running、`pythonw.exe` 进程命令行正确、日志有启动行 |
| 隔离测试卸载 | 任务/目录/进程全部清掉，`~/.lockbright` 保留 |
| 真机安装（默认路径/任务名） | 任务 `LockBright` Running，PID 32900（SessionId=1），日志启动行 OK；`ExecutionTimeLimit=PT0S`，触发器 `MSFT_TaskLogonTrigger user=USER`，`logonType=Interactive` |
| 真机卸载 | 任务注销、app 目录（含空父目录）删除、进程结束、`~/.lockbright` 保留 → **可逆** |
| 真机重装（最终状态） | 任务 Running、PID 20984（SessionId=1）、日志新增启动行、`status` 亮度 100 |

> 最终机器状态：**已安装且运行中**（计划任务 `LockBright`，进程 `pythonw.exe "%USERPROFILE%\AppData\Local\LockBright\app\run.py" run`，数据目录 `%USERPROFILE%\.lockbright`，当前亮度 100%）。

### 4.5 安装相关注意事项

- 计划任务必须**当前用户交互登录**时运行（相机权限、桌面会话）；不要改成 SYSTEM/服务。
- 任务用户是“当前安装用户”；换用户使用需重新运行安装脚本。
- 电池参数已设置，避免笔记本用电池时任务不启动/被停止。
- `pythonw.exe` 无控制台，出错只能看日志；排查时用 `python.exe` 跑 `run.py run --once` 或 `probe`。
- 杀软/组策略可能拦截计划任务注册（脚本会报错并 exit 1）。
- 首次运行会自动生成 `~/.lockbright/config.json`（默认值即可用）；改完配置要重启任务。

---

## 5. 坑（按踩到的顺序）

1. **Windows PowerShell 5.1 只吃 ASCII（或带 BOM）**：无 BOM 文件按 ANSI 解码，中文注释/字符串会被拆坏、直接语法错误。两个 `.ps1` 全部纯 ASCII，输出英文；中文提示交给 Python（UTF-8 日志/控制台）。
2. **pythonw 无窗口**：进程隐藏运行，`print`/日志控制台都没有；日志文件是唯一观测点。`probe` 的输出在 pythonw 下看不到 —— 需要用户手动跑一次 `probe`。
3. **计划任务电池默认坑**：默认“使用电池时不启动/会停止”，必须 `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`。
4. **默认 3 天执行时限**：不设置会得到 `PT72H`，3 天后任务被停；脚本显式 `PT0S` 并断言。
5. **RDP 差异（本次实测）**：
   - RDP 摄像头重定向会多出 `MacBook Air Camera (redirected)`，改变“序号 ↔ 设备”的直觉，甚至挤占序号；
   - RDP 断开后该会话被系统视为锁屏（`OpenInputDesktop` err=5 + 本会话 `LogonUI.exe`）→ daemon 会按已锁屏处理；
   - 详见 §3.5 的跨会话风险与规避。
6. **自动曝光陷阱**：黑房间被自动曝光拉亮到 59–91，必须手动短曝光测光；不同驱动对 `CAP_PROP_AUTO_EXPOSURE` 的支持不同（本机 0.25/1.0 有效，probe 会显示“不支持手动曝光”并回退自动）。
7. **红外摄像头不可用**：Windows Hello 保留，OpenCV/ WinRT 普通枚举都拿不到。
8. **虚拟摄像头（ToDesk）**：永远注册、默认黑帧，会出现在 DSHOW 枚举里。
9. **PowerShell 5.1 读 UTF-8 中文日志乱码**：`Get-Content` 默认按 ANSI 解码 → 用 `-Encoding UTF8`（安装脚本内部已这样读）。
10. **摄像头首开偶发全黑/慢开流**（测试中 index 0 遇到 2 次）：重新打开即可；生产用 warmup+burst+取最亮帧缓解。
11. **`probe` 的“建议 index”只是第一个能打开的摄像头**，不等于“彩色可见光摄像头” —— 要对照 `camera-N-auto.jpg` 截图确认（本机 index 2 是 RDP 摄像头、index 3 是虚拟摄像头，都不是本机相机）。
12. **CLI 与 SPEC 措辞不一致**：`simulate` 实际用 `--at`，且“不给 `--apply` 就是 dry-run”，没有 `--dry-run` 选项（SPEC §5 写的 `--dry-run`/`--time` 会直接报参数错误）—— 已作为 BUG 报告给 维护者，见 `reports/windows-acceptance.md`。
13. **本机测试会创建真实用户数据**：安装脚本写 `~/.lockbright`；非安装类测试建议 `LOCKBRIGHT_HOME=<临时目录>`，避免污染真实配置。
14. **RDP 里 `query session` 显示会话状态**：`Active` = 客户端连接中；`Disc` = 客户端断开但会话/进程还在（本次锁屏检测差异的来源）。

---

## 6. 辅助脚本与证据索引

| 路径 | 用途 |
| --- | --- |
| `reports/probe-new/camera-{0..3}-{auto,manual}.jpg` | 新代码 `probe` 截图（0/1 有 auto+manual，2/3 只有 auto） |
| `reports/cam-index/idx{N}_dshow_r1_map.jpg` | DSHOW 各序号同轮对照截图（0 墙景、1 房间、2 人像、3 黑帧） |
| `reports/win/enum_winrt.ps1` | WinRT VideoCapture 设备名顺序（必须 `powershell.exe` 5.1） |
| `reports/win/enum_dshow_com.ps1` | DirectShow `ICreateDevEnum` 顺序 + FriendlyName/DevicePath（映射的权威证据） |
| `reports/win/capture_by_name.ps1` | 按设备名用 WinRT 抓一帧（名字 ↔ index 内容比对） |
| `reports/win/enum_dshow.ps1` | 注册表/PnP 设备清单（辅助，说明注册表顺序不可用） |
| `reports/cam_probe.py` | 多轮 OpenCV 各 index 采集（开流/关流/luma/通道/黑帧） |
| `reports/cam_stability.py` | 单 index 连续读流稳定性（黑帧比例、首帧延迟、fps） |
| `reports/cam_byname.py` | 验证 OpenCV 是否支持按设备名打开（结论：不支持） |
| `reports/lockscreen_probe.py` | 锁屏检测验证（桌面名 + WTS 会话状态 + LogonUI 兜底） |
| `reports/cam-*.json` | 上述采集的原始数据 |
| `reports/accept/*.txt` | 端到端验收的原始命令输出 |

复现关键采集（在项目根目录）：

```powershell
python reports\cam_probe.py --backends DSHOW --rounds 3 --indices 0-3
powershell.exe -NoProfile -ExecutionPolicy Bypass -File reports\win\enum_winrt.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File reports\win\enum_dshow_com.ps1
python reports\lockscreen_probe.py --repeat 3
```

---

## 维护者 集成补充（2026-10-21，在 Windows 维护者交付之后）

1. **§3.5 的“RDP 跨会话风险”已在 维护者侧修复**：`lb/platform_base.py` 新增
   `is_session_active()`；`lb/platform_windows.py` 用
   `WTSQuerySessionInformationW(WTS_CONNECTSTATE_CLASS)` 判断当前会话是否活动，
   `daemon.py` 在会话非活动（如 RDP 已断开）时**跳过本轮所有亮度动作**，
   `is_locked()` 也不再对断开会话做锁屏判断。这样任务进程留在断开的 RDP 会话里时
   不会误调物理屏幕亮度；重连后自动恢复工作。已同步 `docs/SPEC.md` 与 README。
2. **第 12 条 BUG 已处理**：SPEC §5 的 simulate 示例已改为
   `simulate --locked --luma 3 --at 23:00`（默认 dry-run），并注明
   `dark_confirm_samples=2` 需连续两次才会出现 dim；README 示例本来就是对的。
3. **probe 提示**：现在同时打印 `手动图=...` 路径（手动曝光截图）。
4. **最终安装**（维护者 复核）：用同一 `install_windows.ps1` 重装，任务 Running、
   PID 27260、安装副本与仓库 SHA256 全一致、亮度 100、日志有 `platform=windows` 启动行；
   单元测试 51 个全过。
5. **多摄像头选择/预览（新增功能）**：`run.py cameras` 列出 DirectShow 名称+测光+截图，
   `run.py preview --index N` 实时预览（0-9 切换、s 截图、Enter 选中，`--set` 写入配置），
   `run.py --headless` 可无窗口截图；配置新增 `camera_name`（设备名片段，启动时解析，
   优先级高于 index）。本机实测：0=Integrated Webcam、1=Integrated Camera 与本文映射一致。
6. **审计后安全修复**（维护者）：`set_brightness` 增加读回校验（WMI ReturnValue 实际可能为
   null，不能依赖）；安装/卸载脚本增加 AppDir 删除守卫（拒绝源码根/用户目录/祖先目录，
   卸载只在标记文件存在时删除）；调暗前复查锁屏状态；配置增加
   `restore_luma_threshold > dark_luma_threshold` 等跨字段校验；配置错误时先写文件日志
   （pythonw 无 stderr）；会话变为非活动时若已调暗会恢复一次再跳过。
7. **远程登录按锁屏处理（2026-10-21 晚，用户需求）**：`platform_base.py` 新增
   `is_remote_session()`，`platform_windows.py` 用
   `WTSQuerySessionInformationW(WTSIsRemoteSession=29)` 判断当前会话是否为 RDP/远程会话
   （实测该值返回 **1 字节 BOOLEAN**，不能按 DWORD 读；已兼容 `WTSClientProtocolType=16`
   兜底）；`daemon.py` 新增 `_effective_locked()`：当本会话是远程会话且配置
   `treat_remote_as_locked=true`（默认）时，**把远程登录也当作“已锁屏”**，照常测光、
   夜间关灯调暗物理屏幕。RDP 断开（会话非活动）时仍跳过动作，若已调暗会先恢复一次。
   `status` 命令新增“是否远程会话 / 有效锁屏（远控计入）”两行；预检锁屏复查也走同一逻辑。
   **本机实测**：23:09 以远程会话重装重启，23:10:15 日志出现 `调暗屏幕: 100% -> 0%
   （锁屏且关灯（亮度 11.0 < 20.0，连续 2 次））`，物理亮度读回 0、state 记录
   `dimmed=true baseline=100` —— 远程登录已被当作锁屏并正常调暗。
8. **曝光值修正：-6 → -4（2026-10-21 23:20，用户反馈“开灯不恢复”）**：
   - 现象：用户开灯后屏幕仍 0%，日志没有任何 restore；`cameras` 显示该房间开灯时
     自动曝光 luma=125，但手动 `-6` 只读到 ~10（与关灯读数相同）→ 永远达不到
     `restore_luma_threshold=40`。
   - 实测曝光矩阵（开灯）：该摄像头把 `-1/-2/-3` 钳到 `-4`；`-4` 读 58、`-5` 读 28、
     `-6` 读 10、`-8` 读 1.4；关灯时 `-4` 约 9~11。**-6 太短，开灯/关灯无法区分**。
   - 修复：默认 `camera_exposure` 改为 **-4.0**，阈值保持 20/40；真实配置同步改为 -4；
     并在“已调暗状态下测光”时打印 INFO 读数，便于排查。
   - 复测：23:18:44 开灯状态 luma=57.3 → 23:18:46 `恢复亮度: 亮度设为 100%
     （开灯了（亮度 57.3 >= 40.0））`，亮度读回 100、state `dimmed=false`。
9. **自启加固（2026-10-26 晚，用户反馈“不能自启”）**：
   - 排查结论：任务本身在 22:28:20（本次开机 22:27:31 后登录）**确实被 AtLogOn 触发并启动**
     （TaskScheduler Operational 日志 id 129/200；日志有 22:28:57 启动行），所以“没自启”的
     观感更可能来自旧实例残留：`MultipleInstancesPolicy=IgnoreNew` 时，RDP 断开后留在旧会话的
     守护进程仍算“任务在运行”，新登录会话触发时会被忽略 → 新会话里没有可用的守护进程。
   - 修复 1：任务 XML 改成 **`MultipleInstancesPolicy=StopExisting`**（PowerShell 的
     `New-ScheduledTaskSettingsSet` 枚举没有 StopExisting，所以注册后用
     `Export-ScheduledTask` 改 XML 再 `Register-ScheduledTask -Xml` 回写）。实测：任务运行中
     再次触发，旧 PID 20124 被杀、新 PID 11208 启动（日志出现新的启动行）。
   - 修复 2：**看门狗任务 `LockBrightWatchdog`**（`schtasks /Create /SC MINUTE /MO 2 /IT`，
     `pythonw.exe watchdog.py` 隐藏运行），每 2 分钟检查守护进程是否存在，不存在就
     `schtasks /Run /TN LockBright`。实测：强杀 PID 16908 后，22:40:01 看门狗触发，
     22:40:06 守护进程以新 PID 14312 恢复，`watchdog.log` 有对应记录；守护进程正常时看门狗
     不写日志、不重复启动。
   - 修复 3：任务保留 `RestartCount=3 / RestartInterval=1min`，但实测“外部 Stop-Process 强杀”
     不会触发 Task Scheduler 的 restart-on-failure（LastTaskResult=0xFFFFFFFF），所以真正兜底
     靠看门狗；文档已按这个事实写。
   - 仍有的系统限制：**开机停在登录界面时不会跑**（需要登录会话才能开摄像头/控制当前桌面亮度）；
     用户登录后由 AtLogOn 启动，之后看门狗维持。
