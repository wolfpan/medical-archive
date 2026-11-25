# 项目记忆

## 项目概况
- 家庭医学存档：私有家庭病历/影像归档网站。零依赖 Node.js（>=23.4，内置 `node:sqlite`）+ 原生前端，无构建步骤、无测试框架。
- 关键文件：`server.js`（HTTP 服务 + API + 静态文件，每次请求从磁盘读静态文件）；`public/app.js`（单页前端，hash 路由）；`install.sh`（Debian/Ubuntu 一键安装/升级）。
- 数据在 `data/`（SQLite + uploads 附件），已 gitignore：**勿提交、勿覆盖、勿删除**。
- 接口状态码约定：**401 仅用于会话失效**（前端 `api()` 见 401 即跳回登录页）；上游 AI 服务商拒绝（Key 无效/无权限）用 502，表单校验错误（如当前密码不正确）用 400，勿混用。
- 改动后校验：`node --check server.js`、`node --check public/app.js`（本机 node 不在 PATH，可用 DSH  bundled node：`C:\Users\panft\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）。

## 提交规范
- 提交信息风格：`V0.xx：中文摘要`（功能批次升 minor，小修补升 patch），`package.json` 的 version 同步更新；纯文档/记忆类提交可不带版本号。

## 发布流程：推送到 GitHub 并在服务器拉取
1. **本地提交推送**：`git add <files>` → `git commit` → `git push origin main`（远程 `git@github.com:wolfpan/medical-archive.git`，公开仓库，**勿提交服务器连接信息、密钥等敏感内容**）。
2. **服务器拉取**：SSH 登录后进入部署目录 `git pull --ff-only`。
3. **重启生效**：`server.js` 有改动时必须重启 pm2 进程；仅改 `public/` 前端时刷新浏览器即可，无需重启。
4. **验证**：pm2 状态 online、`curl` 首页返回 200、抽查线上 `app.js` 包含本次改动。
- 服务器主机/用户/部署路径/端口/进程名与完整命令模板见本机 **`AGENTS.local.md`**（已 gitignore，不入库；DSH 会自动加载它作为本地覆盖层）。
- 服务器端 git remote 使用 SSH 别名 `github.com-medical-archive`（部署密钥），保持原样即可。

## AI 服务商预设维护
- 预设集中在 `public/app.js` 的 `AI_PRESETS`（设置 → AI 服务配置）。更新预设前**先查各家官方文档**确认当前模型名、视觉能力与 OpenAI 兼容端点。
- 固定采样参数模型（Kimi K 系列、OpenAI GPT-5/o 系列）拒绝非默认 `temperature`（400）：`server.js` 的 `fixedSampling()` 已按模型名前缀省略该参数，新增此类模型时需纳入判断。
- 服务端以 OpenAI 兼容 `image_url` + base64 传图；Kimi 视觉仅支持 base64/文件 ID（不支持外部 URL），与本实现兼容。
- 已保存的用户配置不受预设更新影响（预设仅在切换下拉时自动填充，按 base URL 匹配选中项）。
- 设置页模型列表：`POST /api/ai/models` 由服务端代理 `GET {base}/models`（Key 留空用已保存值；Ollama 允许无 Key）；前端 `loadAiModels()` 在填写接口地址/Key、切换预设、打开设置页时自动触发。模型与问诊模型均为真正的 `<select>` 下拉框（隐藏 input 存表单值），含「手动输入…」兜底切换文本框；勿用 datalist（浏览器渲染为悬浮提示泡泡，非下拉框）。