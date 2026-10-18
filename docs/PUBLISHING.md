# 分发与上架（维护者）

## DeepSeek Harness 的插件分发方式（以 0.2.1-rc.2 为准）

- **目前没有官方插件市场。** 官方设计文档原文：“No official market exists, and one may be added later”。
- **桌面版可以直接按包名安装**：“插件 → 添加插件”输入 npm 包名，例如 `dsh-dujiangyan-dispatch`。前提是已发布到 npm。
- **也可以从 Git 安装**：`dsh plugin --profile desktop add github:klinkdev2026/dsh-dujiangyan-dispatch`。仓库里提交了构建产物 `lib/`，所以安装时不需要构建。
- **“发现”页可以搜索，但要先添加市场索引**（插件 → 发现 → 索引源）。
- **社区市场**：dsh-plugin.org、dshfind、dsh-plugin-shop 等都是社区维护的非官方市场（dsh-plugin.org 页脚注明“社区维护的非官方插件市场，与 DeepSeek AI 无隶属关系”）。多数按 npm 关键词或 GitHub topic `dsh-plugin` 自动收录，也有的提供“提交插件”页面。

## 列表里显示的内容从哪来

| 列表上显示 | 来源 |
|---|---|
| 标题和简介（中、英） | `locale/zh.json`、`locale/en.json` 的 `meta.title`、`meta.description`；`package.json` 的 `description` |
| 图标 | `package.json` 的 `"icon": "./icon.svg"` |
| 兼容版本 | `package.json` 的 `engines.dsh` |
| 被搜索到 | `keywords` 含 `dsh-plugin`、`deepseek-harness`；GitHub topics 含 `dsh-plugin` |

## 发布清单

1. 改代码后执行 `npm run typecheck && npm test && npm run compile`，**把 `lib/` 一起提交**（Git 安装依赖它）。
2. 更新 `CHANGELOG.md`、`package.json` 和 `src/mcp.ts` 里的版本号。
3. 推送到 GitHub，确认 CI 在 Windows、macOS、Linux 上都通过。
4. 发布 npm：预发布版本用 `npm publish --tag next`，正式版本去掉 `--tag next`。`prepublishOnly` 会先跑类型检查、测试和构建。
5. 验证：在一台干净的桌面版上“添加插件”输入包名，确认能装上、左侧栏出现“都江堰”、`~/.dsh/dujiangyan/CONNECT.md` 已生成。
6. 官方市场推出后，按它的规则提交。
