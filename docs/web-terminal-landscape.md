# 调研：Web 终端渲染方案全景（含 wgpu 路线与零跨界协议）

> 状态：调研完成。触发问题："业界有没有性能更好的 wgpu 方案？有没有
> 没有 wasm 跨界拷贝问题的方案？"
> 前置阅读：`docs/webgl-renderer-research.md`（xterm.js 系）、
> `docs/beamterm-research.md`（instanced 布局）。本文补齐其余方案空间。
> 数据核实日期：2026-09-01。

## 1. 方案矩阵（全部源码/文档核实）

| 方案 | 渲染技术 | VT core | wasm 跨界 | 成熟度 |
|---|---|---|---|---|
| xterm.js + addon-webgl | WebGL1，CPU quad 展开 ~40B/cell | TS | 0（全 JS） | 工业标准（VS Code 默认） |
| beamterm | WebGL2 instanced 8B/cell，手写绑定 | 无（纯渲染器） | JS 逐 cell serde | 停更 7 个月（另文） |
| **ferroterm** | Canvas2D + WebGL 双渲染器，持久 buffer + 脏行重传 + 单 instanced call | Rust WASM（from-scratch DEC 状态机） | **1 次/帧，u32 位域快照，只脏行** | 活跃（2026-07 密集开发，2 人，0 星） |
| soul-terminal (AMAI Labs) | **wgpu 25**（web: WebGL2/WebGPU 自动），glyphon/cosmic-text | 无（widget surface，非终端） | 0（全 Rust） | 停更（2026-02，与 beamterm 同日） |
| ratzilla (ratatui 官方) | DOM / Canvas2D / WebGL2（backend 作者即 beamterm 作者） | 无（ratatui TUI 框架） | 0（全 Rust） | 1436 星，活跃；非终端模拟器 |
| FrankenTUI ADR-009 | **wgpu** + patch 流 + WASM 内 Rust 字形光栅化 + trace 确定性门 | 自有 | 0 | **仅 ADR（Proposed），实现未见** |
| ghostty-web（本 fork） | Canvas 2D fillText | ghostty WASM | 每帧 N 次整屏对象池（R1 计划修） | 自有 |

另扫过：basilisk（GPU 终端 + 内置复用，Rust，无 web 证据）、
levivilet/terminal（JS+WebGPU 实验，2023 停更，1 星）、DomTerm、
ttyd/wetty/electerm/Tabby/Hyper/Wave（全部 xterm.js 壳，无独立渲染器）。

## 2. 两个问题的直接回答

### Q1：有没有性能更好的 wgpu 方案？

**wgpu 在 web 上真实可用，但没有一个成熟 web 终端把它作为主渲染路径。**

- wgpu→web 有两条路：WebGPU（Chrome 113+）或经 naga 转译回 WebGL2。
  soul-terminal 证明了这条路能跑（wgpu 25 + glyphon 全浏览器渲染），
  ferroterm 的 **native** app 用 wgpu（M5 Pro 实测 11 ns/cell，300×80
  网格 CPU 帧成本 0.275ms）——但它的 **web** 主路径是手写 WebGL。
- 这是行业一致的选择，不是巧合：cell-grid 渲染管线极简（一个 quad
  instancing + 一个 atlas 采样），wgpu 的抽象层收益为零，代价是
  ~1MB 级 wasm 体积 + naga 转译层 + 双后端兼容矩阵。FrankenTUI 的
  ADR 选 wgpu 是"战略方向"论据（工具链/人体工学），且停留在纸面。
- **结论：wgpu 对本 fork 无增量价值——我们的管线复杂度恰恰在 wgpu
  抽象不掉的地方（脏行协议、atlas 生命周期、DPR 对齐）。beamterm 式
  手写 WebGL2 是该问题域的正确工具，ferroterm 用行动投了同样的票。**

### Q2：有没有没有 wasm 拷贝问题的方案？

**有，标准答案是 ferroterm 的快照协议——一帧一次跨界、位域打包、只发脏行：**

```
Uint32Array: [magic, cols, rows, curX, curY, curFlags, nRows,
              {rowIndex, cells…}…]
每 cell 6 words: [codepoint, fg, bg, flags, link, grapheme]
```

- 跨界次数：**1 次/帧**（不是每行、更不是每 cell）；JS 侧解码一次
  进自己的视图结构。
- 只发脏行：一行编辑的传输量 = 6×cols×4B，与屏幕大小无关的常数上限。
- 无对象分配：定长位域，不用 GC。
- 与它同构的引擎/视图分离（`attachView`/`detachView`）：几百个终端
  实例共存，只有可见的持有渲染器——**浏览器 ~16 个 WebGL 上下文
  上限的成熟解法**（我们 M5 风险登记表里的"多 tab GL 上下文数上限"
  直接抄这个）。

**跨界为零的方案存在**（soul-terminal/ratzilla/FrankenTUI 设计：VT +
渲染同住一个 Rust wasm），但它们要么不是终端模拟器，要么没实现；
对本 fork 不适用（ghostty VT 已在独立 wasm，交互逻辑全在 TS）。

## 3. ferroterm 深读（本 fork 最相关的存在）

**它就是"ghostty-web 想成为的架构"的独立实现**：Rust VT core（DEC
Williams 状态机，from-scratch，非 fork）+ wasm + JS 双渲染器，覆盖面
惊人且诚实（Known limitations 直说无 ligature、Kitty 子集、alt screen
不 reflow）。

关键数据：

| 项 | 数字 | 来源 |
|---|---|---|
| parse（最坏 SGR 流） | 149–248 MB/s | cargo bench，Apple Silicon |
| 快照 | 0.00–0.02 ms/帧（80×24–200×50） | 同上 |
| WebGL 增量渲染 | 一行编辑 ≈ 全帧 1/35（200×50） | README，浏览器实测口径 |
| cursor blink 帧 | < 100μs timer 分辨率 | 同上 |
| 体积 | ~65KB gzip（双渲染器 + Sixel + reflow + search + links） | vs xterm.js 68KB 核心单仓 |
| vs xterm.js | 解析 1.4×–4.4× 快 | COMPARISON.md，同浏览器同载荷 |
| 测试 | 50+ conformance + 双渲染器 headless-Chrome 像素回归 + fuzz | CI: fmt + clippy -D warnings + test |

成熟度：2026-07 单月 56 commits，两人（DatanoiseTV、Sylwester），
最后 push 2026-08-15。**0 星**——新且无人知，但工程纪律（CI 严格度、
诚实边界、基准方法学）是本 panorama 里除 xterm.js 外最认真的。
作为**依赖**引入依然出局（年龄太短、与 ghostty VT 冲突——我们不可能
丢掉 ghostty core 换它）；作为**架构蓝本**价值极高。

它对我们三处直接可抄：

1. **快照协议**（§2 Q2 的格式）——见 §4 行动项。
2. **WebGL 渲染器组织**：持久 per-cell instance buffer，只重传脏行，
   单 instanced call，装饰（cursor/underline/link）走只访问有装饰行的
   小 overlay pass——与 beamterm 布局互补（beamterm 的位域打包 +
   ferroterm 的脏行/overlay 组织）。
3. **engine/view 分离**（M5 上下文上限解法）。

## 4. 对本 fork 的行动项（比 beamterm 调研更实质）

**我们维持自己的 wasm-api patch 层**（`Update vendored ghostty to
1.3.1 and regenerate wasm-api patch`）——即 ghostty wasm 的导出面是
我们自己的 Rust 代码。这意味着 ferroterm 级快照协议对本 fork 是
**可实现的**，不只是仰望：

1. **R1 升级：Rust 侧 packed snapshot 导出**。在 wasm-api patch 里加
   `ghostty_viewport_snapshot_packed(handle, buf)`：内部一次
   `getViewport()`，按 `[header, nRows, {rowIndex, 6×u32/cell}…]`
   打包进预分配 wasm 内存，JS 侧拿到的是零拷贝 `Uint32Array` 视图。
   跨界 24×→1× 的 R1 目标直接越过 JS 侧单快照方案，达到 ferroterm
   形态（dirty-row 增量可依赖现有 `isRowDirty` 或 DirtyState）。
2. **M3（Glyph pass）融合两家**：instance 布局用 beamterm 的 8B 打包
   （`uvec2 pos + uvec2 packed`，效果位域进 glyph id 空闲位），
   buffer 管理用 ferroterm 的持久 buffer + 脏行范围 `bufferSubData`，
   装饰走小 overlay pass。
3. **M5 增补**：attachView/detachView 式 engine/view 分离作为
   多 tab GL 上下文上限的解法写入计划。
4. **WebGL1 起步的决策正式改为 WebGL2**（instanced integer attribute +
   sampler2DArray；旧设备走 auto→canvas 降级链）——ferroterm/beamterm
   双验证。

不做的：wgpu 路线（§2 Q1 结论）；引入 ferroterm/beamterm/soul-terminal
任何运行时依赖。

## 5. 结论

- 用户直觉方向（wgpu / 零拷贝）在业界都有存在证明，但**没有一个同时
  是成熟 web 终端**：wgpu 用户不是终端或没有 web 主路径；零跨界用户
  是 TUI 框架。
- 真正的宝藏在协议层不在 GPU 层：**ferroterm 的 u32 位域脏行快照**消灭
  了跨界问题，**beamterm 的 8B instanced 布局**消灭了上传问题——两者
  都可被本 fork 吸收，且 patch 层自主权使前者完全可行。
- 行业双票共识（ferroterm web 路径 + beamterm）：cell-grid 终端渲染的
  正确工具是手写 WebGL2 + instancing，不是 wgpu。
