# 计划：WebGL 渲染器实现（分支 `webgl-renderer`）

> 依据：`docs/webgl-renderer-research.md`（调研已定案：WebGL1 起步、
> 自有契约注入、atlas 借鉴 addon-webgl、auto 降级链）。
> 本分支为实验线；合入 `terminal-enhancer` 仍受主仓
> PLAN-terminal-render-perf.md §决策门约束（R1-R3 + 基线数据）。

## 0. 关键架构决策（开工前锁定）

| 决策       | 选择                                                                                                              | 理由                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GL 版本    | **WebGL1**（+ `ANGLE_instanced_arrays`/`OES_texture_float` 按需）                                                 | addon-webgl 验证过的路径，shader 可参照；兼容面最大；WebGL2 升级留作后续 |
| 与 R1 关系 | `WebGLRenderer.render()` **原生按 R1 形状写**：入口一次 `update()+getViewport()`，行循环读快照切片                | 新代码直接写成正确形状，不等 CanvasRenderer 重构                         |
| 渲染器选择 | `Terminal` 构造参数 `renderer?: 'canvas' \| 'webgl' \| 'auto'`（默认 `auto`：webgl 优先，失败降级 canvas 并缓存） | 采纳 VS Code `gpuAcceleration` 语义                                      |
| 文件布局   | 新增 `lib/renderers/webgl/`；**不移动** `lib/renderer.ts`（CanvasRenderer）                                       | 最小扰动，回退路径零风险                                                 |
| 顶点提交   | 每 cell 一个 quad，`Float32Array` 预分配 + `bufferSubData` 增量上传                                               | addon-webgl 同款；容量 = cols×rows 上限预分配                            |
| 字体度量   | 复用现有 `FontMetrics` / `measureFont` 逻辑——GL 与 Canvas 2D **必须同一套**                                       | selection/link 的 `pixelToCell` 依赖渲染几何一致                         |

## 里程碑

### M1 — GL 上下文与 rect pass（管线打通）

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
