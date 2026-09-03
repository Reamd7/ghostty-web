# 调研：WebGPU（浏览器原生 API）渲染器路线

> 状态：调研完成，未立项。结论：**M3 维持 WebGL2（决策不变）**，新增
> "后端隔离不变量"作为 M0 设计约束，并登记三个 WebGPU 升级触发器（§6）。
> 前置阅读：`docs/webgl-renderer-research.md`（可行性）、
> `docs/beamterm-research.md`（instanced 布局）、
> `docs/web-terminal-landscape.md`（wgpu 库路线已在 §2 Q1 否决）。
> 本文补齐 landscape 未覆盖的一块：**不经过 Rust wgpu 库、直接用浏览器
> 原生 WebGPU API（TS + WGSL）写渲染器**是否优于手写 WebGL2。
> 数据核实日期：2026-09-02。

## 1. 问题界定：三种"wgpu 方案"只有一种还没分析过

| 方案                                    | 状态                                              |
| --------------------------------------- | ------------------------------------------------- |
| A. Rust wgpu 库编译 wasm                | landscape Q1 已否决（抽象层无收益 + 体积/工具链） |
| B. 渲染器整体进 wasm（wgpu 或手写绑定） | beamterm §4 路径 B 已否决（TS 交互层需全部重写）  |
| C. **TS + WGSL 直写 WebGPU API**        | **此前未分析，本文对象**                          |

方案 C 与 A/B 无关：零 Rust 工具链、零额外 wasm、渲染器仍在本 fork 的
TS 契约内（`WebGLRenderer implements 同契约` 换成 `WebGPURenderer` 而已）。
landscape §2 Q1 对 wgpu 的否决理由（"抽象层收益为零"）不适用于 C——
C 讨论的是**目标 API 本身**，不是中间抽象层。

## 2. 支持矩阵（2026-09-02 逐源核实）

| 引擎                   | WebGPU                                                                                                                                        | WebGL2                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Chrome/Edge 桌面       | 113+（2023-05 起）                                                                                                                            | 全版本                |
| Chrome Android         | 121+（2024-01 起，caniwebview 手工验证）                                                                                                      | 全版本                |
| Firefox Windows        | 141+（2025-07 起，mozillagfx 官方博客）                                                                                                       | ✓                     |
| Firefox macOS          | 145+ 仅 Tahoe+ Apple Silicon；147+ 任意 ARM Mac；Intel Mac 要手动 pref（bug 1992212/1993341）                                                 | ✓                     |
| Firefox Linux          | **未发布**。meta bug 2006676（P2、无 assignee），被 GPU-process-on-X11/Wayland 元 bug + Vulkan dmabuf 展示路径崩溃链阻塞，2026-08-31 仍在更新 | ✓                     |
| Safari / iOS Safari    | 26+（2025-09 起默认开启，WebKit 官方博客）                                                                                                    | ✓（但见 §3 退化证据） |
| WKWebView（Capacitor） | iOS 26+（caniwebview 标注为 BCD 自动化测试数据，无手工验证标记）                                                                              | ✓                     |
| Android WebView        | caniwebview 同为 BCD 自动化数据标支持（Chromium 121+ 同源），未手工验证                                                                       | ✓                     |

映射到 OpenChamber 的五个运行面（本仓 `packages/*/package.json` 核实）：

| 面                                | 引擎                                     | WebGPU 现状                                     |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| Electron 桌面（electron 43）      | Chromium ≥142                            | ✓                                               |
| VS Code webview（engine ^1.85）   | Chromium ≥114（且用户 VS Code 通常更新） | ✓                                               |
| web 自托管                        | 任意浏览器                               | **Firefox Linux 用户 ✗——关键缺口**；Intel Mac ✗ |
| Capacitor iOS（@capacitor/ios 8） | WKWebView                                | iOS 26+ ✓；iOS <26 ✗ → 降级                     |
| Capacitor Android                 | Android WebView                          | 大概率 ✓（121+），需真机验证                    |

Firefox Linux 是本产品最痛的一格：OpenChamber 是开发者自托管工具，
Linux + Firefox 在自托管人群中的占比远高于普通网站。WebGPU-only 路线
等于让这部分用户留在 Canvas 2D（今天的性能天花板），而 WebGL2 路线
他们有 GPU 渲染。

## 3. 行业动向（全部 issue/官方博客核实）

### 3.1 xterm.js：实测过 WebGPU，更快，然后关掉了

- **PR #5666**（Tyriar 本人 2026-02 开）：WebGPU renderer 评估，原话
  "it appears to work and also be faster than webgl. This was only
  possible because of how good our shared renderer tests are."
  **2026-05-28 关闭未合并**，关闭理由："Even better models now, if we
  did this it would make sense to redo from scratch."
- **issue #4552**（WebGPU Renderer，2025-12 关闭为 out-of-scope）：
  "webgl will likely be the more reliable one for some time still."
  2024-12 评论：Tyriar 当时在做 Monaco editor 的 WebGPU renderer
  （microsoft/vscode#221145）——微软方向确实是 WebGPU，但先落在编辑器。

解读：终端形状的 WebGPU 渲染器**被最有钱的维护者实测确认更快**，仍因
可靠性/维护成本放弃。双 GPU 后端的负担对资源远超本 fork 的团队都嫌重。

### 3.2 Apple：官方宣判 WebGL 进入被取代期

WebKit 官方博客（Safari 26.0 发布文）：

> "WebGPU supersedes WebGL on macOS, iOS, iPadOS, and visionOS and is
> preferred for new sites and web apps. … WebGL required significant
> translation overhead due to being derived from OpenGL."

退化不是口头威胁，已经在发生：**xterm.js #5816**——macOS 26.5 beta 上
WebGL 渲染完全损坏（疑似 Safari 指纹对抗的副作用，jerch 判断），macOS
15.7 亦有报告；商业终端 webssh.net 的应对是对 OS ≥26.5 直接回退 Canvas
渲染器。**本 fork 的 Capacitor iOS 面正好全部押在这条退化轨道上。**

### 3.3 addon-webgl 自己也在付 GPU bug 税

**xterm.js #5847**：atlas 页合并腐化（glyph 替换 + 丢字形），长期未修。
关键修正：**不是 WKWebView 特有**——2026-08-11 报告在 Electron 43 /
Windows 11 / 桌面 Chrome（DPR 1.5）同样确定性复现（大量
`(glyph, fg, bg)` 三元组 + 视口滚动即触发）；#5883 的修复不彻底（腐化
位置变了但仍在）；DOM 渲染器同数据干净。

对本 fork 两个含义：

1. M2 的简化设计（单页起步、按页增长、**无 LRU 合并/驱逐**、主题/字号
   变更即全失效重建）恰好绕开这一整类 bug——设计被业界事故反向印证。
2. "行业默认 WebGL 方案"也在持续爆 GPU bug → M5 的 auto 降级链不是
   可选项，是 survival requirement（webssh.net 的回退是生产证据）。

## 4. 技术对比（cell-grid 管线逐项）

| 关注点        | WebGL2（beamterm/ferroterm 图纸）                                                 | WebGPU                                                                                            | 判定                                                             |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| instance 上传 | integer attribute（RGBA32UI）+ `bufferSubData`，受 attribute 格式/对齐约束        | `queue.writeBuffer` 直接吃 `Uint32Array` 进 storage buffer，VS 按 `@builtin(instance_index)` 拉取 | **WebGPU 显著更干净**；R1 packed snapshot 的位域数组可原样进 GPU |
| quad 展开     | 静态 4 顶点 + `drawElementsInstanced`                                             | 同型（`vertex_index` 数学生成，可无顶点缓冲）                                                     | 平                                                               |
| 字形 atlas    | `sampler2DArray` + `texStorage3D`                                                 | `texture_2d_array` 核心 + `copyExternalImageToTexture`                                            | 平                                                               |
| ANGLE         | Windows 经 ANGLE→D3D11；beamterm 两处对策（vertex 侧解包、highp floor）是踩坑证据 | Chrome→Dawn→D3D12/Vulkan/Metal；Safari→Metal；**无 ANGLE**                                        | WebGPU 少一整层已知坑                                            |
| 设备丢失      | `webglcontextlost/restored`（per canvas）                                         | adapter/device lost + `uncapturederror`（per device，可共享 adapter）                             | 模型相当                                                         |
| 多实例上限    | Chromium ~16 活跃 GL 上下文                                                       | 无同类文档化硬上限，但内存约束同在；ferroterm attachView 式分离仍是正解                           | 平（分离设计两 API 都需要）                                      |
| 着色器        | GLSL ES 3.00，beamterm shader 可近逐行翻译                                        | WGSL，2 个 trivial shader 移植 ~1 天                                                              | 平（单后端）；双后端则两套方言                                   |
| 像素回读/CI   | `toDataURL`/截图；headless 原生                                                   | 同；headless 走 SwiftShader（Chrome 官方博客有测试方案）                                          | 基本平，WebGPU CI 多一步配置                                     |
| 帧性能        | 行业图纸 <1ms / 45k cells（beamterm，2019 高端硬件）                              | xterm.js 实测 "faster than webgl"（幅度未公布）                                                   | 对本 fork 规模（≤12k cells）两者都远非瓶颈                       |

性能结论与 beamterm-research §3.2 一致：GPU 侧两个 API 都能打到亚毫秒，
本 fork 的真实瓶颈在 CPU 协议层（cell 快照遍历、glyph 查询、跨界）——
那是 R1/packed snapshot 的战场，与 GPU API 选择正交。**性能不构成本
决策的依据；依据是支持矩阵（§2）与维护成本（§3）。**

## 5. 路线判定

| 路线                                             | 判定       | 理由                                                                                                       |
| ------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------- |
| A. WebGL2 单 GPU 后端 + canvas 降级（现计划 M5） | **✓ 维持** | 唯一被 addon-webgl / beamterm / ferroterm 三个参照 + xterm.js 生产验证的组合；§2 全矩阵覆盖（含 FF-Linux） |
| B. WebGPU 单 GPU 后端 + canvas 降级              | ✗          | FF-Linux / Intel Mac / iOS<26 全部落到 Canvas 2D——把 GPU 加速从最需要它的开发者群体手里拿走                |
| C. WebGPU + WebGL2 双 GPU 后端 + canvas          | ✗（现在）  | xterm.js 资源远超本 fork 仍拒绝（#5666 关闭理由）；两套 shader、两套上传路径、测试矩阵 ×3                  |
| D. WebGL2 先行 + WebGPU 作为未来 tier            | **✓ 采纳** | 不是抽象层，是**模块纪律**（见下）                                                                         |

路线 D 的"后端隔离不变量"（写入 M0 决策表，不是代码）：

- instance 布局（beamterm 8B/cell 位域）、atlas 协议（slot 分配/双宽
  连续 slot/失效版本号）、脏行协议——全部定义为**后端无关的
  `Uint32Array`/文档级 spec**；
- GL 调用不得越出 `lib/renderers/webgl/gl/`（shader 源码、上下文管理、
  上传路径全部收口在该目录）；
- 不建 TypeScript backend interface 抽象（投机抽象），只保模块边界干净。

这样 §6 触发器满足时，WebGPU tier 是"按同一 spec 新写一个 gl/ 兄弟
目录"，不是重构。

## 6. 升级触发器（满足其一即立项 WebGPU tier）

1. **Firefox Linux WebGPU 发布**（meta bug 2006676 关闭）——路线 B 的
   主要缺陷消失，届时 WebGPU-only + canvas 都可以重新评估。
2. **Apple 平台 WebGL 退化加速**（#5816 类事件再现 / WebKit 给出弃用
   时间表）——Capacitor iOS 面需要逃生门，WebGPU tier 优先级提升。
3. **xterm.js 或 VS Code 把 WebGPU renderer 落为默认**——可抄的实现
   图纸 + 生态成熟信号（#5666 关闭评论暗示"用更好的模型重写"是他们的
   下一步，正好是我们的触发器 3）。

## 7. 对现有文档的修订登记

本文只登记，不代改（plan 修订属实施线会话）：

1. `webgl-renderer-plan.md` M0 决策表：补一行"后端隔离 = 路线 D 模块
   纪律"；M5 风险登记补两行——WebKit GL 退化（证据 #5816，缓解：auto
   链 + §6 触发器 2）、atlas 页合并腐化（证据 #5847，缓解：M2 本就不
   实现 LRU 合并）。
2. `webgl-renderer-research.md` §2.5：业界采用段补两条持续性风险注脚
   （Safari 26.5 破损、atlas 腐化）。
3. `web-terminal-landscape.md` §1 矩阵 xterm.js 行：补 webgpu PR closed
   事实。

## 8. 结论

- 原生 WebGPU API 路线技术上成立且比 WebGL2 干净（无 ANGLE、
  storage buffer 直吃位域数组），但**支持矩阵不给它开绿灯**：Firefox
  Linux 未发布是本产品（开发者自托管）不可接受的降级面。
- 行业剧本已经演过一遍：最强的维护者实测 WebGPU 更快，然后选择留下
  ——可靠性是终端渲染的硬约束，双后端是奢侈品。
- 决策不变（WebGL2 起步），新增的是两样东西：**后端隔离不变量**（让
  未来 tier 是新写不是重构）和**三个明确的升级触发器**（FF-Linux、
  Apple WebGL 退化、xterm.js/VS Code 落地）。触发器 2 与本 fork 的
  Capacitor iOS 面直接相关，是最可能先到的一个。
