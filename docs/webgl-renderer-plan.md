# 计划：WebGL 渲染器实现（分支 `webgl-renderer`）

> 依据：`docs/webgl-renderer-research.md`、`docs/beamterm-research.md`、
> `docs/web-terminal-landscape.md`（调研已定案：**WebGL2**、自有契约注入、
> beamterm 8B/cell instanced 布局 + ferroterm 脏行组织、auto 降级链）。
> 本分支为实验线；合入 `terminal-enhancer` 仍受主仓
> PLAN-terminal-render-perf.md §决策门约束（R1-R3 + 基线数据）。
> **实现原则（2026-09-04 补）**：(1) 参考 addon-webgl 真实源码逐模块对照，
> 不空想；(2) 每个里程碑有独立验证循环，完成即可证，不靠最后总验。
## 0. 关键架构决策（开工前锁定）

| 决策 | 选择 | 理由 |
|---|---|---|
| GL 版本 | **WebGL2**（`#version 300 es`，integer attribute + `sampler2DArray`） | beamterm/ferroterm 双验证；instanced integer attribute 是 8B/cell 布局的前提；旧设备走 auto→canvas 降级 |
| 与 R1 关系 | `WebGLRenderer.render()` **原生按 R1 形状写**：`beginFrame()` 单跨界 + `getViewportPool()` 行切片 | R1 已落地（`33c235f`），直接消费 frameDirty + pool |
| 顶点提交 | **8B/cell**：`a_pos uvec2(x, y|wide<<16)` + `a_data uvec2(glyphId:16\|flags:4\|fgR/fgG, fgB\|bg RGBA8)`，单静态 quad + `drawElementsInstanced` | beamterm 布局（vs addon-webgl 11 floats=44B/cell）；颜色 vertex 侧解包 `flat out`，位移 GPU 侧 `floor(pos*cellSize+0.5)` 像素对齐（两处 ANGLE 对策） |
| 纹理组织 | `sampler2DArray` RGBA8，槽位 `(2·cellW+2)×(cellH+2)`（pad 1px），槽内寻址全 shader | vs addon-webgl 的 N 张独立纹理 + frag 动态分支（受 MAX_TEXTURE_IMAGE_UNITS≈32 页上限）；z 层索引无上限 |
| 缓存键 | `(text, bold, italic)`——**白字光栅化取 alpha，fg 在 instance 里乘**；emoji 彩色自动检测置位 | vs addon-webgl `FourKeyMap(code, bg, fg, ext)` 颜色烘焙键（条目数 ×颜色数）；下划线/删除线进 instance flags 位 shader 画线，不进键 |
| buffer 管理 | 持久 instance buffer + 脏行范围 `bufferSubData`（ferroterm）+ 双缓冲 attributesBuffers 轮换（addon-webgl） | 脏行 = 渲染循环已算出的集合，行内 instance 下标连续 |
| 渲染器选择 | `Terminal` 构造参数 `renderer?: 'canvas' \| 'webgl' \| 'auto'`（默认 `auto`） | VS Code `gpuAcceleration` 语义 |
| 文件布局 | 新增 `lib/renderers/webgl/`；不移动 `lib/renderer.ts` | 回退路径零风险 |
| 字体度量 | 提取共享 `measureFontMetrics()`（CanvasRenderer 改为委托） | selection/link 的 `pixelToCell` 依赖几何一致；单一事实源 |

## 0.5 addon-webgl 源码对照结论（参考已研读，MIT，xterm.js master）

已逐模块研读 `addons/addon-webgl/src`（GlyphRenderer 421 行 /
RectangleRenderer 386 / TextureAtlas 1206 / WebglRenderer 768）：

**直接采纳**（工程细节，照抄语义）：
- 单位 quad `[0,0, 1,0, 0,1, 1,1]` + `drawElementsInstanced(TRIANGLE_STRIP, 4, UNSIGNED_BYTE)`
- rect pass 属性 `position(2)+size(2)+color(4)` = 8 floats/rect，**run-length 合并**同色背景（`(endX-startX)*cellWidth` 一条矩形）
- 背景→字形→光标 三段绘制顺序；光标独立顶点集；viewport 底色矩形
- `beginFrame()` 返回 atlas 页布局是否变化 → 上层决定全量重建 model（`pageLayoutVersion` 协议）
- 双缓冲 `attributesBuffers[2]`（GPU 占用中不可改 buffer）
- ASCII 33–126 warmUp 预热；1×1 红像素哨兵纹理（无效页画红块，调试）
- blend `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`；`PROJECTION_MATRIX` 常量
- context loss：`preventDefault` + 等待 restored（数秒超时）→ `onContextLoss` 事件交上层决策（VS Code 切 canvas 渲染器）

**有意偏离**（beamterm 已验证的更优布局，见调研文档）：
- 44B/cell（11 floats CPU 展开）→ 8B/cell（2×uint32 位域，GPU 侧展开）
- N 张独立 `sampler2D` + frag 动态分支选页 → `sampler2DArray` z 层
- 颜色烘焙缓存键（每 fg 色一个纹理条目）→ 白字 alpha + shader 乘色
- 页合并（4 页→2× 大页的 AtlasPage 管线）→ 槽位固定、texStorage3D、
  满则重建更大纹理（fork 单渲染器单字号，简单优先）

## 0.6 独立验证循环（每个里程碑完成即自证）

| 循环 | 载体 | 验证内容 | 何时跑 |
|---|---|---|---|
| **A 单元** | `lib/renderers/webgl/*.test.ts`，mock `WebGL2RenderingContext`（记录调用序列的 stub） | atlas 槽位数学/分配/驱逐、instance 位域打包、run-length 合并、缓存键 | 每模块完成，`bun test` 秒级 |
| **B 视觉** | `demo/webgl-check.html`：同页两个 canvas（CanvasRenderer + WebGLRenderer）喂**硬编码 VT 字节流**，`window.__diff()` 返回逐像素 `{maxDiff, meanDiff, mismatch}` | M1 背景色块 / M3 全量文本（ASCII+CJK+emoji+block+样式）/ M4 叠加层 | 每里程碑，browser 工具 headless 调 `__diff()` 拿数字 |
| **C 契约** | 两渲染器同输入：`getMetrics()` 相等、`resize()` 后 canvas 尺寸/DPR 一致 | 契约面 | M5 |
| **D 集成** | `bun run demo`（vite + 真 PTY）+ browser 交互 | 输入/滚动/选择/blink 实况 | M5 后 |

B 循环是关卡：每个 M 的验收 = `__diff()` 在容差内（默认每像素 ΔRGB≤8、
mismatch ≤0.5%），失败时 demo 页并排渲染 + 差异热图，肉眼定位。
## 里程碑
```
M0 → M1 → M2 → M3 → M4 → M5 → M6   （严格串行；M0 = 验证循环载体，
每步以 B 循环像素 diff 关卡，A 循环单测随模块走）
```

M0 先于一切实现：没有可重复的 `__diff()` 数字，任何 GL 代码都不可判。
M1-M3 期间 demo 页验证；M5 起接主仓 dev server E2E。

<!-- 旧顺序段废弃 -->
<!-- M1 → M2 → M3 → M4 → M5 → M6     （严格串行，每步以视觉 diff 关卡） -->
<!-- M1-M3 期间 demo 页手工验证；M5 起接主仓 dev server E2E。 -->
`lib/renderers/webgl/context.ts`：

- `GLContext` 封装：canvas 获取 `webgl` 上下文（`alpha:false, premultipliedAlpha:true`）
- shader 编译/program 链接工具，GL 错误检查（失败抛可识别错误 → 降级）
- `webglcontextlost/restored` 事件：lost 时阻止默认 + 标记重建；restored 时全量重建纹理与 buffer
- `RectPass`：单色矩形实例化绘制（背景/选区共用）
  - 顶点属性：`position(vec2) + size(vec2) + color(vec4)`，三角形对展开
  - 每帧收集非默认背景 cell → 压缩写 buffer → 一次 `drawArrays`

**验收**：demo 页跑 GL 终端，仅画背景色块 + ANSI 底色测试（`\x1b[41m` 等），
色块与 Canvas 2D 渲染逐像素一致（截图 diff ≤ 容差）。

### M2 — TextureAtlas（字形缓存）

`lib/renderers/webgl/atlas.ts`：

- 页从 512² 起步、按需增长，上限 2048²（fork 单渲染器单字号，4096 过剩）
- 缓存键 `(codepoint, fgRGB, bgRGB, flags)`——`GhosttyCell` 16B 结构直拆
  （flags 仅取影响光栅化的位：bold/dim/italic/inverse；underline/strikethrough
  走 rect pass 画线，不进 atlas 变体）
- tmpCanvas 光栅化（`willReadFrequently`）→ `texSubImage2D` 上传
- ASCII 33-126 默认色空闲预热（`requestIdleCallback` fallback `setTimeout`）
- 字体/字号/主题变更 → `clearTexture()` + 版本号失效
- powerline/box drawing：先走 Nerd Font 正常光栅化（fork 已用 Nerd Font，
  字形存在）；**不实现** customGlyphs 像素绘制

**验收**：单测（缓存命中/失效/页增长用 mock GL）；视觉对比常用字符集
（ASCII + CJK + emoji + powerline）与 Canvas 2D 输出。

### M3 — Glyph pass（字形批量绘制）

`lib/renderers/webgl/glyph-pass.ts`：

- quad 生成：读 M1 快照行切片，非空 cell → atlas 查询（未命中同步光栅化）
  → `(position, texcoord, size, offset, color)` 顶点
- 宽字符（width=2）/grapheme cluster（`grapheme_len`）：advance 翻倍，
  光栅化用 `getGrapheme()` 码点串
- 半透明合成：glyph shader 乘 fg 色（光栅化为灰度 alpha 纹理，fg 在顶点色）
  ——注意 addon-webgl 的 premultiplied alpha 约定

**验收**：全量文本渲染与 Canvas 2D 截图 diff；`bench/versus.ts` 加
渲染基准（无 GPU 环境跳过标记）。

### M4 — 叠加层（光标/选区/链接/滚动条）

- 光标：block/underline/bar 三形状 + 闪烁时序（复用现有 blink 状态机，
  只重绘光标行——与 R3 的按需渲染协同）
- 选区高亮：rect pass 半透明矩形（现有 `selectionManager` 提供行区间）
- hyperlink 下划线 + hover 态：rect pass 画线
- scrollback 滚动条：rect pass + 淡出 alpha

**验收**：交互测试矩阵——拖选、hover 链接、滚动、光标闪烁，GL 与
Canvas 行为一致。

### M5 — 集成与降级链

- `Terminal` 构造参数接入；`auto` 模式：GL 初始化失败/M1 上下文获取失败
  → console.warn + 回退 CanvasRenderer（实例级缓存决策）
- 运行时 FPS 探测降级（VS Code 策略）：连续 N 帧 < 阈值 → 切 Canvas +
  缓存，下次直接 Canvas
- DPR/resize：`resize()` 同步 GL viewport + buffer 容量；viewZoom/
  driverScale 为 CSS transform，不进 GL（验证像素对齐即可）
- `getCanvas()`/`getMetrics()` 等契约方法全实现（见调研 §4 清单）

**验收**：fork 全量测试绿 + 新增契约测试（两渲染器同一输入同一
`FontMetrics` 输出）；demo 切换按钮对比两渲染器。

### M6 — 基准与验收数据

- `bench/versus.ts` 三对照：fork(canvas) vs fork(webgl) vs xterm(+webgl)
- 主仓 `profile:terminal` 生产构建前后对比（决策门数据）
- 产出数字进 `docs/webgl-renderer-plan.md` 附录：极端流场景 p95 帧时间

## 依赖顺序

```
M1 → M2 → M3 → M4 → M5 → M6     （严格串行，每步以视觉 diff 关卡）
```

M1-M3 期间 demo 页手工验证；M5 起接主仓 dev server E2E。

## 风险登记

| 风险                                   | 缓解                                           |
| -------------------------------------- | ---------------------------------------------- |
| GL 与 Canvas 抗锯齿/基线像素差异       | 验收用容差 diff（非逐位）；FontMetrics 单源    |
| atlas 未命中同步光栅化卡帧             | ASCII 预热 + 帧内未命中上限（超出丢帧下轮补）  |
| 多 tab GL 上下文数上限（Chromium ~16） | 上下文计数 + 超限实例强制 Canvas               |
| context lost（GPU 驱动重置）           | M1 的事件协议 + 全量重建路径，纳入测试         |
| happydom 无 GPU 不可单测               | 契约测试 mock GL；视觉/性能验证走 demo + bench |

## 完成定义（合入主线的门）

- M1-M6 全部验收通过
- 主仓生产构建 E2E：vim/htop/cat/拖选/hover 场景视觉正常，无 GL 报错
- `bench` 数字：极端流 p95 帧时间显著低于 Canvas 路径（否则记录 negative
  result 并重新评估合入）
- auto 降级链在无 GL 环境（`--disable-webgl` 启动）验证回退正确
