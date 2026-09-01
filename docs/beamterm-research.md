# 调研：beamterm 深度评估（GPU instanced 渲染架构）

> 状态：调研完成。结论：**不作为依赖引入，但其 GPU 数据组织方式取代
> addon-webgl 成为本 fork WebGL 计划（M3）的第一参照**。
> 前置阅读：`docs/webgl-renderer-research.md`（§2.5 曾以一句话否决本方案，
> 本文修正该结论的两处事实错误并重审）。
> 数据核实日期：2026-09-01。

## 1. 为什么重审

上次调研（§2.5）对 beamterm 的记载与结论：

> beamterm（Rust + wgpu 编译 WASM + WebGL2 instanced rendering，宣称亚毫秒
> 渲染；……它证明渲染器整体 wasm 化 + wgpu 这条路真实可行，但引入
> Rust/wgpu 工具链，本 fork 不采用。

两处事实错误（本次核实）：

1. **它不用 wgpu**。`beamterm-renderer/Cargo.toml` 依赖清单：`wasm-bindgen`
   - `web-sys`（`WebGl2RenderingContext` 等 feature）——手写 WebGL2 绑定，
     零 wgpu/GPU 抽象层。"渲染器整体 wasm 化没有障碍（wgpu 直接驱动 GPU）"
     的论据不成立，但同时也意味着**没有 wgpu 的体积与工具链重量**。
2. **性能声称的依据比预期扎实**。45k cells（426×106）< 1ms 是 2019 桌面硬件
   （i9-9900K / RTX 2070）的实测口径，且该数字**含** ratatui buffer 翻译 +
   GPU 上传 + draw call 全链。数字可信；硬件口径偏高端（见 §4 系数讨论）。

一句话否决的依据既已修正，值得完整评估。

## 2. 项目事实（2026-09-01 核实）

| 维度            | 数据                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| 仓库            | `kofany/beamterm`，MIT，纯 Rust                                                                      |
| 星 / fork       | **0 / 0**                                                                                            |
| npm             | `@beamterm/renderer` 1.0.0（2026-03-30 发布），**周下载 91**，unpacked 5.9MB（含 atlas 数据与 demo） |
| 开发窗口        | 2025-10 起，2025-12（40 commits）+ 2026-01（45 commits）高强度，**主线最后 commit 2026-01-19**       |
| GitHub releases | 0（仅 crates.io + npm 发布，16 版 0.2.0→1.0.0）                                                      |
| 作者            | kofany（个人项目，无组织背书）                                                                       |
| CI              | GitHub Actions 有 wasm 构建 + wasm-pack test（有测试纪律，非玩具）                                   |

**成熟度结论：零生产验证、停滞 7 个月、单人项目。作为运行时依赖 = 事实
上自己维护一个陌生 Rust 代码库。依赖引入路径出局。**

## 3. 架构深读（源码逐文件核实）

### 3.1 crate 划分

```
beamterm-atlas      静态 atlas 生成 CLI（TTF→packed 纹理，含 cell 尺寸推导）
beamterm-data       CellData/FontAtlasData 结构 + 版本化二进制序列化
beamterm-renderer   WebGL2 引擎：gl/{renderer,terminal_grid,static_atlas,
                    dynamic_atlas,glyph_cache,selection,context_loss,...}
js/                 wasm-bindgen JS API + npm 打包
```

### 3.2 GPU 数据组织（对本 fork 最有价值的部分）

**每 cell 的 instance 数据只有 8 字节**，两个 `uvec2`：

```
a_instance_pos : uvec2   像素位置（cell_x, cell_y 网格坐标）
a_packed_data  : uvec2   [x] glyph_id:16 | fg RGB:16
                        [y] bg RGB:24
```

`cell.vert` 的关键设计（全部可在 TS/GLSL 直接复刻）：

- **单 quad 几何 + instancing**：静态 4 顶点，`gl.drawElementsInstanced` 一次
  画全屏；quad 展开零 CPU 成本。
- **颜色在 vertex shader 解包**（extract_byte），以 `flat out vec3` 传给
  fragment——注释明确是为了绕 ANGLE 的 fragment 精度 bug。
- **像素对齐在 GPU 侧**：`floor(grid_pos * u_cell_size + 0.5)`，highp，
  注释明确是防 ANGLE 单元格间隙。这两条 ANGLE 注释是踩过坑的证据。
- `glyph_id` 16 位是个**超集位域**：低 12 位 glyph id（4096 slot），
  bit12 = emoji（frag 采样原色不做色乘），bit13 = underline，bit14 =
  strikethrough。**下划线/删除线不占 instance 数据、不进 atlas 变体**，
  由 frag shader `horizontal_line()`（smoothstep）按 UBO 里的位置/厚度
  参数即时画线。

对比 addon-webgl（现计划 M3 的参照）：per-cell CPU 展开 4 顶点 × ~10
float ≈ 40B/cell 每帧 JS 生成 + 上传。beamterm 是 **8B/cell 且静态位置**，
脏 cell 才改 `Vec<CellDynamic>` 副本，`cells_pending_flush` 脏标记一次
`bufferSubData`。45k cells < 1ms 与该设计自洽。

**数量级 sanity check（本 fork 口径，80×24≈2k cells / 200×60≈12k cells）：
即使按 10× 硬件系数折算，instance 上传与 draw call 也远非瓶颈。瓶颈更早
落在 cell 快照遍历与 glyph 查询——那部分两边架构相同，都在 CPU。**

### 3.3 纹理组织

- `sampler2DArray`，**32 glyph/layer**（`pos_in_layer & 0x1F`，层号 `>>5`），
  `texStorage3D` immutable storage。
- 双宽/emoji：两个连续 slot（`Wide(id)` → 右半格直接写 `id+1`，CPU 侧
  `skip_next`）。
- 静态 atlas（`.atlas` 二进制，Hack 8/10pt）与动态 atlas（`OffscreenCanvas`
  按需光栅化，ASCII 0x20-0x7E 启动预热，4096 slot 上限 = 2048 单宽 +
  1024 双宽，LRU 驱逐）二选一。动态路径与本 fork 计划的 tmpCanvas
  方案同构。

### 3.4 健壮性协议（M1 计划可直接抄清单）

- **context loss**：`GpuResources` 结构（shader/VAO/UBO/sampler 全量收口）
  - `context_loss.rs`，恢复 = 重建该结构。atlas/selection/cells 等 CPU 态
    存活。
- **atlas 热替换**（`replace_atlas`）：旧 glyph_id → 查 symbol → 新 atlas
  重解析 → 全网格平移 + 双宽右半格修正 + resize 联动。字体/字号切换的
  完整迁移协议，比"全失效重光栅化"更细。
- 选择：`SelectionTracker` + Block/Linear 两模式 + cell query（trim
  trailing whitespace 可配）。

### 3.5 JS API 与跨界成本（依赖路径的硬伤）

JS 侧 cell 喂入协议：

```js
batch.cells([[x, y, {symbol: "🚀", style, fg, bg}], ...])
```

`Cell { symbol: CompactString, ... }` 走 `serde_wasm_bindgen::from_value`
逐对象反序列化。对本 fork 意味着每帧：

```
ghostty wasm (GhosttyCell 数组)
  → JS：每 cell 建对象 + codepoint→字符串化（String.fromCodePoint）
  → beamterm wasm：serde 逐对象跨界
```

**双 wasm 模块之间无直接内存通道，必须过 JS 中转**——这正是本 fork
R1 计划要消灭的同型跨界（24× 整屏拷贝教训），只是换了方向。Rust 侧原生
API（`update_cells(Iterator<Item=CellData>)`）没有跨界，但用它意味着把
ghostty VT 核心与 beamterm 链进**同一个** wasm，本 fork 的 selection/
hyperlink/scrollback/theme 全在 TS——等于重写整个前端。排除。

## 4. 三条路径评估

| 路径                      | 结论 | 一句话理由                                                                                                       |
| ------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| A. npm 依赖引入（JS API） | ✗    | 双 wasm 过 JS 中转 = 重新引入 R1 消灭的跨界；0 社区 + 停更 7 个月 + 单人维护                                     |
| B. Rust 侧链同一个 wasm   | ✗    | 要求 ghostty VT + renderer 同 wasm，TS 侧全部交互逻辑需 Rust 重写，工程量与风险不成比例                          |
| C. **TS 移植其 GPU 设计** | ✓    | WebGL2/整数 attribute/GLSL 在 TS 直接可用；shader 与 buffer 协议按 §3.2/3.3 复刻；无新工具链、无跨界、无外部依赖 |

## 5. 对 `webgl-renderer-plan.md` 的修正建议

M3（Glyph pass）当前参照 addon-webgl（quad CPU 展开）。**改为 beamterm 式
instanced 设计**，具体替换：

1. **instance 布局**：8B/cell（`uvec2 pos + uvec2 packed`），弃 per-cell
   quad 展开。`RGBA32UI`/integer attribute 路径（WebGL2 原生，GLSL 300 es）。
2. **单 draw call**：静态 quad + `drawElementsInstanced`；脏 cell 集合
   更新 instance buffer（`bufferSubData` 范围上传），非全量重建。
3. **效果位域**：本 fork flags（underline/dim/inverse）中影响绘制的位
   打进 packed 字段富余位（16 位 glyph id 后仍有 16 位空间），underline
   走 frag shader `horizontal_line()`，不进 atlas 变体——与现计划 M2 的
   缓存键设计（underline/strike 走 rect pass）相比，beamterm 方案少一个
   pass 且随字形变形。dim/inverse 仍走颜色路径（fg/bg 交换/缩放在 CPU
   侧解析时完成，本 fork 颜色上游已解析成 RGB）。
4. **纹理组织**：`sampler2DArray` + 32/layer + texStorage3D 替代单页
   2D atlas；双宽连续 slot 协议照抄。
5. **ANGLE 对策直接采纳**：颜色 vertex 侧解包（flat varying）、
   highp + GPU 侧 floor 像素对齐——两处都是生产踩坑证据。
6. **context loss / atlas 热替换**：M1/M5 的验收清单按 §3.4 结构化。
7. **保留 addon-webgl 作为 atlas 管理参照**（其 TextureAtlas 的页增长/
   LRU 合并/失效协议更成熟，beamterm 的 4096 固定 slot 是简化）。

M1-M6 里程碑结构、WebGL1→WebGL2 决策、auto 降级链、决策门（R1-R3 先行

- profile:terminal 基线）不变。**注意：instanced + integer attribute +
  sampler2DArray 都是 WebGL2 特性，M0 的"WebGL1 起步"决策需要重审为
  WebGL2（VS Code 数据：canvas 渲染器保留仅因个别旧 iPad 无 WebGL2；本
  fork 走 auto 降级链覆盖该人群即可）。**

## 6. 结论

- beamterm 不可引入（§2 成熟度 + §3.5 跨界），上次调研的否决结论方向
  正确但理由错误（非 wgpu；工具链不是主要障碍，跨界与维护才是）。
- 其 GPU 数据组织（8B/cell instanced + 位域 + texture array + shader 画线）
  **显著优于** addon-webgl 的 CPU quad 展开方案，且源码 ~5k 行 Rust 中
  渲染核心（terminal_grid + shaders + atlas）可读性良好，shader 可近乎
  逐行翻译成 TS 常量。
- 行动项：按 §5 修订 `webgl-renderer-plan.md` M3 设计；WebGL1 决策升级
  为 WebGL2；决策门不变（R1-R3 + 生产基线先行，p95 超预算且 raster 主导
  才动工）。
