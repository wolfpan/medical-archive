# 家庭医学存档（Family Medical Archive）

一个可部署在自己服务器/家用电脑上的**私有家庭医学档案网站**：集中保存每位家庭成员的病历记录、就诊记录、检查影像（图片 / PDF 报告 / 视频）、诊断分析与复诊计划，复诊体检时随时打开即可查阅。

- **技术栈**：HTML + 原生 JavaScript + Node.js + SQLite（`node:sqlite` 内置模块）
- **零依赖**：不需要 `npm install`，拷贝目录即可运行
- **单用户双重验证登录**：scrypt 密码哈希 + HMAC 签名会话 Cookie（7 天有效、滑动续期）+ 登录失败限速锁定；除密码外还需输入任一档案成员的完整姓名（存在成员时自动启用）

## 功能

| 模块 | 说明 |
|------|------|
| 家庭成员 | 姓名/性别/出生日期/关系/既往史备注，按成员归档全部资料 |
| 病历记录 | 分类（就诊/检查报告/诊断分析/用药/手术/疫苗/体检）、主诉、诊断、治疗、备注分析 |
| 影像附件 | 图片、PDF、视频在线预览（视频支持拖动进度条），可关联到某条病历 |
| 复诊提醒 | 首页自动汇总"下次复诊日期"，逾期红色、30 天内橙色高亮 |
| 搜索 | 按成员/分类/关键词搜索病历与文件（标题、诊断、医院、备注全文匹配） |
| **资料录入（AI / 手工统一入口）** | 「添加资料」页选择文件与成员后二选一：AI 智能识别生成病历草稿，或手工录入（可建病历 + 上传任意文件）；报告正文逐字转录到"检查所见/报告原文" |
| **附件关联管理** | 病历详情页"管理附件"：勾选即可关联/取消关联该成员的任何文件，一处管理所有入口 |
| 打印 | 病历详情页一键打印，方便带给医生看 |
| 数据导出 | 一键导出全部数据为 JSON |

## 资料录入使用说明（统一入口「添加资料」）

1. **配置 AI（可选，仅 AI 识别需要）**：设置 → AI 服务配置。内置预设：智谱 GLM、阿里通义千问、OpenAI、Moonshot Kimi、DeepSeek（仅文本）、Ollama 本地，也支持任意 OpenAI 兼容接口。填 API Key 与模型名（识别图片需视觉模型），点"测试连接"验证。
2. **添加资料**：导航栏「添加资料」→ 第 1 步选归档成员（或 AI 自动识别）与文件 → 第 2 步选录入方式：
   - **AI 智能识别**：适合报告图片、PDF（整份阅读，扫描件支持）、问诊截图。**一次可选多份资料**：逐一识别后汇总——诊断与建议以附件中医生书面意见为准，无医生意见时由 AI 撰写。**多人资料自动拆分**为多条病历（按来源文件分配附件）。附件按"**日期 项目 机构 姓名**"自动重命名。
   - **手工录入**：填写病历信息（标题留空则仅上传附件）并上传所选文件；视频等无法识别的文件用此方式。
   - **姓名智能归档**：识别出的姓名被脱敏（如"张*三"）或有疑似错字（如"李四" vs 档案中的"李思"）时，自动匹配已有家庭成员档案（唯一匹配才采用，草稿卡上会注明并允许修改），避免重复建档。
3. **附件关联**：病历详情页点「管理附件」可随时把该成员的任何文件关联/取消关联到本病历；AI 识别类型：图片（jpg/png/webp 等）、PDF（整份阅读后汇总，扫描件/特殊编码均支持，最多前 40 页）、文本文件；视频不支持 AI 识别，请用手工录入。

> 多页报告（如 26 页体检报告）的处理方式：浏览器把整份 PDF 渲染为页面图片 → 每 6 页一批送视觉模型逐页提取（患者信息、各科室结果与数值、异常项、医生建议）→ 再由模型把各批内容**汇总为一份病历**（异常项按科室归类、提炼总体结论与后续复查建议），保证可读性。保存后附件为**原始 PDF 文件**，页面图片仅用于识别、不会入库。

> 隐私提示：AI 识别会把所上传的资料发送给你配置的 AI 服务商，请自行评估；如需数据完全不出内网，可部署 Ollama 本地视觉模型并将接口地址填为 `http://localhost:11434/v1`。API Key 仅保存在本服务器数据库，不会出现在前端页面（仅显示打码版本）。
>
> 相关环境变量：`AI_MAX_BODY`（AI 分析文件大小上限，默认 15MB）、`AI_TIMEOUT`（AI 请求超时，默认 120 秒）。

## 快速开始（本机 Windows）

1. 安装 [Node.js v23.4+](https://nodejs.org/)（推荐 v24 LTS）
2. 双击 `start.bat`（或命令行运行 `node server.js`）
3. 浏览器打开 `http://localhost:3000`，首次打开会引导你**设置管理密码**；添加档案成员后，登录还需输入任一成员的完整姓名（双重验证）
4. 局域网内手机/其他电脑访问启动窗口里显示的 `http://192.168.x.x:3000`

> 可选：运行 `node seed.js [资料目录] [成员姓名]` 导入一批演示文件试用（脚本本身不含任何真实医疗数据；正式资料通过网页「添加病历或资料」录入，全部保存在本机 data/ 目录，不会进入 git 仓库）。

## 部署到服务器（随时可查阅）

### 方式一：直接运行（Linux）

```bash
# 安装 Node.js 24（Debian/Ubuntu 示例）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 上传项目目录后
PORT=3000 node server.js
```

用 systemd 常驻运行（推荐）：

```ini
# /etc/systemd/system/medical-archive.service
[Unit]
Description=Family Medical Archive
After=network.target

[Service]
WorkingDirectory=/opt/medical-archive
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now medical-archive
```

或使用 pm2：`npm i -g pm2 && pm2 start server.js --name medical-archive && pm2 save && pm2 startup`

### 方式二：Docker

```bash
docker build -t medical-archive .
docker run -d --name medical-archive -p 3000:3000 -v /opt/medical-data:/app/data medical-archive
```

### HTTPS（公网访问强烈建议）

家用宽带建议只在内网/VPN 使用；如需公网访问，请务必套 HTTPS：

```nginx
server {
    listen 443 ssl;
    server_name archive.example.com;
    ssl_certificate     /etc/letsencrypt/live/archive.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/archive.example.com/privkey.pem;
    client_max_body_size 220m;          # 与上传上限匹配

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_buffering off;            # 视频流畅播放
    }
}
```

证书可用 `certbot` 免费申请。配置后建议防火墙只放行 443。

## 数据备份与恢复

- 全部数据都在 **`data/`** 目录：`archive.db`（SQLite 数据库）+ `uploads/`（附件原件）
- **备份**：停止服务（Ctrl+C 或 `systemctl stop`），复制整个 `data/` 目录
- **恢复**：把备份的 `data/` 覆盖回来，重启服务即可
- 网页"设置"页也可一键导出 JSON（不含附件文件本体）

## 常用维护

| 操作 | 命令 |
|------|------|
| 启动 | `node server.js`（端口用环境变量 `PORT` 修改） |
| 忘记密码 | `node reset-password.js`，然后打开网页重新设置 |
| 导入初始资料 | `node seed.js [资料目录]`（可重复执行，自动跳过已存在） |
| 上传大小上限 | 环境变量 `MAX_UPLOAD`（字节，默认 200MB） |

## 安全说明

- 密码使用 scrypt 加盐哈希存储，明文不落盘；连续输错 5 次锁定该 IP 15 分钟
- 登录双重验证：密码 + 任一档案成员完整姓名（需完整输入；两项错误合并提示，不暴露是哪一项错）；尚无成员时仅校验密码，避免初装锁死
- 会话 Cookie 为 HttpOnly + SameSite=Strict，服务端 HMAC 签名验证
- 所有接口（含影像文件）均需登录后才能访问；响应带 CSP、nosniff 等安全头
- 这是**单用户**系统：知道密码的家人都能增删数据，请只把密码给信任的人
- 请勿在未加密（纯 HTTP）的公网环境使用，避免健康信息泄露

## 常见问题

- **启动报"缺少 node:sqlite"**：Node 版本过低。升级到 v23.4+；v22.5~v23.3 可用 `node --experimental-sqlite server.js`
- **启动时出现 "SQLite is an experimental feature" 警告**：Node 对内置模块的提示，功能正常，可忽略
- **视频无法拖动进度条**：本服务已支持 Range 请求，若经反代出现该问题，检查代理是否关闭了缓冲（`proxy_buffering off`）

## 免责声明

本系统仅用于家庭资料存档与查阅便利，不构成医疗建议；诊断与治疗请以医生面诊意见为准。

## 目录结构

```
medical-archive/
├── server.js           # 服务端（HTTP + SQLite + 鉴权 + 文件服务）
├── seed.js             # 演示数据导入脚本（不含真实医疗信息）
├── reset-password.js   # 忘记密码重置工具
├── package.json
├── start.bat           # Windows 一键启动
├── Dockerfile
├── public/             # 前端（index.html + app.js + style.css）
└── data/               # 运行数据（数据库 + 上传附件），备份此目录即可
    └── uploads/
```
