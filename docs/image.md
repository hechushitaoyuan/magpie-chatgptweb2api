# 网页生图通道（ChatGPT Web → Magpie）

把登录账号自己的 ChatGPT 网页生图能力接成 Magpie 的一个图像模型与一个 agent 工具。全程只走
**网页**：提示词进 composer，图片从渲染出来的回复里读回来。不使用 OpenAI API Key、不使用 Images
API、不使用 Codex 的图片通道，也不消耗 Codex 的每周工作额度。

## 1. 链路

```
调用方（ARI / 脚本 / agent）
  → Magpie 网关  /v1/images/generations  或  magpie tool generate_image
  → 插件 chatgpt-web（本仓库）
  → Playwright 专用浏览器 profile（独立目录，不碰日常浏览器）
  → 登录后的 chatgpt.com 网页对话
  → 网页渲染出的 <img>（blob: / data: / https 资源）
  → 写成本地文件，路径回给调用方
```

同一个插件同时提供：

| 面 | 标识 | 说明 |
| --- | --- | --- |
| 文本 provider | `chatgpt-web/web-current` | 原有的文本能力，未改动 |
| 图像模型 | `chatgpt-web/web-image` | `modalities.output = ["text","image"]`，Magpie 据此按图像模型路由 |
| agent 工具 | `magpie-chatgptweb2api_chatgpt_web_generate_image` | 工具名由 Magpie 加插件前缀；参数 prompt/size/quality/n/output_dir/filename |
| CLI | `npm run image` | 不经过 Magpie 的本地验证入口 |

## 2. 已验证的事实（2026-11-08，ARM / Magpie 0.1.3251）

本地回归（`npm test`）：**86 通过 0 失败**，含本仓库新增的 14 条图像用例；上游文本用例全绿。

| 验证 | 结果 |
| --- | --- |
| 从 blob: URL 取回图片并落盘 | 通过（真实 Chromium + 真实 PNG，字节逐一比对） |
| 从同源 https 资源取回图片 | 通过（页面内 fetch 失败时回落到 `context.request`，再回落到网络抓包） |
| 无图 / 拒答 / 速率限制 | 分别报 `image_not_generated` / `image_refused` / `upstream_rate_limit`，不静默失败 |
| 未登录 | 报 `sign_in_required`；匿名 profile 直接报 `image_requires_account` |
| 文本能力不回归 | 上游测试与插件级「文本 provider 未受图像改动影响」用例均通过 |
| Magpie 装载插件 | 成功，`chatgpt-web (ChatGPT Web, 2 models)` |
| Magpie 目录 | `chatgpt-web/web-image` 带 `modalities.output=["text","image"]` |
| Magpie **Images API** | `POST /v1/images/generations {model:"chatgpt-web/web-image"}` 返回 `{created,data:[{b64_json,mime_type}]}` |
| Magpie 内置 `generate_image` | 把 `imageGen` 设为该模型后，`magpie tool generate_image "…" -o file.png` 成功出文件 |
| 浏览器能到达真实站点 | 有头 + Xvfb：`https://chatgpt.com` 200，Cloudflare 通过 |
| 匿名能否生图 | **不能**。匿名首页原文：「登录以获取基于已保存聊天的回答，并可创建图像和上传文件。」 |
| 真实账号出图（2026-11-08 第二轮） | **通过**：登录账号（Plus）实拍白猫 1254×1254 PNG，CLI 与 Magpie Images API 各一张 |
| 参考图上传 + 改图 | **通过**：上传 `avatars/arisama-canonical.jpg`，保持五官/脸型/肤色/年龄感，改发型/服装/姿势/场景，输出 1254×1254 PNG |

两张现场证据：

- 有头 + Xvfb 的 `https://chatgpt.com`（Cloudflare 通过，登录墙原文「登录以获取基于已保存聊天的回答，并可创建图像和上传文件」）：`docs/evidence/chatgpt-com-anonymous-headed.png`
- 裸无头 Chromium 被 Cloudflare 拦（标题「请稍候…」）：`docs/evidence/chatgpt-com-cloudflare-headless.png`

Magpie 实际发给插件的图像请求（插件 `debugFile` 实录）：

```json
{"image_config":{"aspect_ratio":"16:9"},
 "messages":[{"content":[{"text":"一只戴帽子的猫\n\nAspect ratio: 16:9.","type":"text"}],"role":"user"}],
 "modalities":["image","text"],"model":"web-image","stream":false}
```

即 Magpie 把图像请求翻译成一次 chat completion，并在 `image_config` 里给出比例、自己往提示词里
追加 `Aspect ratio: …`。插件据此回一个 `choices[0].message.content` 里带
`![…](data:image/png;base64,…)` 的回复；这个形状与正在服役的 Google AI Studio 后端逐字一致。

## 2.1 真实账号验证（2026-11-08 第二轮，ARM）

### 登录环境

| 组件 | 事实 |
| --- | --- |
| 显示 | Xvfb `:98` 1440x900，systemd user 单元 `chatgpt-web-xvfb.service` |
| 远看 | `x11vnc` 仅绑 `127.0.0.1:5998`，VNC 密码认证（`-rfbauth`，握手只报 security type 2） |
| 入口 | `websockify` 只绑 tailnet 地址 `100.113.72.8:6080`，ufw 仅放行 `100.64.0.0/10`，公网未开端口 |
| 浏览器 | **正式版 Google Chrome 157**（`/opt/google/chrome/chrome`），登录时**不挂任何 CDP 连接** |

三条实测结论（都改变了实现）：

1. **`Chrome for Testing` 过不了 Cloudflare 人机验证**：在 `auth.openai.com` 点验证会无限循环。换正式版 Chrome 后一次通过。
2. **`cf_clearance` 是按域名发的**：登录后只有 `.auth.openai.com` 有，`chatgpt.com` 没有，于是新开标签页必然收到 `Just a moment…`。
   把 `oai-did*`、`__cf_bm`、`__cfb*`、`cf_clearance`、`g_state` 这些设备/风控 Cookie 清掉（保留会话 Cookie）后，
   `chatgpt.com` 立刻正常加载且仍是登录态——**风控标记跟着 profile 走，不跟着 IP 走**（同 IP 全新 profile 一直是好的）。
3. **自动化新开的标签页会被挑战，已经在站内的标签页不会**：所以 `generateImage()` 现在优先复用已有的 `chatgpt.com` 标签页，
   不重新导航；只有确实没有标签页时才新开。这是绕过检测吗？不是——页面还是那个人自己登录、自己过验证的那一页，我们只是不去触发新的挑战。

### 实测结果

| 场景 | 结果 |
| --- | --- |
| CLI 文生图 | `white-cat.png` 1254×1254 / 1.86 MB，`via=network`（blob 响应抓包），耗时 35 s |
| Magpie Images API | `POST /v1/images/generations {model:"chatgpt-web/web-image"}` → 200，`b64_json` 解出 1254×1254 PNG / 1.90 MB |
| 参考图改图 | 上传 `arisama-canonical.jpg`（1600×1600）→ 出图 1254×1254，五官/脸型/肤色/年龄感一致，发型/服装/姿势/场景按要求改 |
| 参考图被误当结果（已修） | 第一版把用户上传的附件预览当成"生成的图"返回（sha256 与参考图相同）。现按 `alt="Generated image…"` 白名单 + 排除 `User attachment`/头像 + 排除发送前已存在的 `src` |
| 上传失败识别 | 网页拒绝附件时会显示 `Upload failed`，插件立即报 `reference_upload_failed` 并清空输入框，不再干等到超时 |

### 参考图接口

```jsonc
POST /v1/images/generations
{
  "model": "chatgpt-web/web-image",
  "prompt": "以参考图里这个人为同一个人，保持五官/脸型/肤色/年龄感一致；只改发型、服装、姿势、场景",
  "size": "1:1",
  "image": "data:image/jpeg;base64,…"   // 也接受 images / reference_images，字符串或数组，最多 4 张
}
```

- 值可以是 `data:image/...;base64,...`，也可以是**网关主机上**的绝对路径；非图片文件、空文件、>20 MiB 直接 400，不会进浏览器。
- **Magpie 自己的 Images API 只认 `data:` 或 `http(s)` URL 的字符串**：本地路径会被 Magpie 挡在网关层，数组形态的 `image`
  不保证被转发（ARI 现役的 Agnes 适配器发的是数组，实测参考图没有到达插件）。走 ARI 时用单张 `data:` 字符串。
- 参考图上传是**真上传**：走 composer 里网页自带的 `input[type=file][aria-label="Attach photos"]`，等附件 chip 出现、
  发送按钮可用后才发提示词。

### 诊断命令（不消耗额度）

```sh
# 只把当前会话里最新一张已生成的图读回来落盘，不发任何消息
npm run image -- --options <options> --extract-last --out /tmp/last
```

这条命令是用来分辨"网页真的画了"与"插件把调用方自己的上传当成了结果"的；P2 的那次误取就是靠它定位并复验的。

## 3. 用法

### 3.1 安装与登录

```sh
npm install && npm run build && npm run browser:install
HOME=/home/wuguo magpie plugin add /home/wuguo/dev/magpie-chatgptweb2api
```

登录三选一（都需要**独立 profile**，不会碰日常浏览器）：

```sh
# A. 有桌面/显示环境（Linux 服务器需先起 Xvfb，必要时配 noVNC 看画面）
npm run login -- --options examples/edge.options.json

# B. Cookie 导入（推荐给无显示环境）：从自己已登录的浏览器导出 chatgpt.com 的 Cookie 到文件
npm run login -- --cookies "$HOME/chatgpt.cookies.json"

# C. 在 Magpie 面板里登录
HOME=/home/wuguo magpie plugin login chatgpt-web
```

> 关键：**无头 Chromium 会被 Cloudflare 拦**（页面标题变成「请稍候…」，插件报
> `browser_verification_required`）。要么用有头浏览器 + Xvfb，要么走 Cookie 导入，要么在
> 有桌面的机器上登录后把 profile 目录复制过来。

### 3.2 本地验证（不经过 Magpie）

```sh
npm run doctor -- --options /path/options.json          # 看登录态与网页当前模型
npm run chat  -- --options /path/options.json --prompt '只回复：文本测试成功'
npm run image -- --options /path/options.json --prompt '一只戴帽子的猫' --size 16:9 --out /tmp/cat
npm run image -- --options /path/options.json --prompt '一只戴帽子的猫' --json
```

`npm run image` 只打印 `路径 宽x高 MIME 字节数 取回途径`；`--n 1-4`、`--quality`、`--filename`、
`--image-timeout 秒`、`--prompt-suffix` 可选。

### 3.3 经 Magpie 调用

```sh
# 网关的 OpenAI Images API
curl -s -X POST http://127.0.0.1:3425/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/web-image","prompt":"一只戴帽子的猫","size":"16:9"}' | jq '.data[0].mime_type'

# Magpie 内置图像工具（需要把默认图像模型指过去，或由调用方点名）
HOME=/home/wuguo magpie settings set imageGen chatgpt-web/web-image
HOME=/home/wuguo magpie tool generate_image "一只戴帽子的猫" -o /tmp/cat.png

# 插件自己的工具（不经 Settings，随时可用）
HOME=/home/wuguo magpie tool magpie-chatgptweb2api_chatgpt_web_generate_image "一只戴帽子的猫" --size 1:1
```

tailnet 侧调用要先把模型加进该 caller key 的允许列表（`~/.config/magpie/caller-keys.json` 可原子
写回、热加载），否则 403。

### 3.4 给 ARI / 本地项目

见 [`examples/ari-image.mjs`](../examples/ari-image.mjs)：请求网关 Images API、把 `b64_json` 落盘、
回一个 JSON。ARI 容器内用 `MAGPIE_GATEWAY=http://magpie:3425` 与 `ari` key 即可。

## 4. 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `imageDir` | `~/.local/share/magpie-chatgptweb2api/images` | 默认落盘目录 |
| `imageTimeoutMs` | 360000 | 等图的硬超时（5000–1800000） |
| `imagePromptSuffix` | 中文「直接生成图片…」 | 追加在提示词末尾的生图意图，替换它可换语言/口径 |
| `imageFileName` | 时间戳 | 默认文件名前缀 |
| `imageSelfTest` | false | **诊断用**：不打开网页，直接返回一张本地画的图，用来验证网关路由。结果里带 `warnings` 明示 |
| `debugFile` | 无 | **诊断用**：把收到的每个请求追加到该文件（不含凭据） |

图像请求走的是同一个登录 profile、同一个串行队列（`maxConcurrency: 1`），与文本请求互不并行。

## 5. 文件

| 文件 | 作用 |
| --- | --- |
| `src/image.ts` | 提示词组装、尺寸语义、PNG/JPEG/WebP/GIF 头解析、落盘（不覆盖同名）、结果类型 |
| `src/browser.ts` | `generateImage()`：发提示词、轮询助手回合、抓图、三条取字节途径、失败分类；`selfTestImage()` |
| `src/plugin.ts` | provider 面（含 `/v1/images/generations`）、chat 形状的图像回复、agent 工具 |
| `src/cli.ts` | `image` 子命令 |
| `src/worker.ts` / `src/bridge.ts` | 把 `image` 请求转给私有 worker 进程 |
| `test/image.test.mjs` | 本地 ChatGPT 形状 fixture：blob/资源/拒答/空答/限流的端到端用例 |
| `test/plugin-image.test.mjs` | 插件面：模型声明、Images API、拒答码、文本不回归、工具返回 |

## 6. 限制（必读）

- **真实账号出图已验证**（2026-11-08，Plus 账号，见 §2.1），但样本量很小：2 张文生图 + 1 张参考图改图。
- **网页额度是账号自己的**：一次生图约 35–60 s；网页端有每日/每时段限额，超限时插件报 `upstream_rate_limit`，不会自动重试。
- **强依赖网页 DOM**。composer / 发送按钮 / 助手回合 / 图片元素的选取器来自上游文本项目的既有写法，
  对**登录后的真实页面**尚未验证；网页改版会失效，且是静默失效（找不到图 → 明确报错，不会给假结果）。
- **尺寸只是提示**。网页 composer 没有可靠的画幅控件，`size` 会被翻成提示词；实际尺寸由返回的图片头
  读出后回报。
- **返回给网关的图像响应只有 `b64_json` 与 `mime_type`**，宽高由 Magpie 丢弃，调用方要自己读图头。
- **Magpie 只把显式点名的图像模型按图像路由**：`/v1/images/generations` 可用（已验证），但
  `magpie tool generate_image --model chatgpt-web/web-image` 会被拒（不在 Magpie 的已知图像模型
  列表里），需改用「设成默认图像模型」或插件自己的工具。同一原因导致 **Gemini 原生面
  `/v1beta/models/…:generateContent` 不会把图提成 `inlineData`**，只回一段带 data-URL 的文本——
  ARI 现有的 `call_image` 读的正是 `inlineData`，所以 ARI **不能零改动**切到这条通道。
- **参考图已支持**（见 §2.1「参考图接口」），但 Magpie 的 `image` 字段只保证转发 `data:`/`http(s)` 字符串；
  ARI 现役 Agnes 适配器发数组，实测参考图没有到达插件——ARI 侧要么改适配器发字符串，要么走专用 provider（见 §7）。
- **GIF / 动图**：ChatGPT 网页的生图工具只出静态图，本插件也没有 GIF 入口；未接入，不谎称支持。
- 匿名会话不能生图（网页自己写明的），本插件直接拒绝而不是让它白跑。
- 平台策略风险：网页自动化属于非官方用法，账号可能触发验证或风控；请自行评估服务条款。
- 并发 1：所有图像请求共用一个浏览器 profile 串行。

## 7. ARI 侧现状（2026-11-08）

- ARI 的图像 provider 在 `backend/app/services/providers/`：`registry.get_image_provider()` 按显式 provider 选适配器，
  `dispatch_image_call()` 只把 `agnes/cloudflare/comfy/ideogram` 交给 registry，其余一律走 Gemini `generateContent`。
- **零改动的临时通道**：ARI 的 `openai`（= Agnes 适配器）走 `POST {base}/v1/images/generations`，把 `api_base` 指到
  Magpie 即可打到本插件；但适配器把参考图放在 `extra_body.image` **数组**里，Magpie 不保证转发，实测参考图未到达。
- **要做的正式通道**：新增 provider `chatgpt-web-image` + 适配器（`image` 发单张 `data:` 字符串、并发 1、
  超时 `ImageRequest.timeout`、失败分类 429/401/5xx/内容拒绝），并在 `dispatch_image_call` 的元组里加一个 id。
  该元组所在文件 `image_generation.py` 在 2026-11-08 22:21 仍被另一写手（guo-task-202611082230）修改中，
  按单写手规则本轮没有动它——所以 `chatgpt-web-image` 这个渠道名还没有落地，ARI 现在只能用上面的 `openai` 临时通道。
