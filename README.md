# MIDI 结构拆分器 (COSIATEC 优化版)

基于 **COSIATEC** 算法的 MIDI 音乐压缩与结构分析工具。通过迭代剥离和几何模式发现，自动识别音乐中的重复模式，将乐谱分解为「模式库 + 主干音符」的紧凑表示。

## 核心算法

本项目实现了音乐信息检索领域的经典算法：

- **SIA** (Structure Induction Algorithm) — 通过向量表计算最大可平移模式 (MTP)
- **SIATEC** — 为给定模式找到数据集中的所有平移向量
- **COSIATEC** — 迭代剥离式压缩：每轮选出最优模式 -> 移除覆盖音符 -> 重复

## 功能特性

- **拖拽上传** — 支持 .mid / .midi 文件
- **智能压缩** — COSIATEC 算法自动发现重复模式
- **重建视图** — 可视化模式覆盖与主干音符
- **模式库** — 浏览所有检测到的音乐模式
- **主干视图** — 查看未被模式覆盖的独特音符
- **时间轴** — 按轨道查看模式实例的排布
- **XML 导出** — 导出重建/拆分两种格式的结构化数据
- **可调参数** — 控制模式长度、重复次数、音高容差等

## 项目结构

```
midi-structure-splitter/
├── public/
│   ├── index.html          # 主页面
│   └── styles.css          # 样式
├── src/
│   ├── parser/
│   │   └── midi-parser.js  # MIDI 二进制解析器
│   ├── analyzer/
│   │   ├── sia.js          # SIA/SIATEC 模式发现
│   │   └── cosiatec.js     # COSIATEC 压缩算法
│   ├── ui/
│   │   ├── app.js          # 应用控制器
│   │   └── renderer.js     # UI 渲染
│   └── utils/
│       └── xml-generator.js # XML 生成器
├── docs/                   # 文档
├── test/                   # 测试
├── .github/workflows/      # CI/CD 配置
├── scripts/                # 工具脚本
├── package.json
└── README.md
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

然后在浏览器中打开 `http://localhost:3000`，上传 MIDI 文件或点击「加载示例」体验。

## 算法参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 最小模式长度 | 4 | 模式至少包含的音符数 |
| 最大模式长度 | 64 | 模式最多包含的音符数 |
| 最少重复次数 | 2 | 模式至少出现的次数（含原始） |
| 音高容差 | 0 | 音高匹配容差（半音） |
| 时间容差 | 6 | 时间匹配容差（tick） |
| 最大模式数 | 6 | 最多提取的模式数量 |
| 最小压缩比 | 2.0 | 模式的最小压缩比阈值 |
| 检测移调 | Yes | 是否检测移调重复 |
| 迭代剥离 | Yes | 是否迭代移除已覆盖音符 |

## 技术栈

- 纯前端实现（ES Modules），无需构建工具
- MIDI 二进制解析完全自研
- 使用 CSS 自定义属性实现暗色主题

## 参考文献

- Meredith, D., Lemstrom, K., & Wiggins, G. A. (2002). Algorithms for discovering repeated patterns in multidimensional representations of polyphonic music. *Journal of New Music Research*, 31(4), 321-345.

## License

MIT
