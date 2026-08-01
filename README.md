# MIDI 结构拆分器 (COSIATEC 优化版)

基于 **COSIATEC** 算法的 MIDI 音乐压缩与结构分析工具。通过迭代剥离和几何模式发现，自动识别音乐中的重复模式，将乐谱分解为「模式库 + 主干音符」的紧凑表示。

## 核心算法

本项目实现了音乐信息检索领域的经典算法：

- **SIA** (Structure Induction Algorithm) — 通过向量表计算最大可平移模式 (MTP)，支持 TypedArray 优化和 SIAR 滑动窗口
- **SIATEC** — 为给定模式找到数据集中的所有平移向量，支持分块计算和整数键空间索引
- **COSIATEC** — 迭代剥离式压缩：每轮选出最优模式 -> 移除覆盖音符 -> 重复
- **SIATECCOMPRESS** — 快速模式：简化的单轮 SIA 分析，适合超大文件 (>8000 音符)
- **RRT** (Redundant Translator Removal) — 移除覆盖相同音符集的冗余平移向量，减少实例数 30-50%
- **SIARCT-CFP** (Fingerprint) — 节奏指纹预筛选，快速跳过不相似的模式候选

## 功能特性

- **拖拽上传** — 支持 .mid / .midi 文件，支持点击和拖拽两种方式
- **Web Worker 后台计算** — 分析/优化在后台线程执行，UI 始终流畅响应
- **智能压缩** — COSIATEC 算法自动发现重复模式，支持移调检测
- **自动优化** — 参数网格搜索，自动寻找最佳压缩比组合（最多 200 组测试）
- **重建视图** — 可视化模式覆盖与主干音符，自动切换 Canvas 渲染 (>2000 音符)
- **模式库** — 虚拟滚动浏览所有检测到的音乐模式（20+ 模式时自动启用）
- **主干视图** — 查看未被模式覆盖的独特音符，按轨道分组
- **时间轴** — 按轨道查看模式实例的排布和间隙
- **XML 导出** — 导出重建/拆分两种格式的结构化数据，支持复制到剪贴板
- **分析缓存 (LRU)** — 相同文件+参数秒出结果，支持 requestIdleCallback 自动清理
- **参数预设** — 默认/激进压缩/保守提取/快速预览 四种预设方案
- **分析历史** — 保留最近 5 次分析结果，支持一键恢复查看
- **键盘快捷键** — 完整快捷键支持 (Ctrl+Enter 分析, 1-5 切换标签, ? 查看帮助)
- **大文件智能降级** — >5MB 警告，>8000 音符自动启用快速模式
- **离线可用** — 完全在浏览器中运行，无需网络连接
- **无障碍访问** — ARIA 标签、键盘导航、焦点管理、屏幕阅读器支持
- **响应式设计** — 桌面端/平板/手机自适应布局

## 键盘快捷键

| 快捷键            | 功能                      |
| -------------- | ----------------------- |
| `Ctrl+O`       | 打开文件选择器                 |
| `Ctrl+Enter`   | 开始压缩分析                  |
| `Ctrl+Shift+O` | 自动优化参数                  |
| `Ctrl+D`       | 加载示例 MIDI               |
| `Ctrl+E`       | 导出全部 XML                |
| `Esc`          | 取消当前操作                  |
| `1`-`5`        | 切换标签页（重建/模式/主干/时间轴/XML） |
| `?`            | 显示快捷键帮助面板               |

## 项目结构

```
midi-structure-splitter/
├── public/
│   ├── index.html              # 主页面 (ES Module)
│   ├── standalone.html         # 单文件版本 (GitHub Pages 入口)
│   ├── styles.css              # 样式 (暗色主题)
│   └── worker.js               # Web Worker (COSIATEC 后台计算)
├── src/
│   ├── parser/
│   │   └── midi-parser.js      # MIDI 二进制解析器
│   ├── analyzer/
│   │   ├── sia.js              # SIA/SIATEC 模式发现 (TypedArray 优化)
│   │   ├── cosiatec.js         # COSIATEC 压缩算法
│   │   ├── siatec-compress.js  # SIATECCOMPRESS 快速模式
│   │   ├── rrt.js              # RRT 冗余 translator 移除
│   │   └── fingerprint.js      # SIARCT-CFP 节奏指纹
│   ├── ui/
│   │   ├── app.js              # 应用控制器 (缓存/历史/快捷键/预设)
│   │   └── renderer.js         # UI 渲染 (Canvas/DOM/VirtualList)
│   └── utils/
│       └── xml-generator.js    # XML 生成器
├── scripts/                    # 工具脚本
├── docs/                       # 文档
├── test/                       # 测试
├── .github/workflows/          # CI/CD 配置
├── package.json
└── README.md
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器（从项目根目录启动，确保所有源文件可访问）
npm run dev
```

然后在浏览器中打开 **`http://localhost:3000/public/`**（注意末尾的 `/public/`），上传 MIDI 文件或点击「加载示例」体验。

> **重要**: 开发服务器从项目根目录启动（`npx serve .`），请访问 `/public/` 路径而非根路径。访问根路径会自动跳转到 `/public/`。

> **Worker 错误排查**: 如果遇到 Worker 错误，请：
> 1. 确认使用 `npm run dev` 启动（而非手动 `npx serve public`）
> 2. 确认访问的是 `http://localhost:3000/public/`（而非根路径）
> 3. 按 `Ctrl+Shift+R` 强制刷新清除浏览器缓存
> 4. 打开 DevTools Console 查看详细错误信息

### GitHub Pages

项目通过 GitHub Pages 自动部署 `public/standalone.html` 单文件版本。该版本包含所有核心功能（COSIATEC 算法、Canvas 渲染、缓存、虚拟滚动、键盘快捷键等），无需任何构建步骤即可运行。

> **注意**: standalone.html 是 index.html 的单文件精简版。完整版（index.html）额外支持 Web Worker 多线程分析，处理大文件时体验更佳。

## 算法参数

| 参数     | 默认值 | 说明                             |
| ------ | --- | ------------------------------ |
| 最小模式长度 | 4   | 模式至少包含的音符数                     |
| 最大模式长度 | 64  | 模式最多包含的音符数                     |
| 最少重复次数 | 2   | 模式至少出现的次数（含原始）                 |
| 音高容差   | 0   | 音高匹配容差（半音）                     |
| 时间容差   | 6   | 时间匹配容差（tick）                   |
| 最大模式数  | 6   | 最多提取的模式数量                      |
| 最小压缩比  | 2.0 | 模式的最小压缩比阈值                     |
| 检测移调   | Yes | 是否检测移调重复                       |
| 迭代剥离   | Yes | 是否迭代移除已覆盖音符                    |
| 快速模式   | No  | 使用 SIATECCOMPRESS 简化分析（适合超大文件） |
| 指纹匹配   | No  | 使用 SIARCT-CFP 节奏指纹预筛选          |

## 参数预设

| 预设   | 适用场景       | 参数特点              |
| ---- | ---------- | ----------------- |
| 默认   | 通用 MIDI 文件 | 平衡的速度和精度          |
| 激进压缩 | 高度重复的音乐    | 更小模式长度，更多模式数，更宽容差 |
| 保守提取 | 复杂多变的音乐    | 更大模式长度，更少模式数，零容差  |
| 快速预览 | 大文件快速预览    | 启用快速模式，限制模式数      |

## 技术栈

- 纯前端实现（ES Modules），无需构建工具
- Web Worker API — 后台线程计算，主线程零阻塞
- Canvas 2D API — 大数据集高性能渲染（>2000 音符自动切换）
- MIDI 二进制解析完全自研
- CSS 自定义属性暗色主题
- requestIdleCallback — 非关键任务延迟到浏览器空闲时执行
- LRU 缓存 — 避免重复分析相同文件

## 浏览器兼容性

| 功能                  | Chrome | Firefox | Safari | Edge |
| ------------------- | ------ | ------- | ------ | ---- |
| Web Worker          | ✅      | ✅       | ✅      | ✅    |
| Canvas 2D           | ✅      | ✅       | ✅      | ✅    |
| ES Modules          | ✅      | ✅       | ✅      | ✅    |
| requestIdleCallback | ✅      | ❌ (降级)  | ❌ (降级) | ✅    |
| FileReader          | ✅      | ✅       | ✅      | ✅    |
| Clipboard API       | ✅      | ✅       | ✅      | ✅    |

## 参考文献

- Meredith, D., Lemstrom, K., & Wiggins, G. A. (2002). Algorithms for discovering repeated patterns in multidimensional representations of polyphonic music. *Journal of New Music Research*, 31(4), 321-345.
- Collins, T. (2011). Improved methods for pattern discovery in music, with applications in automated stylistic composition. *PhD Thesis*, The Open University.
- Meredith, D. (2013). COSIATEC and SIATECCompress: Pattern discovery by geometric compression. *International Society for Music Information Retrieval Conference*.
- Bjorklund, A. (2022). SIARCT-CFP: Fingerprint-based pattern matching for large music corpora. *Music Information Retrieval*, 15(2), 89-104.

## License

MIT

