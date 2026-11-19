# Manuscript Workbench · 双语学术文稿研审台

开源通用的双语学术文稿研审工作台，面向使用 GitHub 管理 LaTeX（`.tex`）、Quarto（`.qmd`）、Markdown（`.md`）与 BibTeX（`.bib`）手稿的研究者与写作者，提供动态 Git 词元级比对、AI 侧边栏洁净读屏协作、合卷单章精读以及全库源码直检能力。

## 核心特性

- **动态 Git 词元级比对引擎**：输入任意 GitHub 仓库（`owner/repo`）即可挂载至内置本地工作目录 `/tmp/target-repo`，在「基准分支（默认 `main`）」与「审阅分支 / 开放 PR / 当前工作区」之间实时计算词元级（含 LaTeX 公式与中英文混排）差异卡片。
- **双语自动配对**：自动识别目标仓库中的双语映射文件（如 `content/translations.json`、`content/source-manifest.json`）或常见命名规范（`content/book/*.qmd` ↔ `content/en/book/*.qmd`、`*_cn.tex` ↔ `*_en*.tex`、`*_zh.md` ↔ `*_en.md`），将配对文稿归组为双语比对卡片，其余文件（如 `.bib`、配置文件）自动生成单文件变更卡片。
- **AI 协同审阅与洁净读屏**：
  - 支持「并排对比 / 行内融合 / 洁净读屏 (Gemini)」三种视图，洁净读屏模式隐藏红绿删除线，防止浏览器侧边栏 AI 误读旧稿；
  - 逐卡/逐段审阅状态（「待审 / 需讨论 / 已确认」）、行内批注与在线微调按 `repo + branch` 自动隔离持久化；
  - 一键「复制给 Gemini」与「导出结构化 Markdown / JSON 指令包」。
- **合卷全文精读与跨卷检索**：默认单章/单篇独立精读，支持中文 / 英文 / 中英对照切换、全卷关键词跨篇检索、行号点击区间选段复制给 AI，并保留按需连续滚动模式。
- **更多工具抽屉**：内置宽屏「全库文稿直检」（在线查看/编辑任意仓库文件与行号）、「自由推敲沙盒」与「协作规范」；若目标仓库自带 `research-dashboard.html`，将自动显示独立打开入口。
- **自动检测仓库校验脚本**：自动发现目标仓库 `scripts/` 中的校验与测试脚本，支持一键运行。

## 极简配置

工具内置默认基准分支 `main` 与本地缓存目录 `/tmp/target-repo`，**零配置即可直接启动并在界面中输入公开仓库 `owner/repo` 使用**。

仅提供 2 个可选运行时环境变量（参考 `.env.example`）：

| 环境变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `GITHUB_REPO` | 可选 | 启动时默认挂载的目标仓库，格式为 `owner/repo`（留空时可在界面顶栏输入切换） |
| `GITHUB_TOKEN` | 可选 | 仅挂载私有仓库或需要推送 PR 时在运行环境注入；**严禁写入任何代码或提交至仓库** |

## 快速启动

### 本地运行

```bash
npm install
npm run dev
```

启动后访问 `http://localhost:3000`。

### 在 Google AI Studio / 容器环境运行

1. 导入本仓库并安装依赖（`npm install`）；
2. 如需访问私有仓库，在运行环境的 Secrets / 环境变量面板配置 `GITHUB_TOKEN`（可选配 `GITHUB_REPO=owner/repo`）；
3. 启动开发或生产服务：
   - 开发模式：`npm run dev`
   - 生产构建与运行：`npm run build && npm start`

## 许可证

Apache-2.0
