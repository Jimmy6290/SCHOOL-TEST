# 开学小助手 · 面向大众的新生问答聊天网页

一个面向大众的开学问答聊天网页：学生打开链接即可使用，**无需注册、无需配置任何东西**。界面参照 Instagram 私信（DM）浅色风格，移动端优先，AI 自动回答新生关于报到、宿舍、缴费、军训、食堂等日常问题。

> 本版为**服务端架构**：AI 密钥、系统提示词、知识库都在服务端（`config.json` 或环境变量），前端是干净的聊天界面，任何拿到链接的人都能直接用。

## 一、本地运行

需要 Node.js 18+（本机已装 Node 24）。

```bash
cd /Users/chao/Documents/Codex/2026-09-01/bang-w/outputs
node server.mjs            # 正式模式（真实 AI 回复）
# 或
node server.mjs --mock     # 演示模式（不调用 AI，返回模拟回复，用于测试界面）
```

浏览器打开 <http://localhost:8000>。

> 端口可用参数修改：`node server.mjs 9000`；部署到托管平台时用环境变量 `PORT` 指定。

## 二、配置（服务端集中管理）

所有内容都在 `config.json` 里，改完保存即可生效（无需重启）：

| 字段 | 说明 |
| --- | --- |
| `apiKey` | DeepSeek API Key（在 https://platform.deepseek.com 申请）；也可用环境变量 `DEEPSEEK_API_KEY` 覆盖（部署推荐） |
| `baseUrl` / `model` | 兼容接口地址与模型，默认 DeepSeek，可换其他 OpenAI 兼容服务 |
| `botName` | 顶栏显示的小助手名称 |
| `welcomeMessage` | 首次进入机器人发的欢迎语 |
| `quickQuestions` | 开场显示的快捷问题按钮（每项一个） |
| `systemPrompt` | **小助手角色设定 + 校园知识库**：把学校官方通知、常见问题解答粘贴到这里，就是后期你想补充的"提示词"内容 |
| `rateLimit` | 每个 IP 每分钟最多请求次数（默认 20），防滥用 |

参考模板见 `config.example.json`。**`config.json` 含密钥，已加入 `.gitignore`，不会被提交到仓库。**

## 三、部署到公网（免费，约 10 分钟）

以 Render 为例（Railway 步骤类似）：

1. 把本项目推送到你的 GitHub 仓库（注意 `config.json` 不会提交，密钥走环境变量）。
2. 打开 <https://render.com> 注册/登录 → New → **Blueprint**（或 Web Service）。
3. 选择本仓库，Render 会自动识别 `render.yaml`，一键创建免费 Web Service。
4. 在 Dashboard 的 Service → **Environment** 里设置环境变量：`DEEPSEEK_API_KEY = sk-你的密钥`。
5. 部署完成后会得到一个公网地址（如 `https://kaixue-helper.onrender.com`），发给学生即可使用（平台自动带 HTTPS）。

> Railway：创建新项目 → Deploy from GitHub repo → 设置环境变量 `DEEPSEEK_API_KEY` → 获得 `.up.railway.app` 公网地址。两种平台免费额度对校级别流量足够。

## 四、日常维护

- **改知识库/提示词**：编辑 `config.json` 的 `systemPrompt` 后保存；本地直接生效，线上需重新部署（或把内容写死在环境变量/重启服务）。
- **看是否正常运行**：访问 `https://你的域名/api/config`，能返回 `botName/welcomeMessage/quickQuestions` JSON 即正常。
- **防滥用**：默认每 IP 每分钟 20 次请求，按需调整 `rateLimit`。

## 数据与隐私

- 聊天记录只保存在**每个用户自己的浏览器**（localStorage），服务端不存会话，保护隐私。
- API Key 只存在于服务端，前端无法获取。
