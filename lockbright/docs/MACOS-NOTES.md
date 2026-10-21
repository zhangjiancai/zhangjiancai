# LockBright — macOS 适配说明（技术调研 + 实现说明 + 未实测清单）

> 本文件由 LockBright 维护者编写（macOS 侧代码尚未在真机上运行）。
> **写作环境：只有 Windows 机器，macOS 代码一行都没有在真机上跑过。** 所有 macOS 侧结论来自：
> ① Apple 官方文档 / man page / SDK 源码（有链接）；② 上游开源实现源码（nriley/brightness、OpenCV）；
> ③ 社区实测记录（GitHub issue/PR、StackOverflow，有链接）。每条关键结论都标了来源或“未实测”。
>
> 图例：
> - ✅ **有来源**：调研时抓到原文/源码/man page，链接见 §10。
> - ⚠️ **未实测**：结论/代码没有在真机 macOS 上运行过。
> - ❓ **推测**：基于间接证据的判断，置信度低于前两者。
> - 🔬 **静态验证**：只在 Windows 上做过 `py_compile` + 静态逻辑测试（见 §7），不是真机验证。
>
> 审核建议：把 §7 的 R1–R3 当作“上 Mac 后最先验证”的清单；把 §5 当作“最大产品风险”。

---

## 0. 一页结论（TL;DR）

| 能力 | 实现方案 | 依据强度 | 实测状态 |
| --- | --- | --- | --- |
| 亮度读取 | `ctypes` 调 IOKit `IODisplayGetFloatParameter`（`IODisplayConnect` + `kIODisplayBrightnessKey="brightness"`） | ✅ 上游开源实现 | ⚠️ 未实测 |
| 亮度设置 | 优先同上 IOKit；**读回校验**失败后依次降级 `DisplayServices` 私有 SPI → `CoreDisplay` 私有 SPI → 可选 `brightness` CLI | ✅（Apple Silicon 必须走 DisplayServices） | ⚠️ 未实测 |
| 多显示器 | 设置时对**所有**接受参数的 `IODisplayConnect` 设置；DisplayServices/CoreDisplay 只设**内置屏**（`CGDisplayIsBuiltin` 优先，其次主屏） | ✅ API 语义；策略是我们定的 | ⚠️ 未实测 |
| 锁屏检测 | `ioreg -n Root -d1 -a` → `plistlib` 解析 `IOConsoleUsers[*].CGSSessionScreenIsLocked` | ✅ man page + 多个社区实例 | ⚠️ 未实测 |
| 锁屏兜底 | `CGSessionCopyCurrentDictionary()`（仅当 pyobjc 已安装时才可用；该 key 未公开） | ✅ 官方文档说明返回 dict；key 未公开 | ⚠️ 未实测（pyobjc 非依赖） |
| 相机权限（TCC） | **本项目最大风险**。LaunchAgent 直接跑 python3 很可能被静默拒绝；推荐先 Terminal 前台 `probe` 授权，失败则用 `.app`/登录项或前台运行 | ✅ Apple 官方 TCC 文档 + 社区报告 | ⚠️ 未实测，见 §5 |
| 开机自启 | `~/Library/LaunchAgents/com.lockbright.agent.plist` + `launchctl bootstrap gui/$UID` | ✅ launchd man page | ⚠️ 未实测 |
| 手动短曝光 | **不可用**：OpenCV 4.x 的 macOS/AVFoundation 后端不实现 `CAP_PROP_AUTO_EXPOSURE`/`CAP_PROP_EXPOSURE`，`cap.set()` 返回 false → 自动回退自动曝光 | ✅ OpenCV 源码（见 §6） | ⚠️ 未实测 |

一句话总结：**亮度/锁屏有可靠的公开或半公开 API 路径；相机在“锁屏 + LaunchAgent”组合下是 TCC 权限问题，不是代码问题，必须真机验证并准备兜底方案。**

---

## 1. 交付物与接口

| 文件 | 内容 |
| --- | --- |
| `lb/platform_mac.py` | `class MacPlatform(Platform)`，`name="macos"`；实现 `is_locked / get_brightness / set_brightness / close`，全部方法不抛异常，失败置 `last_error`（契约见 `lb/platform_base.py`） |
| `scripts/install_macos.sh` | 检查 Python≥3.9 + OpenCV、复制到 `~/Library/Application Support/LockBright/app`、生成并加载 LaunchAgent、打印 TCC 授权流程 |
| `scripts/uninstall_macos.sh` | 停止并卸载 LaunchAgent、删 app 副本；默认保留 `~/.lockbright`，`--purge` 才删 |
| `docs/MACOS-NOTES.md` | 本文件 |

### 1.1 懒加载（重要约束）

`platform_mac.py` **模块顶层不 dlopen 任何 macOS 框架**，只在方法第一次被调用时才 `ctypes.CDLL(...)`：

- 在 Windows 上 `import lb.platform_mac` 不会失败（这也是项目静态检查的要求，`run.py` 在 Darwin 上才会 `from lb.platform_mac import MacPlatform`）。
- 在非 macOS 上实例化 `MacPlatform()` 也不抛异常；四个方法会返回 `None`/`False` 并设置 `last_error`（与 `WindowsPlatform` 在 `__init__` 里抛异常的风格不同，这样便于跨平台静态检查，已在类 docstring 注明）。
- 每个库加载成功/失败都缓存，避免反复 dlopen；`close()` 会 `CFRelease` 缓存的 `CFString` 并清空缓存。

### 1.2 与 `run.py` / `daemon.py` 的交互（已核对 维护者 代码）

- `run.py:create_platform()` 在 `platform.system()=="Darwin"` 时 `from lb.platform_mac import MacPlatform` → 类名、构造参数（无参）与 维护者 代码一致。
- `daemon.py` 的用法：`is_locked()` 可能返回 `None`（未知 → 本轮不做锁屏动作）；`get_brightness()` 返回 0–100 的 int（daemon 用做 baseline，取不到则用 `fallback_restore_brightness`）；`set_brightness(target)` 返回 bool；`platform.last_error` 用于日志；`close()` 在退出时调用。
- 本实现 `get_brightness()` 返回 `round(level*100)` 并 clamp 到 0–100；`set_brightness(percent)` clamp 后按 `percent/100.0` 下发。

### 1.3 日志双写小问题（不阻塞，提醒 维护者）

`run.py:setup_logging()` 自己用 `RotatingFileHandler` 写 `~/.lockbright/lockbright.log`，同时 LaunchAgent 的 `StandardOutPath/StandardErrorPath` 也指向同一个文件（本任务要求）。结果是**同一条日志可能出现两次且格式不同**，`RotatingFileHandler` 轮转与 launchd 已打开的文件描述符之间也没有协调。功能不受影响，但日志会显得吵；建议后续在 `run.py` 里检测“stderr 已被 launchd 重定向到日志文件”时关闭 console handler，或安装脚本把 `StandardOutPath` 指向另一个文件。**这条是 macOS/Windows 共有的集成细节，不在我的写域，特此说明。**

---

## 2. 亮度实现

### 2.1 调用顺序（与代码一一对应）

`get_brightness()`：

| 顺序 | 函数 | 说明 |
| --- | --- | --- |
| 1 | `_read_via_iokit()` | 公开 IOKit API；枚举 `IODisplayConnect`，逐个 `IODisplayGetFloatParameter(service, 0, CFSTR("brightness"), &value)` |
| 2 | `_read_via_display_services()` | 私有 `DisplayServicesGetBrightness(CGDirectDisplayID, float*)` |
| 3 | `_read_via_core_display()` | 私有 `CoreDisplay_Display_GetUserBrightness(CGDirectDisplayID)` |
| 4 | `_read_via_cli()` | 可选 `brightness -l`（Homebrew/源码安装的 CLI） |
| 5 | — | 全失败 → `last_error`，返回 `None` |

`set_brightness(percent)`：

| 顺序 | 函数 | 说明 |
| --- | --- | --- |
| 1 | `_write_via_iokit()` + `_verify_level()` | 按任务要求 IOKit 优先；写后**读回校验**（优先用 DisplayServices 读、其次 IOKit 读），不一致就继续降级——因为现代 macOS 上 IOKit 写会被 CoreDisplay/系统覆盖（见 2.3） |
| 2 | `_write_via_display_services()` | `DisplayServicesSetBrightness(display, level)`，返回 0 视为成功 |
| 3 | `_write_via_core_display()` | `CoreDisplay_Display_SetUserBrightness(display, level)`，写后读回校验 |
| 4 | `_write_via_cli()` | `brightness <0..1>`，退出码 0 且 stderr 不含 failed/unable 视为成功 |
| 5 | — | 全失败 → `last_error`，返回 `False` |

> 设计取舍：任务/SPEC 要求“优先 IOKit，失败回退 brew CLI”。但调研发现 **IOKit 写在现代 macOS 上会被静默覆盖、在 Apple Silicon 上直接 `kIOReturnUnsupported`**（见 2.3），只按字面实现会导致“返回 True 但屏幕没变”。所以在 IOKit 与 CLI 之间插入了 `DisplayServices`（Apple Silicon 上真正生效的路径）与 `CoreDisplay`（Intel 10.12.4–10.15 的路径），并用读回校验决定是否降级。这算对 SPEC 的**补充**而非冲突；如 维护者 希望严格按字面顺序，只需调换 `set_brightness()` 里的两段即可，接口不变。

### 2.2 公开 IOKit API（首选）

```c
// IOKit/graphics/IOGraphicsLib.h（随 Xcode SDK 分发）
kern_return_t IODisplayGetFloatParameter(io_service_t service, IOOptionBits options,
                                        CFStringRef parameter, float *value);
kern_return_t IODisplaySetFloatParameter(io_service_t service, IOOptionBits options,
                                        CFStringRef parameter, float value);
#define kIODisplayBrightnessKey CFSTR("brightness")
```

ctypes 关键点（代码里都有对应注释）：

- `IOServiceMatching("IODisplayConnect")` → `IOServiceGetMatchingServices(kIOMasterPortDefault=0, matching, &iterator)`。
  **matching 字典被 `IOServiceGetMatchingServices` 消费（函数内部 release）**，不要自己 `CFRelease`；iterator 和每个 service 必须 `IOObjectRelease`（代码里 `try/finally` 释放）。
- C 的 `CFSTR(...)` 是宏，ctypes 无法展开 → 用 `CFStringCreateWithCString(kCFAllocatorDefault=NULL, "brightness", kCFStringEncodingUTF8=0x08000100)` 创建，`close()` 里 `CFRelease`。
- `CGDisplayIOServicePort()` 自 macOS 10.9 起被标记 deprecated；上游 `nriley/brightness` 也**不再用它**，改为遍历 `IODisplayConnect` 后用 `IODisplayCreateInfoDictionary` 的 vendor/product/serial 匹配显示器 ID（`brightness.c` 里的 `CGDisplayGetIOServicePort`）。本实现不需要按 ID 匹配：设置时对每个可写服务都设（外接屏通常拒绝、自动跳过），读取时取第一个成功值。**没有调用 deprecated 的 `CGDisplayIOServicePort`**，所以不存在“在 Apple Silicon 上符号不存在”的崩溃点。
- `CGMainDisplayID()` 只用于 `DisplayServices`/`CoreDisplay` 路径兜底选屏；真正“该调哪块屏”由 `_target_display_id()` 决定：**内置屏（`CGDisplayIsBuiltin`）→ 主屏 → 第一块在线屏**。这样做的原因：macOS 的“主屏”经常是外接显示器（nriley/brightness issue #38 里的实测输出中 `display 0: main ... external`、内置屏是 `display 1`）。
  - Apple 文档：`CGMainDisplayID()` 是“屏幕坐标 (0,0) 的那块、通常带菜单栏”；`CGDisplayIsBuiltin()` 表示“笔记本内置屏”，并明确“合盖时可能没有内置屏”。
- 支持的显示器范围：`CGGetOnlineDisplayList()`（含 active/mirrored/sleeping）。

**来源**：nriley/brightness 源码（`brightness.c` 中的 `getBrightness`/`setBrightness`/`CGDisplayGetIOServicePort`）[S1]；StackOverflow 上同一套 IOKit + ctypes 用法的问答 [S3][S4]；Apple CoreGraphics 文档 [S15][S16][S17]。

### 2.3 为什么还需要 DisplayServices（Apple Silicon 的关键）

| 事实 | 来源 | 置信度 |
| --- | --- | --- |
| macOS 10.12.4（Night Shift）起，**公开 IOKit set 会被 CoreDisplay 的亮度覆盖**，官方没有替代 API；上游 brightness 因此改用未公开方法 | `brightness.c` 顶部注释、README [S1] | ✅ |
| Apple Silicon / macOS 11+ 上 `IODisplayConnect` 的亮度读写不再可用（M1 实测 `brightness` 返回错误码 `-536870201` = `kIOReturnUnsupported`） | nriley/brightness issue #38 [S2]；SO 65150131 “IODisplayConnect is gone in Big Sur of Apple Silicon” [S5] | ✅ |
| Apple Silicon 上可用的替代是私有 `DisplayServices.framework`：`extern int DisplayServicesGetBrightness(CGDirectDisplayID, float*)` / `DisplayServicesSetBrightness(CGDirectDisplayID, float)`（返回 0 成功），上游 brightness 已用它支持 M1 | SO 65150131 答案 [S5]、SO 28818993 答案（M1 Pro 实测）[S3]、brightness PR #36 [S1] | ✅（社区实测；我们未实测） |
| `corebrightnessdiag status-info` 可手动查 `DisplayServicesBrightness`（调试用，代码里不用） | SO 65150131 答案 [S5] | ✅ |

取舍：

- **私有 SPI 的风险**：不是 App Store 可用的 API（本项目不分发 App Store，无影响）；系统升级可能改名/移除（代码里所有符号访问都包在 `try/except AttributeError` 里，失败就降级）；macOS 15+ 对“私有 API”没有运行时拦截，仅审核政策问题。**未实测点**：新系统上 `DisplayServicesGetBrightness` 的返回值是否仍与系统亮度滑块一致。
- 为什么不直接用 `CoreBrightness`/`DisplayServicesGetLinearBrightness`：上游 brightness 也只用这两个（Get/SetBrightness），`SetLinearBrightness` 会改变“用户亮度 vs 环境亮度”的映射，和系统自动亮度打架，故不采用。

### 2.4 CoreDisplay SPI（Intel 10.12.4–10.15 的补位）

```c
extern double CoreDisplay_Display_GetUserBrightness(CGDirectDisplayID id);   // double
extern void   CoreDisplay_Display_SetUserBrightness(CGDirectDisplayID id, double brightness);
```

- 来源：`brightness.c` 的 weak import 声明与注释（“至少比私有框架里的符号更‘公开’，但没有公开头文件”）[S1]；上游把“DisplayServices 不可用时”的 Intel 场景交给它。
- 在 Apple Silicon 上它**不生效**（上游 README 明说），所以代码把它排在 DisplayServices 之后；如果 DisplayServices 已经成功，根本不会走到这里。
- 风险：如果未来系统移除该符号，`ctypes` 层会抛 `AttributeError`，代码捕获后返回 `None/False`；**没有在真机上验证过“调用它不会崩”**（上游长期在 Intel 用户机上使用，未见崩溃报告）。

### 2.5 可选的 `brightness` CLI 兜底（不强制依赖）

- 查找顺序：`shutil.which("brightness")` → `/opt/homebrew/bin` → `/usr/local/bin` → `/usr/bin` → `/bin`；找不到就跳过（不会报错、不会阻塞）。
- 读：`brightness -l`，输出形如：
  ```
  display 0: main, active, awake, online, external, ID 0x2
  display 0: brightness 0.250000
  display 1: active, awake, online, built-in, ID 0x1
  display 1: brightness 0.400000
  ```
  解析规则：按 `display N:` 分块，`brightness X` 行归属最近的块；选择顺序 **built-in → main → 第一个可读块**；某个屏不可读时 CLI 会把错误打到 stderr，stdout 里就没有对应的 brightness 行。格式依据上游源码 `brightness.c` 的 `ACTION_LIST` 分支与 README 示例 [S1]。
- 写：`brightness <0..1>`（默认作用于所有显示器）。注意上游 `main()` 即使个别屏幕失败也返回 0，错误只写 stderr，所以代码同时检查 `returncode != 0` 和 stderr 中是否含 `failed|unable|cannot|error`。
- 已知坑：**Homebrew 上的 brightness 曾经是旧版本、不支持 Apple Silicon**，需要源码编译（`make && sudo make install`）；上游 owner 在 issue #38 里确认“当前源码可以”。所以 CLI 只是兜底，不能当主方案 [S2]。
- 同 issue #38 还确认：内置屏 + LG UltraFine（Apple 外接）可读可写；Sidecar/iPad 屏、普通 HDMI/DP 外接屏读不到（错误 `unable to get brightness`）。

### 2.6 多显示器 / 外接屏限制

| 屏幕类型 | 本工具行为 | 说明 |
| --- | --- | --- |
| 笔记本内置屏 | ✅ 目标屏（`CGDisplayIsBuiltin` 优先） | 亮度可读可写（Apple Silicon 走 DisplayServices） |
| Apple 外接显示器（如 LG UltraFine） | 可能一起被调 | IOKit 路径会对所有可写 `IODisplayConnect` 设置；DisplayServices 路径只设内置屏。**两种路径行为不完全一致**，见 §7 R8 |
| 普通 HDMI/DP 外接屏 | ❌ 通常不支持 | 亮度走 DDC/CI，需要额外协议实现，本工具不做；上游 brightness 同样读不到 [S2] |
| Sidecar / iPad 作为副屏 | ❌ 不支持 | 上游 brightness issue #38 实测 `unable to get brightness` |
| 合盖模式（无内置屏） | 退到主屏（外接） | `CGDisplayIsBuiltin` 文档说明合盖时可能没有内置屏 → 代码自动退回主屏；外接屏大概率不支持 → `get_brightness` 返回 `None`，daemon 用 `fallback_restore_brightness` 恢复，调暗可能失败（`set_brightness` False → 日志报错、状态回滚） |

### 2.7 数值/范围/精度

- 底层 API 与 `brightness` CLI 都用 **0.0–1.0**；`Platform` 契约要求 0–100 int。`get_brightness()`：`round(level*100)`，越界视为无效并继续降级；`set_brightness()`：`clamp_percent()` 后 `/100.0`。
- 与系统 UI 滑块的刻度不是严格线性（Apple Silicon 上系统亮度到“用户亮度”的映射是非线性的）。**取整误差 ±1~2% 属正常**，对“调到最暗/拉满”这种场景无影响；如果靠 `set-brightness 50` 对齐系统 UI 的 50%，可能对不上。⚠️ 未实测。
- `_BRIGHTNESS_TOLERANCE = 0.06`（6 个百分点）用于 IOKit 写后读回判定，避免自动亮度微调造成误判。

---

## 3. 锁屏检测

### 3.1 方法

```bash
ioreg -n Root -d1 -a          # -a = XML plist；-n Root = 根 registry 项；-d1 = 只要根节点
```

`ioreg` 的 `-a` 把输出归档为 XML（`man 8 ioreg`）[S14]；`-n` 过滤名字、`-d` 限制遍历深度，`-n/-k/-l` 会触发打印匹配对象的属性。输出是 XML plist，`plistlib.loads()` 直接解析。

> “为什么不 `log show`”：`log show` 解析统一日志，秒级甚至更慢，还要处理大量无关输出；`ioreg` 是毫秒级系统调用包装。**这一点是常识性判断，没有专门来源**，但符合 `man ioreg` 对工具定位的描述。

代码里的容错（都写了注释）：

1. `ioreg` 退出码非 0 / 无输出 / XML 解析失败 → 返回 `None`（并记录 `_lock_reason`）。
2. **顶层可能是 dict，也可能是 array**：社区实测不同 macOS/机器上两种都出现过（macOS 26/27 上的 PR 明确写到 “`ioreg -a` 顶层数组·字典都来过，两种都接”）[S21]；因此 `_find_plist_value()` 在 dict/list 中深度 ≤5 搜索 `IOConsoleUsers`。
3. `IOConsoleUsers` 可能是数组（正常，多个登录会话）也可能是单个 dict（容错）。
4. **快速用户切换**：优先取 `kCGSSessionOnConsoleKey == True` 的会话条目；如果一个都没有，再看所有条目。避免“后台另一个用户锁屏”被误判成当前会话锁屏。
5. 值可能是 plist 的 `true/false`（bool）或整数 0/1；`_plist_bool()` 同时接受，其他类型视为“取不到”。

### 3.2 判定语义（重要，代码里也有注释）

| `IOConsoleUsers` 情况 | 返回值 | 理由 |
| --- | --- | --- |
| 任一候选条目 `CGSSessionScreenIsLocked == True` | `True` | 明确已锁 |
| 候选条目里该键存在且全为 False | `False` | 明确未锁 |
| 候选条目全都没有该键 | `False` | 见下 |
| `IOConsoleUsers` 缺失 / 空 / 解析失败 / ioreg 失败 | `None` | 无法判断，交给 daemon 的“未知就不动作”分支 |

**“键缺失按未锁屏”是刻意的语义选择**，不是疏忽：

- 社区多处记录：屏幕**解锁时该键通常不存在**，锁屏时才出现（例如 “screen LOCKED: ioreg carries `CGSSessionScreenIsLocked`; screen UNLOCKED: the key is absent”）[S22]。
- 若按 `None` 处理，则“解锁恢复亮度”永远不触发（daemon 只在 `locked is False` 时恢复），用户会被困在暗屏直到早上——体验更差。
- 若按 `False` 处理，最坏情况是“实际锁着但 key 没输出”时按未锁处理：不会调暗（少做一次暗屏），若已 dimmed 则恢复亮度（屏幕变亮，无损坏）。**误判“已锁屏”才是危险方向**（用户正在用电脑却被调暗），所以本实现选择“宁可信其未锁”。
- 如果未来 macOS 彻底不输出该键，症状是“不再自动调暗，但早上/解锁恢复仍正常”；真机验证时要专门看 `ioreg` 在锁/未锁两态的差异（§8 步骤 6）。

### 3.3 Apple Silicon 上的输出格式

- 现有 2026 年的社区实例显示 `ioreg -n Root -d1 -a` + `IOConsoleUsers` 在 Apple Silicon 上仍然可用：M1 Pro（OmacVM issue）、M4（fluxvm PR）、Mac mini（kakao-live PR）都直接读了该键 [S20][S21][S22]。**这是间接证据，不是 Apple 文档保证**，所以解析必须容错（已做）。
- 顶层 dict/array 的差异见上，代码两种都接受。
- 真机复核命令（§8 步骤 6）会直接打印两态差异；如果 Apple Silicon 上字段名/结构有变，改 `_locked_from_ioreg()` 一处即可。

### 3.4 Quartz 兜底（pyobjc）

- `CGSessionCopyCurrentDictionary()` 是 CoreGraphics 公开函数，返回“调用者的 window server 会话字典”，官方文档还说明“如果调用者不在 Quartz GUI 会话里或 window server 关闭则返回 NULL”，并要求用完后 release [S8]。
- 但 `CGSSessionScreenIsLocked` **不在** Apple 文档列出的 Window Server Session Properties 里 [S9]；社区问答也指出这个 key 在部分系统上取不到（Python 里 `KeyError`）[S6][S7]。所以它只能当兜底，且只在 **pyobjc 已安装**时可用（本项目不依赖 pyobjc，`import Quartz` 失败就返回 `None`）。
- 语义与 ioreg 一致：键缺失 → `False`；`session` 为 None → `None`。

### 3.5 其他方案（未采用）

- **分布式通知** `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked`（`NSDistributedNotificationCenter`）：可事件驱动、无需轮询，但需要 Cocoa 运行循环，且不同 macOS 版本通知名不稳定。本工具是 60s 轮询模型，用不上；如果以后要降低延迟可考虑。⚠️ 未实现/未实测。
- `log show`/`log stream`：太慢，不用于产品代码（调试 TCC 时才用，见 §5.5）。
- 屏幕睡眠（`CGDisplayIsAsleep`）≠ 锁屏：本工具只关心“锁屏”，不区分屏幕是否睡；锁屏后显示器可能先变黑，此时调亮度也没意义但无害。

---

## 4. LaunchAgent 安装方案

`scripts/install_macos.sh` 生成的 plist 关键字段：

| 键 | 值 | 用途/依据 |
| --- | --- | --- |
| `Label` | `com.lockbright.agent` | 唯一标识 |
| `ProgramArguments` | `[<python3 绝对路径>, <app>/run.py, run]` | 用绝对路径：launchd 的 PATH 很干净（见下） |
| `WorkingDirectory` | `<app>` | `run.py` 自己会把项目根插入 `sys.path`，但设了更稳 |
| `RunAtLoad` | `true` | 登录/加载即启动 |
| `KeepAlive` | `true` | 进程退出就重启；守护进程应该长期运行。注意 `KeepAlive` 隐含 `RunAtLoad` |
| `ThrottleInterval` | `10` | 崩溃循环时限速；`launchd.plist(5)` 说明默认就是“10 秒内不重复启动” |
| `ProcessType` | `Background` | 低优先级资源限制，减少对用户干扰；`launchd.plist(5)` 有 4 档（Background/Standard/Adaptive/Interactive） |
| `LimitLoadToSessionType` | `Aqua` | **必须是图形登录会话**：相机 TCC、亮度/WindowServer 都要用户的 Aqua 会话；`Background` 会话没有 GUI 上下文（也与社区“Background 会话下 TCC 不弹框”的报告一致 [S23]） |
| `EnvironmentVariables.PATH` | `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` | launchd 默认 PATH 很短；确保能找 Homebrew python 依赖需要的动态库/命令。**注意**：python 用的是绝对路径，PATH 主要给子进程（如 `ioreg`、`brightness` CLI）用 |
| `EnvironmentVariables.PYTHONUNBUFFERED` | `1` | 日志实时刷到文件 |
| `EnvironmentVariables.LOCKBRIGHT_HOME` | `<home>` | 与 `run.py`/`paths.py` 的 `LOCKBRIGHT_HOME` 覆盖机制对齐 |
| `StandardOutPath` / `StandardErrorPath` | `~/.lockbright/lockbright.log` | 任务要求；日志双写问题见 §1.3 |

加载命令与依据 [S14][S18]：

```bash
launchctl bootout gui/$(id -u)/com.lockbright.agent 2>/dev/null || true   # 旧的可能不存在
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lockbright.agent.plist
sleep 3
launchctl print gui/$(id -u)/com.lockbright.agent     # 看 state/pid/last exit code
```

- `launchctl` man page 的 domain 说明：`gui/<uid>` 是“按 GUI 登录用户定位的 login domain”的一种便捷写法；`bootout` 移除、`bootstrap` 加载；`print` 输出**没有 API 保证**（man page 明确警告不要解析），所以脚本只是 grep 出人类可读的 `state =`/`pid =` 供用户看，不依赖它做程序逻辑 [S18]。
- 需要用户已登录图形界面：`gui/$UID` 域只在有图形登录会话时存在。开机自动登录才可能“无人值守运行”；未登录时 LaunchAgent 不会加载（这符合预期，也意味着屏幕锁定但未登录/登录窗口状态下的行为需要在真机确认）。
- `KeepAlive=true` 下想停服务必须 `launchctl bootout`（否则 kill 后会被 launchd 拉起）；卸载脚本已处理。
- 老系统（< 10.10）没有 bootstrap/bootout：脚本里额外尝试了 `launchctl unload <plist>`（失败忽略），文档不承诺支持 10.10 以下版本（Python 3.9 本身也不支持）。
- **不要用 `sudo`/系统域**：root LaunchDaemon 无法访问用户摄像头（见 §5.1），也无法可靠控制用户会话显示器亮度。

### 4.1 选择 LaunchAgent 而不是 Login Item / SMAppService

- 本任务明确要求 LaunchAgent + `ProgramFiles` 方案，且不引入 Xcode/签名工程。
- `SMAppService` + `BundleProgram` 是 Apple 现在推荐的后台常驻方式（需要 app bundle、签名；见 §5.4 方案 B），可作为 TCC 问题出现后的升级路径。
- Login Item 适合 GUI app；对纯脚本需要 `.app` 包装，复杂度更高。

**安装/重新加载/卸载**：

```bash
bash scripts/install_macos.sh                       # 安装（幂等；重复运行会重启服务）
launchctl print gui/$(id -u)/com.lockbright.agent   # 查询
launchctl kickstart -k gui/$(id -u)/com.lockbright.agent   # 重启
bash scripts/uninstall_macos.sh                     # 卸载，保留 ~/.lockbright 配置/状态/日志
bash scripts/uninstall_macos.sh --purge             # 连 ~/.lockbright 一起删除
```

- 安装脚本的日志相关行为：plist 里 `StandardOutPath == StandardErrorPath == ~/.lockbright/lockbright.log`；安装完成后脚本会 `tail -n 15` 打印日志尾部，并用 `launchctl print` 的 `state =`/`pid =` 输出服务状态（只做人读展示，不依赖其格式）。
- 日志双写 quirk 见 §1.3；`run.py` 自己的 `RotatingFileHandler` 也会写同一个文件。

---

## 5. TCC 相机权限（本项目最大风险，重点）

### 5.1 有官方来源的事实

1. **macOS 10.14+ 相机/麦克风必须用户显式授权**；“系统要求 app 在 Info.plist 中提供静态说明字符串（`NSCameraUsageDescription`）”；**macOS 还要开启 `com.apple.security.device.camera` entitlement**；“app 必须在请求授权/使用采集设备之前同时具备 Info.plist 键和 entitlement，**否则系统会终止 app**”。— Apple AVFoundation 文档 [S10]
2. `NSCameraUsageDescription`：iOS 7+/macOS 10.14+ 的 property list key，“如果你的 app 使用访问摄像头的 API，这个键是必需的”。— Apple 文档 [S11]
3. macOS 上请求授权用 `AVCaptureDevice.authorizationStatus(for: .video)` / `requestAccess(for:completionHandler:)`；系统弹框只弹一次并记住选择；用户可在“系统设置 > 隐私与安全性 > 摄像头”改。— Apple 文档 [S10]
4. **launchd 的 agent/daemon 受 macOS 隐私保护约束**：`launchd.plist(5)` 的 CAVEATS 原文：“Daemons and agents managed by launchd are subject to macOS user privacy protections. Specifying privacy sensitive files and folders in a launchd plist may not have the desired effect, and may prevent the job from running.” [S14]
5. 用户侧开关：Apple 支持文档“Control access to the camera on Mac”（系统设置 > 隐私与安全性 > 摄像头）[S12]。
6. 授权记录按“负责进程/负责代码（responsible process / responsible code）”归属：从 Terminal 前台启动的 CLI，相机请求记在 **Terminal** 名下（因此 Terminal 的相机权限覆盖其子进程）；从 launchd 启动的裸二进制没有 GUI app 祖先，归属到该可执行文件自身（按路径记账）。— 这是社区/desk research 的总结（见 5.2 的来源与置信度），Apple 官方文档没有一句“CLI 在 launchd 下如何归属”的完整说明。

### 5.2 后台/LaunchAgent 下的现实（含置信度）

| 结论 | 来源 | 置信度 |
| --- | --- | --- |
| 没有 `NSCameraUsageDescription` 的宿主（app / 解释器）请求相机时，TCC 可能**静默拒绝、完全不弹框**；进程表现为打开相机失败 | 社区 issue：Claude Code 桌面端（"macOS refuses silently and never prompts"；其会话进程树挂在 Background launchd manager 下，且 "there is also no GUI session for a prompt to appear in"）[S23]；FactoryFloor issue（“macOS attributes the permission request to the host app, not the embedded terminal”，缺 key → 静默拒绝）[S24] | ✅（社区报告，与我们场景高度相似） |
| 裸**签名**二进制在普通 launchd agent 下**可能**弹框，prompt 显示可执行文件名，授权按路径记账；但 root daemon 完全不能用相机 | 第三方 desk research（明确标注置信度“中”，引 Apple TN3179/TN3127、WWDC24 10123、DTS 论坛）[S25] | ❓（desk research 的“中”置信度） |
| SMAppService agent 归属到包含它的签名 app（“responsible code”），prompt 显示 app 名、使用 app Info.plist 里的 usage string，app 需要 hardened runtime 的相机 entitlement | 同上 [S25] | ❓（desk research） |
| 相机授权按用户持久化，绑定 designated requirement（Team ID + bundle ID）；**ad-hoc 签名每次构建都会重新弹框**；移动可执行文件会重新弹框 | 同上 [S25] | ❓ |
| MDM 可以**拒绝**但**不能预先授予**相机；`tccutil` 只能 reset/重置，不能授予 | 同上 [S25]；`tccutil` 行为（man/常识） | ✅/❓ |
| 本项目 `run.py probe` 在 Terminal 前台跑：相机请求归属 Terminal，Terminal 第一次会弹“Terminal 想访问摄像头” | Apple 文档 TCC 机制 [S10] + Terminal 归属结论 [S23][S24][S25]；imagesnap README 也说明第一次用 CLI 会弹框授权 [S26] | ✅（机制）/⚠️（我们的具体流程未实测） |

**对我们这个 python + Homebrew python 的判断（❓推测，需真机验证）**：

- LaunchAgent 直接跑的 `<python3> run.py run`：没有 app bundle、没有 `NSCameraUsageDescription`（Homebrew Python 可执行文件是 ad-hoc 签名，不带相机 usage string），且 launchd 进程没有 GUI app 祖先 → 大概率**不弹框、静默拒绝**（与 Claude Code 的报告同型）。
- 如果在 Terminal 里先 `probe` 授权成功，**不能假定 LaunchAgent 里的 python3 继承这个授权**：负责进程不同（Terminal vs python3 自身）。
- 因此产品上必须准备兜底路径（5.4），安装脚本要在最后明确告诉用户这一点。

### 5.3 推荐用户流程（已写进 install 脚本输出）

1. **先在前台 Terminal 跑一次探测**（会亮一下摄像头指示灯）：
   ```bash
   cd "$HOME/Library/Application Support/LockBright/app"
   "$(which python3)" run.py probe
   ```
   出现“Terminal 想要访问摄像头” → 允许。看到每个 index 的亮度读数、截图保存到 `~/.lockbright/probe/`。
   - 没弹框/被拒：系统设置 → 隐私与安全性 → 摄像头，勾选 Terminal；仍不行先 `tccutil reset Camera com.apple.Terminal` 再跑。
2. **再让 LaunchAgent 重启并观察日志**：
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.lockbright.agent
   tail -f ~/.lockbright/lockbright.log
   ```
   守护进程只在“锁屏 + 夜间 + 需要判断”时才开相机，所以可能要等锁屏后才看到相机日志；想快速验证可临时把 `config.json` 的 `night_start` 改早、`check_interval_seconds` 改小，验证完改回。
3. **如果 LaunchAgent 下相机打不开（最可能的情况）**：用 5.4 的兜底方案，并把结论反馈给项目（真机验证记录）。

### 5.4 失败后的替代方案（按推荐顺序）

| 方案 | 做法 | 优点 | 缺点/置信度 |
| --- | --- | --- | --- |
| **A. 前台 Terminal 运行**（最稳） | 晚上在 Terminal 里 `"$PY" "$APP_DIR/run.py" run`；Terminal 已有相机权限。可配合 Terminal 的“登录时打开”或手动启动 | 确定能拿到相机权限（Terminal 已授权）；调试直观 | 要留窗口、需人工/登录项自启；**⚠️ 未实测** |
| **B. 包装成 `.app` + 登录项/LaunchAgent 跑 bundle 内可执行文件**（最接近原生） | 建最小 bundle：`LockBright.app/Contents/Info.plist` 加 `NSCameraUsageDescription`、`CFBundleIdentifier`（如 `com.lockbright.agent`）、`LSUIElement=true`；`Contents/MacOS/LockBright` 是启动 python 的 shell 脚本（或直接让 LaunchAgent 的 `ProgramArguments` 指向 bundle 内可执行文件）。先手动双击运行一次完成授权。签名：`codesign --force --deep -s - LockBright.app`（ad-hoc；每次改动会重新弹框，稳定后可 Developer ID 签名） | 有 app 身份，TCC prompt 可正常弹；可放登录项/SMAppService | 需要手动建 bundle，**未实测**；shell 脚本作为主可执行文件是否被 TCC 当作 bundle 身份、`LSUIElement` 下 prompt 是否可见，都要真机验证 |
| **C. LaunchAgent 让 Terminal 来跑脚本** | LaunchAgent 执行 `open -a Terminal "$APP_DIR/start-lockbright.command"`，脚本里 `exec "$PY" run.py run`；相机请求归属 Terminal（已授权） | 不需要 .app，复用方案 A 的授权 | 会弹出 Terminal 窗口；`open -a Terminal` 从 launchd 调用是否可靠、Terminal 被关掉进程是否退出，**未实测** |
| **D. 手动把 python 解释器加进相机权限列表** | 系统设置 → 隐私与安全性 → 摄像头 → “+”，Cmd+Shift+G 输入 `/opt/homebrew/bin/python3`（或框架内真实路径） | 不用改启动方式 | 等于**给所有 python 脚本**开放摄像头，安全上不推荐；TCC 是否按解释器路径生效**未实测** |
| ❌ 不推荐 | 关闭 SIP / 直接改 TCC.db / 用 root daemon 绕过 | — | 破坏系统安全、升级失效；Apple 明确不支持 |

> 如果最终走 B/C 方案，安装脚本可以扩展（当前版本只提示，不自动建 .app，因为该方案未在真机验证，先不引入未测代码）。

### 5.5 调试 TCC 的常用命令

```bash
# 看 TCC 相关系统日志（调试用，产品代码不用 log show）
log stream --predicate 'subsystem == "com.apple.TCC"' --info

# 重置某个 app 的相机授权，让下次重新弹框（Terminal 为例）
tccutil reset Camera com.apple.Terminal

# 看当前哪些 app 有相机权限（没有官方 CLI，只能看系统设置 UI；TCC.db 受 SIP 保护）
# 系统设置 > 隐私与安全性 > 摄像头

# 前台验证摄像头（OpenCV 层面的报错会更明确一些）
python3 -c "import cv2; c=cv2.VideoCapture(0, cv2.CAP_AVFOUNDATION); print('opened', c.isOpened()); c.release()"
```

OpenCV 的 macOS 后端本身也会在拒绝时打印提示。OpenCV 4.x 源码里有这段逻辑：检查 `AVCaptureDevice authorizationStatus`，denied 时提示 “Either run 'tccutil reset Camera' command … or modify 'System Preferences -> Security & Privacy -> Camera' settings for your application”；未授权且 `OPENCV_AVFOUNDATION_SKIP_AUTH` 未设置时会调用 `requestAccessForMediaType` 并短暂跑 RunLoop 尝试弹框（主线程时）。— 来源：OpenCV 4.x `cap_avfoundation_mac.mm` [S27]。**这条对理解“为什么从 Terminal 跑 probe 能弹框”很重要：OpenCV 自己会请求授权，是否弹框取决于 TCC 对负责进程的判定。**

### 5.6 锁屏期间到底能不能用相机？（⚠️ 未实测、高风险）

- 我们的核心场景是**锁屏后**用相机测光。macOS 的屏幕锁定（loginwindow）不会挂起/杀掉用户进程，理论上进程继续运行；TCC 授权在锁屏期间是否仍允许相机采集，**没有找到权威文档**。
- 间接证据：有 macOS 监控/安防类项目把“锁屏监控”当卖点（AutoCamera 等 [S28]），说明“后台进程 + 锁屏时读相机”在实践中可行；但没找到 Apple 官方保证。
- **这是上 Mac 后必须最先验证的第 2 件事**（§8 步骤 6）：锁定屏幕 → 等待/手动触发一次 tick → 看日志里 luma 是否正常、有没有 `is_locked=True`、相机是否报错。如果锁屏期间相机被系统拒绝，整个产品逻辑需要改（例如只在“锁屏但屏幕未睡”时测光，或改用其他传感器/键盘灯等）。
- 另一层风险：**锁屏后显示器可能很快就会睡眠**，此时屏幕本来就是黑的，调亮度无意义；本工具调暗只影响“锁屏但屏幕未睡”的窗口期。文档不承诺“屏幕睡眠时也能调暗”。

---

## 6. OpenCV/AVFoundation 手动曝光：核实 维护者 的假设（专节）

> 背景：维护者 在 `lb/camera.py` 的 `_manual_exposure_values()` 里按平台给常量：
> - Windows/DirectShow：手动 `CAP_PROP_AUTO_EXPOSURE=0.25`、自动 `1.0`、`CAP_PROP_EXPOSURE=-6`；
> - **macOS/AVFoundation：手动 `0.0`、自动 `1.0`（维护者 按 `AVCaptureExposureMode` locked=0/auto=1 猜）；`CAP_PROP_EXPOSURE=-6.0`**；
> - Linux/V4L2：1=手动、3=自动。
> 维护者 要求核实 macOS 的语义。以下结论带「未实测但源码可证」标注：我们仍然没在 Mac 上跑过，
> 但 OpenCV 官方源码是确定的，不依赖猜测。**维护者 已确认：README 会据此修改，`camera.py` 不改。**

### 6.1 核实结论

1. **`AVCaptureExposureMode` 的枚举值本身是对的**：`Locked=0`、`AutoExpose=1`、`ContinuousAutoExposure=2`（Apple 文档 [S29]；OpenCV 源码里也把这个枚举注释在 `cap_avfoundation.mm` 里）。
2. **但 OpenCV 4.x 的 macOS/AVFoundation 后端根本不处理 `CAP_PROP_AUTO_EXPOSURE` 和 `CAP_PROP_EXPOSURE`**：
   - 4.x 的 macOS 后端源码 `modules/videoio/src/cap_avfoundation_mac.mm`：`getProperty` 只处理 `CAP_PROP_FRAME_WIDTH/HEIGHT/FPS/FORMAT`；`setProperty` 只处理 `CAP_PROP_POS_MSEC/POS_FRAMES/POS_AVI_RATIO/FORMAT`。**整个文件没有任何 exposure 相关代码**（已下载源码逐行核对）。
   - OpenCV 5.x 合并后的 `cap_avfoundation.mm` 里只有 iOS 用的 `CAP_PROP_IOS_DEVICE_EXPOSURE`（常量值 9002）会映射到 `AVCaptureDevice.exposureMode`；同样**没有** `CAP_PROP_AUTO_EXPOSURE`/`CAP_PROP_EXPOSURE`。而 `requirements.txt` 是 `opencv-python>=4.8`（4.x 线），所以 Mac 用户实际拿到的是 4.x 行为。
   - 结果：`cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.0)` 与 `cap.set(cv2.CAP_PROP_EXPOSURE, -6.0)` 在 macOS 上**返回 false 并被忽略**（`setProperty` 的 `default: return false`）。
3. **`CAP_PROP_EXPOSURE` 的单位问题在 macOS 上没有实际意义**：OpenCV 官方头文件对它的注释只有一句 “Exposure (only for cameras)”，单位/语义由各 backend 自己决定（例如 DirectShow 是 log2 秒、V4L2 是绝对时间单位——这两个是社区常识，本文件不展开）；macOS AVFoundation 后端没有实现，因此 `-6.0` 不会被解释成任何东西。
4. **`CAP_PROP_AUTO_EXPOSURE` 在 macOS 上也无法锁定曝光**：即使通过 `CAP_PROP_IOS_DEVICE_EXPOSURE`（仅 5.x/iOS，且 9002 是 OpenCV 给 iOS 的私有常量）把 `exposureMode` 设成 locked，也只是“锁住当前自动曝光算出来的值”，不能指定固定短曝光时间；要真正设置 `duration/ISO` 必须走 pyobjc 的 `setExposureModeCustom(duration:iso:completionHandler:)`（Apple 文档 [S29]），而本项目禁止强依赖 pyobjc。

### 6.2 对本项目的影响与建议

- **代码不用改**：`_enable_manual_exposure()` 在 macOS 上两步 `cap.set` 都返回 false → 返回 false → `measure_luma()`/`probe_cameras()` 自动回退 auto 曝光，并打一次 warning（`"摄像头不支持手动曝光…回退自动曝光；暗/亮阈值需要按 probe 的实测值调整"`）。行为安全，不会让 daemon 崩。
- **`camera.py` 的 darwin 分支保持无害**（维护者 问）：该分支返回的 `(0.0, 1.0)` 只被用来调 `cap.set(CAP_PROP_AUTO_EXPOSURE, …)`；在 OpenCV 4.x macOS 后端上这些调用返回 false 且无副作用，`_enable_manual_exposure()` 的 `ok_auto and ok_exp` 逻辑因此返回 false（不会被误判成“手动曝光成功”），`_restore_auto_exposure()` 同样 no-op。所以即使 darwin 分支永远不会生效，保留它也不会影响任何行为，**不必修改**。
- **产品层面必须注意**：Windows 上“自动曝光会把黑房间拉亮（auto 70~85 vs 手动 -6 时 0~11）”的问题，**在 macOS 上同样存在且无法用 OpenCV 规避**。所以 Mac 用户必须用 `run.py probe` 的实测值校准 `dark_luma_threshold` / `restore_luma_threshold`：
  - 在**关灯、只留屏幕背光/月光**的夜间环境跑 `probe`，记下**自动曝光**的亮度读数（`camera.py` 内部字段 `auto_luma`；Mac 上 `manual_ok=false`、`manual_luma=null`，所以“手动”那列没有值）；
  - 再在开灯环境跑一次，记下同样的自动曝光读数；
  - `dark_luma_threshold` 取“关灯值 + 一点余量”，`restore_luma_threshold` 取“开灯值 - 一点余量”，保证两态可区分。
  - 如果两个值太接近（自动曝光把暗环境拉得和亮环境差不多），说明这台 Mac 的相机自动曝光无法区分，本工具在该机器上“关灯检测”不可靠——这是硬件/驱动限制，不是配置能完全解决的。⚠️ 未实测，需真机确认。
- **README 建议不要承诺“macOS 会锁定手动短曝光”**；可以说“Mac 上依赖自动曝光 + probe 校准”。
- 如果以后一定要 Mac 精确测光：可选方案是给 `.app`（方案 B）加 pyobjc，直接调 `AVCaptureDevice` 的 `setExposureModeCustom`；这属于后续增强，需重新做依赖与 TCC 设计。⚠️ 未实现。

### 6.3 来源

- OpenCV 4.x macOS 后端源码（无 exposure）：`https://github.com/opencv/opencv/blob/4.x/modules/videoio/src/cap_avfoundation_mac.mm` [S27]
- OpenCV 5.x 合并后端（只有 `CAP_PROP_IOS_DEVICE_EXPOSURE`）：`https://github.com/opencv/opencv/blob/5.x/modules/videoio/src/cap_avfoundation.mm` [S27]
- Apple `AVCaptureExposureMode` / `setExposureModeCustom(duration:iso:completionHandler:)`：[S29]
- OpenCV 官方头文件 `videoio.hpp` 中 `CAP_PROP_EXPOSURE` 的注释（无统一单位）：同 4.x 源码仓库 `modules/videoio/include/opencv2/videoio.hpp` [S27]

---

## 7. 与 Windows 实现的差异

| 方面 | Windows（维护者 实现，已实测） | macOS（本实现，未实测） |
| --- | --- | --- |
| 亮度 API | `root\WMI` 的 `WmiMonitorBrightness` / `WmiMonitorBrightnessMethods.WmiSetBrightness`（PowerShell 子进程） | IOKit `IODisplay*`（ctypes）→ DisplayServices 私有 SPI → CoreDisplay SPI → `brightness` CLI |
| 读亮度 | WMI 直接给 0–100 | 底层 0.0–1.0 → round 成 0–100 |
| 外接显示器 | 一般不支持（WMI 只管内置面板） | 一般不支持（DDC 需额外实现）；设置 IOKit 路径时可能连带支持 Apple 外接屏 |
| 锁屏检测 | `OpenInputDesktop` + `GetUserObjectInformationW(UOI_NAME)`（`Default` vs `Winlogon`），兜底 LogonUI.exe | `ioreg -n Root -d1 -a` 的 `IOConsoleUsers[].CGSSessionScreenIsLocked`；兜底 pyobjc Quartz |
| 锁屏判定性能 | Win32 调用，微秒级 | `ioreg` 子进程，毫秒级（每 tick 一次可接受；不会用 `log show`） |
| 相机权限 | Windows“相机访问”系统开关 + 桌面 app 隐私设置；后台进程通常能开（已验证） | **TCC per responsible process**，LaunchAgent 下可能静默拒绝（本项目最大差异/风险） |
| 自启动 | 计划任务（`install_windows.ps1`）+ `CREATE_NO_WINDOW` 避免弹窗 | LaunchAgent（`~/Library/LaunchAgents` + `launchctl bootstrap gui/$UID`） |
| 权限/管理员 | 不需要管理员（WMI 亮度普通用户可写；已验证） | 不需要 sudo；但需要**图形登录会话**（`gui/$UID`），且相机需要用户 TCC 授权 |
| 手动曝光 | DirectShow 支持，已实测可用（`CAP_PROP_AUTO_EXPOSURE=0.25/1.0`、`CAP_PROP_EXPOSURE=-6`） | OpenCV **不支持** → 永远回退 auto 曝光（§6） |
| 进程生命周期 | 计划任务（或 pythonw） | launchd `KeepAlive=true`，崩溃自动重启；停止用 `bootctl/launchctl bootout` |
| 日志路径 | `~/.lockbright/lockbright.log`（Windows 用户目录） | `~/.lockbright/lockbright.log` + launchd 重定向（双写问题见 §1.3） |
| 失败语义 | `None`/`False` + `last_error`（同契约） | 同契约；额外注意“IOKit 返回成功但实际没生效”→ 读回校验后降级 |

---

## 8. 用户完整步骤（Mac）

> 前提：一台 Apple Silicon 或 Intel Mac，macOS 11+（建议 12+），能登录图形界面。

### 8.1 安装 Python 与依赖

```bash
# 方式 1：Homebrew（推荐）
brew install python@3.12
# 方式 2：python.org 安装包（注意与 Homebrew 的路径不同）

# 安装 OpenCV（注意 Homebrew Python 有 PEP 668 限制，建议 venv）
python3 -m venv ~/lockbright-venv
~/lockbright-venv/bin/python3 -m pip install --upgrade pip
~/lockbright-venv/bin/python3 -m pip install -r /path/to/lockbright/requirements.txt
```

- Homebrew Python 直接 `pip3 install` 可能报 `externally-managed-environment`（PEP 668）[S30]；安装脚本检测到没装 cv2 时会提示用 venv 并把 `PYTHON_BIN` 指到 venv 的 python。
- LaunchAgent 里用的是这个解释器的**绝对路径**；升级/移动 Python（含重建 venv）会让 TCC 相机授权失效并需要重跑安装脚本。

### 8.2 前台探测（同时完成 Terminal 的相机 TCC 授权）

```bash
cd /path/to/lockbright
python3 run.py probe          # 或 ~/lockbright-venv/bin/python3 run.py probe
```

- 首次会弹“Terminal 想要访问摄像头” → 允许（不给就会在 probe 里看到相机打不开）。
- probe 会打印：平台/亮度/锁屏状态、每个摄像头 index 的开流结果与**自动曝光**亮度、截图路径（`~/.lockbright/probe/`）。
- 记下 Mac 上推荐 `camera_index`，以及“关灯/开灯”两种环境的自动曝光读数用于校准阈值（§6.2）。`camera.py` 内部字段叫 `auto_luma`；`run.py probe` 当前如何展示/命名这些字段由 维护者 的 CLI 决定（`run.py` 正在对接新的 camera.py，以它的实际输出为准）。
- Mac 上手動曝光不可用（§6），probe 里 `manual_ok=false`、`manual_luma=null` 是**正常现象**，不是 bug；不要因为“手动曝光列没值”以为 probe 失败。
- 同时验证亮度/锁屏 API：
  ```bash
  python3 run.py set-brightness 30 && python3 run.py status   # 再 set-brightness 100 恢复
  python3 -m lb.platform_mac                                  # 直接看 MacPlatform 的读数/错误
  ```

### 8.3 安装 LaunchAgent

```bash
bash scripts/install_macos.sh
# 或用 venv 的解释器：
PYTHON_BIN=~/lockbright-venv/bin/python3 bash scripts/install_macos.sh
```

- 脚本会：检查 Python/OpenCV → 复制到 `~/Library/Application Support/LockBright/app` → `run.py init` 生成默认配置 → 写 `~/Library/LaunchAgents/com.lockbright.agent.plist` → `launchctl bootout` 旧任务 → `bootstrap gui/$UID` → 等 3 秒 → `launchctl print` 看状态 → 打印日志尾部与 TCC 授权提醒。
- `APP_DIR` 可覆盖（测试用）；`DRY_RUN=1` 只打印不落盘；`SKIP_PLATFORM_CHECK=1` 用于非 Mac 静态检查。

### 8.4 验证

```bash
launchctl print gui/$(id -u)/com.lockbright.agent | grep -E 'state|pid|last exit'
tail -f ~/.lockbright/lockbright.log
/usr/libexec/PlistBuddy -c "Print :IOConsoleUsers:0:CGSSessionScreenIsLocked" /dev/stdin <<< "$(ioreg -n Root -d1 -a)" || echo "键不存在（可能未锁屏）"
```

- 解锁状态：日志里应出现 `锁屏=False`、亮度读数正常；不会调暗。
- 锁屏后：日志出现 `locked=True`，夜间 + 关灯时（连续 `dark_confirm_samples` 次）出现“调暗屏幕”动作；开灯/解锁后恢复。
- 相机在 LaunchAgent 下打不开时，按 §5.4 的方案 A/B/C 处理。

### 8.5 卸载

```bash
bash scripts/uninstall_macos.sh            # 停服务、删 plist 和 app 副本，保留 ~/.lockbright
bash scripts/uninstall_macos.sh --purge    # 连配置/状态/日志一起删
```

---

## 9. 上 Mac 后最先要验证的 3 件事（按优先级）

1. **LaunchAgent 下相机能不能用（TCC）**：装好后锁屏/夜里看日志；如果被静默拒绝，立即按 §5.4 走兜底，并把结论写回本文件。**这一条决定架构是否需要加 .app 包装。**
2. **Apple Silicon 上亮度能不能真正改**：`python3 -m lb.platform_mac set 30` 后看屏幕是否变暗；如果 IOKit 失败但 DisplayServices 成功，日志（debug）里会显示“通过 DisplayServices 设置亮度”。同时验证 `get_brightness` 读回值是否跟随系统滑块。若 `set_brightness` 返回 True 但屏幕没变，检查 `_verify_level()` 是否误判（调 `_BRIGHTNESS_TOLERANCE` 或调整顺序，把 DisplayServices 提为第一优先）。
3. **锁屏期间相机/亮度设置是否被允许**：锁屏后手动触发一次 tick（或等日志），确认 `is_locked=True`、camera luma 正常、`set_brightness` 在锁屏状态下也生效；并确认“锁屏但屏幕未睡”的窗口期存在（否则调暗对用户没有意义）。

附：拿到 Mac 后请顺手收集这些诊断信息（发回即可判断问题）：
```bash
uname -m; sysctl -n machdep.cpu.brand_string; sw_vers
system_profiler SPDisplaysDataType | head -40
ioreg -n Root -d1 -a | head -40
python3 -V; python3 -c "import cv2; print(cv2.__version__, cv2.getBuildInformation()[:0])"
python3 -m lb.platform_mac
```

---

## 10. 参考来源

按引用编号（`[Sx]`）列出；链接均为调研时实际访问/核对过的页面（访问时间 2026-10-21）。

- **[S1]** nriley/brightness（macOS CLI 亮度工具，开源 C 实现）
  - 源码：https://github.com/nriley/brightness/blob/master/brightness.c
  - README：https://github.com/nriley/brightness/blob/master/README.md
  - M1 支持 PR #36：https://github.com/nriley/brightness/pull/36
  - M1 失败/版本问题 issue #38：https://github.com/nriley/brightness/issues/38
  - 10.12.4+ 未公开方法 issue #21：https://github.com/nriley/brightness/issues/21
- **[S2]** 同 [S1] 的 issue #38 评论区（M1 报 `-536870201`、Homebrew 版本过旧、外接屏/Sidecar 读不到、内置屏 + LG UltraFine 可读等实测）。
- **[S3]** StackOverflow: “Get Display Brightness”（IOKit `IOServiceGetMatchingServices` + `IODisplayGetFloatParameter` 的 Objective-C/Swift 写法；M1 Pro 用 DisplayServices 的回答）
  - https://stackoverflow.com/questions/28818993/get-display-brightness
- **[S4]** StackOverflow: “Calling function with ctypes or pyObjc”（IOKit `IODisplayGetFloatParameter` 的 ctypes/pyobjc 元数据）
  - https://stackoverflow.com/questions/51862518/calling-function-with-ctypes-or-pyobjc
- **[S5]** StackOverflow: “IODisplayConnect is gone in Big Sur of Apple Silicon, what is the replacement?”（DisplayServices 私有 API、`corebrightnessdiag` 说明）
  - https://stackoverflow.com/questions/65150131/iodisplayconnect-is-gone-in-big-sur-of-apple-silicon-what-is-the-replacement
- **[S6]** StackOverflow: “Detecting lock screen on Mac through Python3”（pyobjc `CGSessionCopyCurrentDictionary` 的 `KeyError` 例子）
  - https://stackoverflow.com/questions/52750812/detecting-lock-screen-on-mac-through-python3
- **[S7]** StackOverflow: “Swift: How to observe if screen is locked in macOS”（`CGSessionCopyCurrentDictionary` + `CGSSessionScreenIsLocked`）
  - https://stackoverflow.com/questions/54346761/swift-how-to-observe-if-screen-is-locked-in-macos
  - 以及 “Querying whether a mac is in the locked state using Objective-C”（指出 `CGSSessionScreenIsLocked` 不在官方文档的会话字典键里）：https://stackoverflow.com/questions/76193081/querying-whether-a-mac-is-in-the-locked-state-using-objective-c
- **[S8]** Apple Developer Documentation: `CGSessionCopyCurrentDictionary()`
  - https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()
- **[S9]** Apple Developer Documentation: Window Server Session Properties
  - https://developer.apple.com/documentation/coregraphics/window-server-session-properties
- **[S10]** Apple Developer Documentation: “Requesting authorization to capture and save media”（macOS 10.14+ 相机/麦克风授权、需 Info.plist key + entitlement、否则系统终止 app）
  - https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media
- **[S11]** Apple Developer Documentation: `NSCameraUsageDescription`
  - https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription
- **[S12]** Apple Support: “Control access to the camera on Mac”
  - https://support.apple.com/guide/mac-help/control-access-to-your-camera-mchlf6d108da/mac
- **[S13]** Apple Developer Documentation: “Requesting Authorization for Media Capture on macOS”
  - https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos
- **[S14]** `launchd.plist(5)` man page（含 CAVEATS：launchd agent 受用户隐私保护约束）
  - https://keith.github.io/xcode-man-pages/launchd.plist.5.html
- **[S15]** Apple Developer Documentation: `CGMainDisplayID()`
  - https://developer.apple.com/documentation/coregraphics/cgmaindisplayid()
- **[S16]** Apple Developer Documentation: `CGDisplayIsBuiltin(_:)`
  - https://developer.apple.com/documentation/coregraphics/cgdisplayisbuiltin(_:)
- **[S17]** Apple Developer Documentation: `CGGetOnlineDisplayList(_:_:_:)`
  - https://developer.apple.com/documentation/coregraphics/cggetonlinedisplaylist(_:_:_:)
- **[S18]** `launchctl(1)` man page（domain 概念、bootstrap/bootout/print/kickstart、print 输出不保证稳定）
  - https://keith.github.io/xcode-man-pages/launchctl.1.html
- **[S19]** Apple Developer Documentation: `SMAppService`
  - https://developer.apple.com/documentation/servicemanagement/smappservice
- **[S20]** GitHub: OmacVM issue #331（macOS 27 / M1 Pro 上 LaunchAgent/TCC/权限诊断的实测记录）
  - https://github.com/gillesgoetsch/OmacVM/issues/331
- **[S21]** GitHub PR：kakao-live #2（实测 “`ioreg -a` 顶层可能是数组也可能是字典，两种都要接”）
  - https://github.com/yoonjechoi/kakao-live/pull/2
  - 以及 zyvor-fluxvm PR #434（M4 上 `ioreg -n Root -d1` 读 `CGSSessionScreenIsLocked`；`IOConsoleLocked` 不可靠）
  - https://github.com/zyvorai/zyvor-fluxvm/pull/434
- **[S22]** GitHub issue：overture #3548（锁屏时 ioreg 带 `CGSSessionScreenIsLocked`，未锁屏时“key is absent”）
  - https://github.com/danwright32/overture/issues/3548
  - 以及 arXMCP #493（同类记录）：https://github.com/chris-dare-dev/arXMCP/issues/493
- **[S23]** GitHub issue：anthropics/claude-code #97968（无 `NSCameraUsageDescription` → macOS 静默拒绝、不弹框；进程树在 Background launchd manager 下、无 GUI session 可弹框）
  - https://github.com/anthropics/claude-code/issues/97968
- **[S24]** GitHub issue：alltuner/factoryfloor #167（TCC 把权限请求归属到宿主 app；缺 Info.plist key → 静默拒绝；Ghostty 等终端在 Info.plist 声明所有隐私 key 的做法）
  - https://github.com/alltuner/factoryfloor/issues/167
- **[S25]** GitHub：tatolab/streamlib #2560 的 desk research 评论（SMAppService agent / 裸签名二进制在 launchd 下的 TCC 归属、prompt 命名、授权持久化、ad-hoc 重弹、root daemon 不能用相机、MDM 只能 deny；作者标注了置信度并引 Apple TN3179/TN3127、WWDC24 10123）
  - https://github.com/tatolab/streamlib/issues/2560#issuecomment-5941930396
- **[S26]** imagesnap README（macOS 命令行相机工具：第一次使用会弹相机授权框）
  - https://github.com/rharder/imagesnap
- **[S27]** OpenCV 源码
  - 4.x macOS AVFoundation 后端（无 exposure 支持）：https://github.com/opencv/opencv/blob/4.x/modules/videoio/src/cap_avfoundation_mac.mm
  - 5.x 合并后端（只有 `CAP_PROP_IOS_DEVICE_EXPOSURE`）：https://github.com/opencv/opencv/blob/5.x/modules/videoio/src/cap_avfoundation.mm
  - `videoio.hpp` 中 `CAP_PROP_EXPOSURE` 常量（注释无单位说明）：https://github.com/opencv/opencv/blob/4.x/modules/videoio/include/opencv2/videoio.hpp
- **[S28]** AutoCamera（Windows/macOS 摄像头监控工具，macOS 用 `.app` + LaunchAgent、首次运行需在系统设置里授权摄像头——作为“后台相机 + 锁屏监控”的社区先例）
  - https://github.com/blktea814/AutoCamera
- **[S29]** Apple Developer Documentation: `AVCaptureDevice` exposure
  - `setExposureModeCustom(duration:iso:completionHandler:)`：https://developer.apple.com/documentation/avfoundation/avcapturedevice/setexposuremodecustom(duration:iso:completionhandler:)
  - `AVCaptureExposureMode`（`exposureMode` 属性页）：https://developer.apple.com/documentation/avfoundation/avcapturedevice/exposuremode
- **[S30]** Python Packaging: PEP 668（externally-managed-environment）/ Homebrew Python 文档
  - https://peps.python.org/pep-0668/
  - https://docs.brew.sh/Homebrew-and-Python
- **[S31]** `ioreg(8)` man page（`-a` XML、`-n`、`-d` 语义）
  - https://keith.github.io/xcode-man-pages/ioreg.8.html
- **[S32]** Python 标准库文档：`plistlib`、`ctypes`
  - https://docs.python.org/3/library/plistlib.html
  - https://docs.python.org/3/library/ctypes.html

> 说明：[S23]–[S25] 是社区/第三方资料，不是 Apple 官方承诺；引用它们是因为“CLI + launchd + TCC”这个组合 Apple 没有公开完整文档，而这些记录与我们的场景高度一致。已在 §5 标注置信度。

---

## 11. 风险与未实测清单（真机验证用）

| ID | 风险/未实测项 | 影响 | 如何验证/兜底 |
| --- | --- | --- | --- |
| **R1** | Apple Silicon 上 IOKit `IODisplayConnect` 亮度不可用，实际依赖私有 `DisplayServices` | 若 DisplayServices 符号/行为在新系统变化 → 亮度不可控 | `python3 -m lb.platform_mac set 30` 看屏幕；看 debug 日志走的哪条路径；兜底：brew `brightness` CLI、或升级到 DisplayServices 第一优先 |
| **R2** | IOKit `IODisplaySetFloatParameter` 在 macOS 10.12.4+ 可能返回成功但被系统覆盖 | 误报成功、屏幕不变 | 已做读回校验（`_verify_level`）；真机验证 Intel 机型时重点看 |
| **R3** | **LaunchAgent 下相机 TCC 静默拒绝**（本项目最大风险） | 核心测光功能不可用 | §5.3/§5.4；真机必须先验证；兜底方案 A/B/C |
| **R4** | 锁屏期间相机/亮度设置是否被 macOS 允许 | 核心场景可能不可行 | §5.6 / §9 第 3 项；锁屏后手动触发一次 tick 看日志 |
| **R5** | `ioreg` 输出结构在 Apple Silicon/新系统变化（顶层 dict vs array、键缺失语义） | 锁屏状态误判为未知/未锁 | 代码已容错；真机在锁/未锁两态各跑一次 `ioreg` 对比；必要时只改 `_locked_from_ioreg()` |
| **R6** | `CGDisplayIsBuiltin`/主屏选择在多显示器、合盖模式下不符合预期 | 调错屏/调了个不支持的外接屏 | 真机用 `system_profiler SPDisplaysDataType` + debug 日志确认 target display id；多屏用户可后续加配置项 |
| **R7** | Mac 无手动曝光，自动曝光会把黑房间拉亮 | `dark_luma_threshold` 失效、关灯检测不到 | §6.2 probe 校准；两态太接近则说明该机器不可靠 |
| **R8** | IOKit 路径会对所有可写 `IODisplayConnect` 设置（可能连带 Apple 外接屏），DisplayServices 只设内置屏 → 两条路径行为不一致 | 用户外接 Apple 显示器时亮度行为不一致 | 真机有外接屏时验证；后续可统一为“只设内置屏” |
| **R9** | 私有 SPI（DisplayServices/CoreDisplay）在系统升级后变化 | 新版 macOS 亮度不可控 | 所有调用有 `try/except`，失败降级并置 `last_error`；真机日志定位 |
| **R10** | `brightness` CLI 版本/路径（/opt/homebrew vs /usr/local）差异 | CLI 兜底失效 | 代码多路径查找；找不到就跳过（不阻塞主路径） |
| **R11** | 日志双写（launchd stdout/stderr + run.py RotatingFileHandler 同一文件） | 日志重复/轮转冲突（不影响功能） | §1.3；建议 维护者 调整 run.py 或安装脚本 |
| **R12** | Python 升级/移动导致 TCC 相机授权失效（授权与可执行文件路径/签名绑定） | 升级后相机突然不可用 | 安装脚本已提示；文档 §8.1；重跑安装 + 重新授权 |
| **R13** | `tccutil reset` 只能重置不能授权；MDM 不能预授予相机 | 无法自动化授权 | 文档明确；只能引导用户手动授权 |
| **R14** | 锁屏状态未知（None）时 daemon 不做动作（SPEC 已定） | ioreg 被沙箱/权限挡住时锁屏功能失效 | 真机验证 ioreg 在 launchd 下可执行（`/usr/sbin/ioreg` 不需要特殊权限，预期可） |

### 已做过的静态验证（🔬，非真机）

- `python -m py_compile lb/platform_mac.py` → 通过（Python 3.14，Windows）。
- Windows 上 `import lb.platform_mac`、实例化 `MacPlatform()`、四个方法在非 macOS 下返回 `None/False` + `last_error`，不抛异常；
- 用 mock `subprocess.run` 对 `_locked_from_ioreg()` 做了合成 XML plist 单测：锁/未锁/键缺失/顶层 list/`IOConsoleUsers` 为 dict/字段缺失/非 plist 输出/ioreg 失败/OSError → 全部符合 §3.2 语义；
- `brightness -l` 输出解析（内置屏优先、main 次之、缺 flag 行容错、无 brightness 行）单测通过；
- `get_brightness`/`set_brightness` 的降级链、clamp、异常兜底用 mock 单测通过；
- `scripts/install_macos.sh` / `uninstall_macos.sh`：`bash -n` 语法检查通过；在 Linux（WSL bash 5.2）上用 fake python 做了端到端演练：dry-run 不落盘、真实安装复制文件 + 生成 **可被 `plistlib` 解析**的 plist、`launchctl` 分支跳过（非 Darwin）、卸载保留/`--purge` 删除/幂等/危险 `APP_DIR` 拒绝，全部通过。
- **没有做过的**：任何真机 macOS 运行、真实 `launchctl` 加载、iOS/macOS 框架调用、TCC 弹框、锁屏行为。

---

## 12. 变更记录

- 2026-10-21：初版。交付 `platform_mac.py`（IOKit/DisplayServices/CoreDisplay/CLI + ioreg 锁屏）、安装/卸载脚本、本说明；核实并记录 OpenCV AVFoundation 无手动曝光（回应 维护者 的假设）；标注全部未实测项。

---

## 13. 维护者 集成补充（2026-10-21，在 macOS 维护者交付之后）

1. **§1.3 / R11 的日志双写问题已修复**：`run.py:setup_logging()` 现在用
   `os.fstat(stderr)` 与日志文件 `st_ino/st_dev` 比对（`_stderr_is_log_file`），
   当 stderr 已被 launchd 重定向到同一个 `lockbright.log` 时跳过 console handler，
   不会再重复写日志；Windows 行为不变，安装脚本无需改动。
2. README 已按建议改写 macOS 状态：**“已实现、未在真机 Mac 上运行过、待验证”**，
   并明确写出「OpenCV 4.x/AVFoundation 不支持手动曝光 → Mac 回退自动曝光 →
   必须用 probe 做亮/暗两次校准」以及 TCC 首次授权流程。
3. `camera.py` 的 darwin 分支未改（保持无害：set 失败即回退 auto，只 warning 一次），
   与 §6 结论一致。
4. 最终交付口径：「Windows 已实测；macOS 代码 + 安装/卸载脚本 + 调研文档已完成，
   未真机实测；上 Mac 先验证相机 TCC、Apple Silicon 亮度、锁屏期间权限」。
5. **多摄像头（2026-10-21 追加）**：`run.py cameras` / `run.py preview --index N`
   在 macOS 上同样可用：OpenCV 不提供设备名，`cameras` 显示"未命名"，但会保存每颗
   index 的截图，`preview` 窗口里用 0-9 切换、Enter 选中（`--set` 写入配置），
   据此确认哪颗摄像头对着房间。`camera_name` 是 Windows-only（DirectShow 名称），
   mac 上留空即可。预览用自动曝光；实际测光仍按 §6 回退自动曝光，阈值用 probe 校准。
6. **脚本删除守卫（维护者 追加）**：`install_macos.sh` / `uninstall_macos.sh` 现在拒绝
   `APP_DIR` 为源码目录或其祖先、非 `.../LockBright/app` 的自定义目录（测试需设
   `ALLOW_UNSAFE_APP_DIR=1`），卸载只在 `run.py`+`lb/` 标记存在时删除；`--purge` 只在
   数据目录含 config/state/log 时删除。
7. **远程登录按锁屏处理（2026-10-21 晚，用户需求）**：该功能目前只在 Windows 实现
   （`WTSIsRemoteSession` + 配置 `treat_remote_as_locked`）。macOS 的“屏幕共享 / 远程登录”
   没有做可靠识别（`Platform.is_remote_session()` 返回 None），所以 mac 上仍按实际锁屏
   状态判断；如果 Mac 也需要这个行为，需要先真机确认 Screen Sharing/VNC 会话的检测方式
   （未实测，列为本文件 R15 级风险）。
