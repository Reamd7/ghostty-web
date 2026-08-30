# 调研：WebGL 渲染器可行性（ghostty-web fork）

> 状态：调研完成，未立项。立项条件见 §8 决策门。
> 前置阅读：主仓 `PLAN-terminal-render-perf.md`（R1-R3 渲染循环重构是本方案的地基）。

## 1. 动机与边界

Canvas 2D 渲染的硬天花板是 `fillText`：每个非空 cell 一次调用，1-5μs/次。
80×24 全脏帧 ≈ 1500 次 ≈ 1.5-7.5ms，**占帧成本 95%+**；数据搬运（跨界 memcpy +
cell 解析）在 R1 完成后仅 ~100μs。继续优化搬运无意义，提升只能来自绘制方式。

WebGL glyph atlas 路线 = 字形预光栅化进纹理，每帧只做顶点批量提交 + 一次
`drawArrays`。

**先回答两个架构问题（调研结论）**：

- *把渲染业务全搬 wasm？* 对 Canvas 2D 不做——绘制 API 只在 JS 侧，wasm
  化后每条绘制指令要 wasm→JS 反向跨界，帧时间更差。**边界修正（见 §2.5
  beamterm）**：在 WebGL 下"渲染器整体 wasm 化"没有此障碍（wgpu 直接驱动
  GPU），是真实可行的路线，但代价是引入 Rust 工具链；本 fork 已有 TS 渲染
  契约与测试，不走此路。wasm 侧生成顶点 buffer 的收益（省一次快照拷贝）
  在 R1 后仅 ~30KB/帧，不值得。
- *直接用 @xterm/addon-webgl？* 不可能，见 §3。

## 2. 业界参照：xterm.js addon-webgl 架构

源码 `xterm.js/addons/addon-webgl/src`，约 130KB TypeScript：

| 模块 | 规模 | 职责 |
|---|---|---|
| `TextureAtlas.ts` | 49KB | 字形→纹理缓存（本方案核心参照） |
| `WebglRenderer.ts` | 32KB | 帧调度、图层编排（rect→glyph→overlay） |
| `GlyphRenderer.ts` | 18KB | 字形 quad 顶点生成与提交 |
| `RectangleRenderer.ts` | 14KB | 背景/选区矩形批量绘制 |
| `CellColorResolver.ts` | 10KB | cell 颜色解析（含对比度调整） |
| `customGlyphs/` + `renderLayer/` | ~10KB | powerline/box 字形像素绘制、光标层 |

### TextureAtlas 关键设计（可直接借鉴）

- **多页 atlas**：页从 512² 起步按需增长；同尺寸 4 页可合并为 2× 大页；
  上限 4096²（=16MB GPU 内存）。
- **四键缓存**：`FourKeyMap<codepoint|chars, bg, fg, ext, IRasterizedGlyph>`
  ——字形变体由 (码点, 前景, 背景, 扩展属性) 唯一决定。
- **光栅化路径**：tmpCanvas（`willReadFrequently`）画字形 → `drawImage`
  进 atlas 页 → 触发纹理上传（页版本号协议）。
- **ASCII 33-126 空闲预热**（IdleTaskQueue），首屏不卡。
- **失效协议**：字体/字号/主题变更 → `clearTexture()` + `pageLayoutVersion++`
  → 渲染模型全部失效重传。
- **context lost**：`webglcontextlost/restored` 必须处理（Canvas 2D 没有的
  新故障模式）。

### 渲染管线（每帧）

```
BufferLine 遍历（JS，读 TypedArray 位域）
  → RectangleRenderer：非默认背景 cell → 矩形实例 buffer
  → GlyphRenderer：非空 cell → atlas 命中/未命中光栅化 → quad 顶点 buffer
  → drawArrays × 2（矩形一遍、字形一遍）+ 光标/选区叠加层
```

未命中 atlas 的字形光栅化是唯一的同步慢路径，靠缓存命中率高（ASCII 预热 +
工作集局部性）保持在帧外。

## 2.5 业界采用情况（2026-08 核实）

**大规模部署的 web 终端 WebGL 方案只有一个：xterm.js + addon-webgl。**

- **VS Code**（桌面 + vscode.dev，世界上部署量最大的 web 终端）：微软官方
  推进，2021 年起 WebGL 为默认渲染器（microsoft/vscode#106202，Tyriar
  主导，已关闭落地）。设置收敛为
  `terminal.integrated.gpuAcceleration: 'auto'|'on'|'off'`；`auto` =
  webgl 优先，启动失败或运行时 FPS 低于预期时自动降级 canvas → dom 并
  缓存决策。canvas 渲染器保留仅因个别设备（如旧 iPad）无 WebGL2。
- **xterm.js 生态**（Hyper、Wave Terminal——后者维护自己的 xterm.js fork、
  ttyd/wetty/electerm/Tabby 等 web/SSH 终端）：全部 xterm.js 系，WebGL
  与否取决于是否挂 addon-webgl；无第二套成熟 WebGL 实现在流通。

**非 xterm 系的独立实现存在，但小众/新兴**：

- **beamterm**（kofany/beamterm，crate `beamterm-renderer` + npm
  `@beamterm/renderer`）：Rust + wgpu 编译 WASM + WebGL2 instanced
  rendering，宣称亚毫秒渲染；cell 批更新单次 GPU 上传；只做 cell-grid
  渲染不做 VT 解析（与 ghostty VT 在架构上互补）。它证明渲染器整体
  wasm 化 + wgpu 这条路真实可行（修正 §1 结论边界），但引入 Rust/wgpu
  工具链，本 fork 不采用。
- ferroterm、soul-terminal 等：实验规模。

**原生终端全员 GPU 渲染**（非 web，但是路线共识的证据）：Alacritty
（OpenGL，2017 年即以 GPU 渲染立身）、kitty（OpenGL）、WezTerm
（Metal/GL）、Ghostty 本体（AppKit+Metal / GTK+GL）。终端渲染走 GPU
字形图集是全行业收敛点，web 侧 addon-webgl 即该共识的 WebGL 翻译，
VS Code 数百万日活验证了它的正确性边界与降级策略。

对本 fork 的意义：走 WebGL 不是激进选择，而是补齐行业默认路线；
`auto` 降级链（webgl → canvas 回退 + FPS 探测缓存）应作为本方案验收
标准的一部分直接采纳。

## 3. 为什么 `@xterm/addon-webgl` 不能直接用于 ghostty-web

ghostty-web 的 xterm.js 兼容是**公共 API 表面**（`ITerminalCore` 仅
`{cols, rows, element, textarea}`；`loadAddon` 只调 `activate(this)`），
连 FitAddon 都是形状兼容的重写。addon-webgl 依赖三层内部结构，全部缺失：

1. 它 `activate()` 后即挖 `terminal._core` 私有服务树
   （`_renderService`、`_charSizeService`、`themeService`...）——fork 无此树。
2. 它把自己注册为 xterm.js 内部 `IRenderer` 接管渲染——fork 的渲染器是
   自有 `CanvasRenderer`，无该注册点。
3. 顶点生成直接读 xterm 原生 `BufferLine` 的 3×uint32 位域内存布局——
   fork 的 `buffer.getLine()` 返回 GhosttyCell 对象适配器，布局不同。

（xterm.js 自己的 addon-webgl 也只锁定特定 xterm 版本运行——内部 API 无
兼容承诺，跨引擎复用本就不在设计目标内。）

## 4. fork 侧注入点（比 addon 模式更干净）

`Terminal` 构造 `CanvasRenderer` 处即注入点；渲染契约已稳定：

```
render(wasmTerm, forceAll, viewportY, scrollbackProvider, scrollbarOpacity)
resize(cols, rows) / getMetrics() / getCanvas() / setTheme / setFontSize /
setFontFamily / setCursorStyle / setCursorBlink / setSelectionManager /
setHoveredHyperlinkId / setHoveredLinkRange / clear / dispose /
charWidth / charHeight / remeasureFont
```

新增 `WebGLRenderer implements 同契约`，`Terminal` 增加渲染器选择参数
（构造或运行时切换）。**R1 完成后 `render()` 入口已有每帧单次
`getViewport()` 快照——这正是顶点生成的理想输入**（全屏 cell 一次到手，
直接喂 quad 生成循环），两个工作天然衔接。

## 5. 方案草案（模块划分）

```
lib/renderers/
  canvas.ts        ← 现有 CanvasRenderer 迁入（保留为回退路径）
  webgl.ts         ← WebGLRenderer：实现同一契约
  gl/
    atlas.ts       ← 字形纹理缓存（借鉴 §2，可大幅简化，见下）
    glyph-pass.ts  ← 字形 quad 顶点生成 + drawArrays
    rect-pass.ts   ← 背景/选区矩形 pass
    context.ts     ← WebGL 上下文管理 + context lost 恢复
```

### 相对 addon-webgl 的简化机会

| addon-webgl 复杂度来源 | fork 情况 |
|---|---|
| CellColorResolver（对比度动态调整、最小对比度主题） | fork 主题色已在上游解析成 RGB，直接用 |
| customGlyphs（powerline/box drawing 像素绘制） | fork 用 Nerd Font，字形本身存在，先走普通光栅化，像素绘制仅作 fallback |
| decoration service / underline 变体 8 种 | fork flags 里有 underline/dim/inverse，先支持现有集 |
| LRU 页合并/驱逐（多主题多字号并存） | fork 每终端一个渲染器、主题/字号变更即全失效重建，单页起步 + 逐页增长足够 |

atlas 缓存键：`(codepoint, fgRGB, bgRGB, flags)`——与四键等价，
`GhosttyCell` 16 字节结构比 xterm 位域更好拆。

### 必须覆盖的 fork 特性

- **CSS transform 缩放**：viewZoom / driverScale 作用在 canvas 元素上，
  GL 视口与 devicePixelRatio 的乘积关系需与 Canvas 2D 路径逐像素对齐
  （transform 不改变 canvas 内部分辨率，风险低，需视觉验证）。
- selection 高亮、hyperlink 下划线、光标（含闪烁时序）、scrollback 滚动、
  滚动条淡出——现全部画在同一 canvas，GL 路径全部要重实现。
- 无 WebGL 环境（远程桌面/受控 WebView/移动低端机）回退 `canvas.ts`——
  两条路径长期共存，测试矩阵 ×2。

## 6. 工程量评估

- addon-webgl 全量 ≈ 数千行；按 §5 简化后估计 **1500-2500 行** TS +
  shader 2 个（rect/glyph）。
- 主要风险不是代码量而是**像素级对齐**：GL 与 Canvas 2D 的字形基线/抗锯齿
  差异、DPR 取整、宽字符（CJK/emoji）advance 与 `metrics.width` 的一致性。
  fork 的 selection/link 检测假设 `pixelToCell` 与渲染几何一致——GL 路径
  必须复用同一 `FontMetrics`。
- context lost 恢复、多终端实例（多 tab 各自 GL 上下文，浏览器上下文
  数量上限）需要专项处理。

## 7. 基准设施（已有，直接扩展）

`bench/versus.ts` 已是 mitata 基准：ghostty-web vs `@xterm/xterm`，
内置 `generateColorText / generateComplexVT / generateRawBytes` 数据源。
扩展两点：

1. 增加 `@xterm/xterm` + `@xterm/addon-webgl` 组合为第三对照——
   直接量化 "fork(canvas) vs fork(webgl) vs xterm(webgl)"。
2. 渲染路径基准需真实 canvas（现 happydom 无 GPU），基准拆两层：
   VT 吞吐（现有，DOM 无关）+ 帧渲染（`scripts/perf/profile:terminal`，
   在主仓，走生产构建）。

## 8. 决策门（重申）

```
R1-R3 完成（必做，与 WebGL 无关的地基）
  → 主仓 profile:terminal 生产构建基线
  → 判定：
     极端输出流 p95 帧时间 < 16.7ms → 停，WebGL 不做
     p95 超预算 且 trace 的 paint/raster 占主导 → 立项本方案
```

trace 必须显示 fillText/raster 为主要成本才立项；若瓶颈在脚本层
（如 R1 未达成的残留搬运），先修脚本层。

## 9. 结论

- WebGL 是终端渲染的终局方案，但**它是决策门的产物，不是起点**。
- 业界核实（§2.5）：大规模 web 终端 WebGL 方案仅 xterm.js + addon-webgl
  一套（VS Code 默认）；渲染器 wasm 化有 beamterm 先例但不适合本 fork；
  原生终端全员 GPU —— 走 WebGL 是补齐行业默认路线。
- 实现走 fork 自有 renderer 契约（§4），复用 addon-webgl 的 atlas 设计
  知识（§2），不复用其代码；`auto` 降级链纳入验收标准。
- 与 R1 的关系：R1 的每帧单快照 = WebGL 顶点生成器的输入接口，
  两阶段工作衔接，无返工。
