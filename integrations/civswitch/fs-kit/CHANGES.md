# CHANGES —— 我们对 slapah 移植层的补丁清单

基线：slapah/CivSwitch @ `7d422e52`（2026-11-04），`ns2jb-port/` 移植层。
以下补丁全部为**修 bug / 适配 Civ7 / 适配 Windows 沙箱**，不改变攻击语义。

| # | 文件 | 补丁 | 原因 |
|---|---|---|---|
| 1 | `port/civ7-app/thread-code.json` | `waitTimeoutResult: 59649 → 59905`（0xE901→0xEA01） | 硬件实测 svcWaitSynchronization 超时返回 0xEA01；作者常量写错导致 join 轮询永远把超时当异常（RUN 1-7 卡死根因） |
| 2 | `port/engine/switch2/memory/run-control.cjs`、`ro/runtime.cjs`、`firmware-dump.cjs` | 原子保存 `fs.rename` 加 EPERM/EBUSY/EACCES 重试（12 次，50+25n ms 退避） | Windows 上瞬时文件锁（Defender/索引）导致 `EPERM rename *.tmp -> .json`，运行中随机报废 |
| 3 | `port/engine/switch2/memory/probe-reserved-gap.cjs` | `metadataAttempts: 4 → 12` | alias 重试预算按 SmileBASIC 调校；Civ7 上 alias 频繁被打回（RUN 9/11/23/24） |
| 4 | 同上 | 新增 `retireParkedWorkers()`，serve 入口前主动回收 parked worker 线程，置 `report.servePrepared` | serve 入口 app 自崩排查（背景线程持有腐蚀状态嫌疑）；对成功率无害 |
| 5 | 同上 | drift 容忍：`retryable = earlyHole \|\| |diff| ≤ 0x800`；记 `retryableReason`；不满足才按作者原逻辑 fatal | Civ7 fs 后台活动猛，小 drift（-704/-28336）频繁；纯按 SB 的 ±192 容差会误杀深跑（RUN 15/30/29） |
| 6 | 同上 | bucket period 资格改重试循环（上限 metadataAttempts，记 `periodAttempts`） | 单发 period 资格在 Civ7 上极难（RUN 24 卡死点）；RUN 28 重试后首次通过 |
| 7 | 同上 | `NS2_SERVE_DELAY_MS` 环境变量（serve 前 PC 侧空等，默认 10000ms）与 `NS2_SKIP_SERVE` 旁路 | 诊断 serve 死点用；证明 app 死于 serve 调用窗口 |
| 8 | `port/engine/switch2/memory/fs-memory-control.cjs` + `port/engine/switch2/tools/endpoint.cjs` | memory socket 从 named pipe 路径改为 **TCP loopback**（`127.0.0.1:<随机端口>`，state.socketPath='host:port'，listening='tcp-loopback'）；endpoint.cjs 新增 `connectTarget()`：`/^([^:]+):(\d+)$/` 走 `{host,port}`，否则原路径 | 本机 Windows 沙箱（job object）禁 named pipe → `listen()` 抛 EACCES → serve 死点（RUN 14-34 全部 serve 入口死亡的真正原因）。RUN 34 起 2/4 首次 complete |

另有两处吸收自 x43x61x69/ns2jb（2026-11-10 上游提交）的改进，已并入本包：

| 来源提交 | 内容 |
|---|---|
| `e3309c35` "Track acquisition batch outcomes..." | `wave-history.cjs` 模块化：`hasWindow/markerHit/failureSummary/retryBatches` 批次账本；positive 校验失败立即抛（修掉全 aborted 静默完成的引擎结构 bug）；`workerCaptureSkipped`（native batch 不终止时不读被 IPC 保留的 buffer） |

未包含（备胎/实验）：x43x61x69 `f47ddb6f` 实验性 SD acquisition profile
（`--experimental-sd`，无硬件验证）；x43 的 cleanup-gated 同 session 重试只回植了一半。

补丁前的原文件备份：`port-patches/`（未包含在本包内；需要时向打包者索取）。

验证记录：补丁后 **RUN 34 = 2/4 首通、RUN 35 = 全链 verified 首通、
RUN 38 = 固件 dump 90/90（222 MB）**，均为本包内这份代码。
