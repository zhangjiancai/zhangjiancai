# LockBright — 规格与接口（团队内部对齐用）

目标是**一个 Python 代码库同时支持 Windows 和 macOS**：
锁屏后按间隔用摄像头测环境亮度，确认关灯就把屏幕亮度调到最暗；
每天早上固定时间把亮度拉满；开灯/解锁/早上到点都能正确恢复。

> 本文是给实现者/验证者的接口契约。用户文档在 `README.md`。

## 1. 运行时行为（已定稿）

主循环每 `check_interval_seconds` 秒一次，每次 tick 顺序：

1. **早上补触**：若 `now.time() >= morning_time` 且 `state.last_morning_date != today`：
   - 动作 `set_brightness(morning_brightness)`（默认 100）
   - 清空 dimmed/baseline/dark_streak，记 `last_morning_date = today`
   - 该动作与是否锁屏无关；睡醒/开机后补做（catch-up）
   - 只在“非夜间时段”补触：如果守护进程 23:00 才启动，不会在半夜先拉满再调暗
2. **会话非活动**（RDP 断开等，`is_session_active() is False`）：跳过本轮所有亮度动作；
   若已调暗则先尝试恢复一次，避免留下黑屏。
3. **锁屏且已调暗**：
   - 若环境亮度 `luma >= restore_luma_threshold`（开灯了）→ 恢复到 baseline
   - 若已离开夜间时段 → 恢复到 baseline
4. **锁屏且未调暗**：
   - 仅当处于**夜间时段**（`night_start` 到次日 `morning_time`，可跨零点）且 `luma < dark_luma_threshold`
   - 连续 `dark_confirm_samples` 次确认（每次 tick +1）才调暗；摄像头测光失败（luma=None）清零 streak
   - 调暗前用 `platform.get_brightness()` 取 baseline；若取不到或 baseline <= dim_brightness，
     用 `fallback_restore_brightness`
   - 写亮度前**再查一次锁屏状态**，若已解锁则放弃调暗（防止测光 1~4 秒期间用户解锁被误调暗）
   - 动作 `set_brightness(dim_brightness)`（默认 0），state.dimmed = true
5. **未锁屏**：`dark_streak = 0`；若 dimmed 且 `restore_on_unlock` → 恢复 baseline
6. **锁屏状态未知（None）**：不做锁屏相关动作，`dark_streak = 0`
7. 任何一步失败（摄像头失败、亮度读写失败）只记日志，绝不崩溃/退出主循环。
8. 摄像头只在"需要判断"的 tick 打开：锁屏且夜间、或已调暗需要检查开灯。其他 tick 不碰摄像头。

所有"动作"都是幂等的：已经 dimmed 就不重复调暗；恢复后清状态。

## 2. 目录布局（项目根 `lockbright`）

```
lockbright/
  run.py                  # CLI 入口：python run.py {run|once|probe|status|simulate|set-brightness|init}
  lb/
    __init__.py           # 版本号
    platform_base.py      # Platform 抽象（维护者）
    platform_windows.py   # Windows：锁屏检测 + WMI 亮度（维护者）
    platform_mac.py       # macOS：锁屏检测 + IOKit 亮度（macOS 维护者）
    config.py             # 配置 dataclass + 读写（维护者）
    camera.py             # OpenCV 测亮度（维护者）
    decide.py             # 纯决策函数（维护者）
    daemon.py             # 主循环/动作应用/状态持久化（维护者）
    paths.py              # home/config/state/log 路径（维护者）
  config.example.json
  requirements.txt        # opencv-python（numpy 随附）
  docs/SPEC.md
  docs/WINDOWS-NOTES.md   # Windows 维护者
  docs/MACOS-NOTES.md     # macOS 维护者
  scripts/install_windows.ps1 / uninstall_windows.ps1   # Windows 维护者（仅 ASCII！）
  scripts/install_macos.sh / uninstall_macos.sh          # macOS 维护者
  tests/test_decide.py test_config.py                    # 维护者
  README.md               # 维护者
```

## 3. 平台接口（两边必须实现同一个类）

```python
# lb/platform_base.py
class Platform:
    name: str = "base"
    last_error: str | None = None

    def is_locked(self) -> bool | None:
        """True=已锁屏, False=未锁屏, None=无法判断。不得抛异常。"""

    def get_brightness(self) -> int | None:
        """0-100 的整数；读不到返回 None。不得抛异常。"""

    def set_brightness(self, percent: int) -> bool:
        """设置主显示器亮度（0-100，内部 clamp）；成功 True，否则 False + last_error。"""

    def is_session_active(self) -> bool | None:
        """False=当前登录会话不是活动会话（如 RDP 已断开），此时不允许改物理亮度；
        None=无法判断（按活动处理）。不得抛异常。"""

    def is_remote_session(self) -> bool | None:
        """True=当前登录会话是远程会话（RDP 等）；用于把“远程登录”按锁屏处理。
        None=无法判断。不得抛异常。"""

    def close(self) -> None:
        """释放资源（可空实现）。"""
```

Windows 实现要点（已验证）：
- 锁屏：`OpenInputDesktop` + `GetUserObjectInformationW(UOI_NAME)`，名字为 `Default` = 未锁；
  其他（`Winlogon`）= 已锁；打开失败作为兜底可看本会话 `LogonUI.exe`（找到=已锁，
枚举失败/找不到=未锁）。
- 亮度：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
  调 `root\WMI` 的 `WmiMonitorBrightness` / `WmiMonitorBrightnessMethods.WmiSetBrightness`
  （本机实测可读写；外接显示器/台式机可能不支持 → 返回 None/False）。
- 用 `subprocess.run(..., timeout=30, creationflags=CREATE_NO_WINDOW)`，避免 pythonw 下弹窗。
- 远程会话识别：`WTSQuerySessionInformationW(WTSIsRemoteSession=29)`；`is_remote_session()=True`
  时 daemon 默认按 `locked=True` 处理（配置 `treat_remote_as_locked` 可关）。
- `set_brightness` 写完会读回 `WmiMonitorBrightness.CurrentBrightness` 校验（±2）；
  不一致返回 False 让 daemon 保持状态重试。（本机实测该 WMI 方法的 `ReturnValue`
  可能是 null，所以不依赖它，只依赖 poweshell 退出码 + 读回校验。）

macOS 实现要点（待 macOS 维护者确认）：
- 亮度：优先 ctypes 调 IOKit `IODisplayGetFloatParameter/IODisplaySetFloatParameter`
  （kIODisplayBrightnessKey），或用 `DisplayServicesSetBrightness` 私有框架；
  不要求用户额外装 brew CLI。
- 锁屏：`ioreg -n Root -d1 -a` 输出 plist，解析 `IOConsoleUsers[*].CGSSessionScreenIsLocked`；
  解析失败再退回 `CGSessionCopyCurrentDictionary`（若 pyobjc 可用）。返回 None 而不是猜。

## 4. 配置 `~/.lockbright/config.json`（首次运行自动生成）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| check_interval_seconds | 60 | 轮询间隔 |
| night_start | "20:00" | 夜间时段开始 |
| morning_time | "07:30" | 早上拉满亮度的时间，也是夜间的结束 |
| morning_brightness | 100 | 早上目标亮度 |
| dim_brightness | 0 | 调暗目标亮度 |
| dark_luma_threshold | 20 | 平均亮度低于它算"黑" |
| restore_luma_threshold | 40 | 已调暗时高于它算"开灯了" |
| dark_confirm_samples | 2 | 连续几次黑才调暗 |
| restore_on_unlock | true | 解锁时是否恢复 |
| treat_remote_as_locked | true | RDP 远程会话按“已锁屏”处理（Windows） |
| fallback_restore_brightness | 80 | baseline 取不到/无效时的恢复值 |
| camera_index | 0 | OpenCV 设备序号 |
| camera_name | null | 设备名片段（Windows DirectShow 名称），启动时解析成 index 并覆盖 camera_index |
| camera_samples | 5 | 每次测光取几帧 |
| camera_warmup_frames | 3 | 丢弃前几帧 |
| camera_backend | "auto" | auto 在 Win 下=dshow、mac 下=avfoundation |
| camera_manual_exposure | true | 测光时锁手动短曝光，测完恢复自动（关键，见 §5） |
| camera_exposure | -4.0 | 手动曝光值（对数秒，-4≈1/16s；本机摄像头可用的最长值；范围 -20..0） |
| log_level | "INFO" | DEBUG/INFO/WARNING |

`LOCKBRIGHT_HOME` 环境变量可覆盖 `~/.lockbright`（测试/验证必须用它，避免污染真实配置）。
状态文件 `state.json` 和日志 `lockbright.log` 都在同一个 home 下。

## 5. 摄像头测光的关键实测发现（2026-10-21 本机）

- 默认自动曝光会把“黑房间”拉亮：本机实测同一黑暗房间 auto luma ≈ 70~85，
  而固定手动曝光读 0~11。**直接用自动曝光 + 绝对阈值会永远判不出关灯**。
- 2026-10-21 23:20 追加实测（开灯状态）：`-6` 太短，开灯也只读到 ~10（与关灯无法区分，导致
  “开灯不恢复”）；该摄像头会把 `-1/-2/-3` 钳到 `-4`，而 `-4` 开灯读数 ≈58、关灯 ≈9~11。
  因此默认曝光改为 **-4**，阈值 20/40 能正确区分开灯/关灯。
- 因此测光流程固定为：打开摄像头 → `CAP_PROP_AUTO_EXPOSURE` 设手动（Win 0.25 / mac 0 / V4L2 1）
  → `CAP_PROP_EXPOSURE` 设 `camera_exposure` → 预热 → 连拍取最亮帧 → **恢复自动曝光** → 关闭。
- 手动曝光不被支持时自动回退 auto，只记一次 warning；此时阈值需用户用 `probe` 校准。
- `probe` 会同时输出 auto 与 manual 两组读数并各存一张 jpg，便于用户校准阈值/选摄像头。
- 恢复自动曝光已实测有效（设置 AUTO_EXPOSURE=1.0 后画面恢复）。

## 6. 验收（Windows 本机必须实际跑）

1. `python run.py probe`：打印平台/配置路径/亮度/锁屏状态；0..N 摄像头序号的开流、平均亮度，
   并保存 jpg 到 `~/.lockbright/probe/`；能识别出哪个序号是彩色摄像头（输出里给出名字或说明）。
1b. `python run.py cameras`：列出每颗摄像头名称/分辨率/测光/截图；`python run.py preview --index N`
   弹实时预览窗口（0-9 切换、Enter 选中、`--set` 写入配置），`--headless` 可无窗口截图。
   Windows 上名称来自 DirectShow `ICreateDevEnum` 顺序，与 OpenCV index 一致。
1c. 配置 `camera_name` 能覆盖 `camera_index`：启动时按名字匹配 index（Windows 有效）。
2. `python run.py set-brightness 30` + `status` 能读到 30，再 `set-brightness 100`。
3. `python run.py simulate --locked --luma 3 --at 23:00` 输出“动作: 无 + dark_streak=1”；
   再跑一次（或 `--apply` 两次）才出现 `dim(brightness=0)`，因为 `dark_confirm_samples=2`。
   `simulate` 默认就是 dry-run（不改亮度、不写状态），加 `--apply` 才真改。
   真执行后必须 `python run.py set-brightness 100` 恢复。
4. `python tests/test_decide.py`（unittest）全绿。
5. `python run.py run --once` 在未锁屏时正常退出、日志正常。
6. 安装脚本注册开机自启并成功启动进程（`Get-ScheduledTask LockBright`、日志有启动行）。
7. 锁屏真机验证（需要用户配合）：锁屏 > 2 分钟，日志出现 `locked=True`、luma 数值；
   关灯则出现调暗动作。此步不能由验证者强行锁屏。
