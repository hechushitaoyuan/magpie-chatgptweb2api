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


### 诊断工具（`tools/`，只读为主，不消耗图片额度）

| 工具 | 用途 |
| --- | --- |
| `node tools/conversation-state.mjs <profileDir> <conversationId> [标记]` | 打印账号会话总数、该标题的会话、该会话轮数/最后一条用户消息/附件数——用于"生成前后"取证 |
| `node tools/calibrate-dom.mjs <profileDir> <conversationUrl>` | 打开绑定会话并报告真实 DOM 里各选择器的命中情况（插件升级 ChatGPT 改版后先跑它） |
| `node tools/close-challenged.mjs <profileDir>` | 关掉停在「Just a moment…」的标签页 |

三者默认需要 `DISPLAY`（有头浏览器）与一个已在运行的保留窗口。

## 6. 限制（必读）

- **真实账号出图已验证**（2026-11-08 Plus 账号，见 §2.1；2026-11-09 又经网关验证一次，见 §7），但样本量很小：
  3 张文生图 + 1 张参考图改图。"额度能不能长期稳定产出"仍无长跑样本。
- **网页额度是账号自己的**：一次生图约 35–60 s；网页端有每日/每时段限额，超限时插件报 `upstream_rate_limit`，不会自动重试。
- **仍强依赖网页 DOM**。composer / 发送按钮 / 助手回合已按 2026-11-09 的真实登录页校准（见 §8），但网页改版仍会失效；
  失效时是明确报错（`chat_unavailable` / `send_button_missing`），不会给假结果，也不会静默新建会话。
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

## 7. 专用会话绑定（2026-11-09）

ARI 通过 `chatgpt-web/web-image` 生图时，请求固定送进一个**已存在的会话**，不再新建、不再切到别的会话。

### 绑定方式与优先级

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `imageConversation` / `imageConversationUrl` / `imageConversationId` 选项 | 稳定标识，直接可用，**不需要打开浏览器** |
| 2 | `imageSessionFile`（默认 `<profilesDir>/image-session.json`）里记住的绑定 | 重启后仍然有效 |
| 3 | `imageConversationTitle` 按标题解析**一次**，随后写进上面那个文件 | 次优方案：标题可能被改或被重名 |

本机实际绑定（写入 Magpie 插件 Options）：

```json
{"imageConversationId": "6af180fa-16d4-83e8-b4a3-650f20808876",
 "imageConversationTitle": "ari项目专用生图会话"}
```

落盘的 `image-session.json`：

```json
{"version":1,"id":"6af180fa-16d4-83e8-b4a3-650f20808876","title":"ari项目专用生图会话",
 "url":"https://chatgpt.com/c/6af180fa-16d4-83e8-b4a3-650f20808876",
 "resolvedAt":"2026-11-09T09:09:26.422Z","source":"title"}
```

标题解析走页内两条路：已渲染的侧栏链接，以及页面自身会话列表接口（`/backend-api/conversations`，用页面自己的会话读，插件不持有任何 token）。侧栏是虚拟化的、可能过期，所以必须有第二条。

### 行为

- 图片请求使用**该会话自己的固定热标签页**：已打开的标签页被采用（`tab: adopted`），**不重新加载**；只有没有该标签页时才打开一次；其他标签页一律不碰。
- 标签页在请求结束后**不关闭**，留给下一次复用。
- 找不到会话 / 标题重名 / 标签页被挑战页替换 → 明确报错（`image_conversation_not_found` / `image_conversation_ambiguous` / `browser_verification_required`），**绝不新建会话**。
- 未配置任何绑定时默认**拒绝**（`image_conversation_unbound`）；只有显式 `imageAllowNewChat: true` 才回到"每次开新会话"的旧行为。
- 文本会话（`chat/completions`）、`doctor`、`usage` 各自开自己的页面，不会碰这个热标签页；`usage` 只读磁盘上的绑定，不开浏览器。
- 专用会话里已有的历史、上传的参考图、以及会话自身"9:16 + 人物一致性"的记忆都保留；生图前会把**已存在的图片**排除在结果之外，所以不会把历史里的参考图当成新产出。

### 命令

```sh
npm run session -- --options /path/options.json                 # 只读：现在绑定在哪
npm run session -- --options /path/options.json --rebind        # 按配置解析并写盘
npm run session -- --options /path/options.json --bind "标题"    # 按标题绑定（会打开一次浏览器）
npm run session -- --options /path/options.json --bind 会话ID    # 按 id 绑定（不碰浏览器）
npm run session -- --options /path/options.json --clear-challenge # 修 Cloudflare 挑战（见 §8）
npm run image   -- --options /path/options.json --dry-run        # 零额度：只走到发送前
```

`--dry-run` 报告绑定、标签页是 adopted 还是 opened、账号、输入框是否可用、会话里已有多少轮/多少图，**不输入、不发送**。

### 实测（2026-11-09，真实账号 jiamian0128@gmail.com）

| 项 | 结果 |
| --- | --- |
| 按标题解析（清空绑定后） | `source: "title"` → 命中 `6af180fa-16d4-83e8-b4a3-650f20808876` |
| `--dry-run` 两次 | 都是 `tab: adopted`、`pageTitle: ari项目专用生图会话`、`authenticated: true`、`composer: true` |
| 经网关真实生图一次 | HTTP 200，131 s，返回 941×1672 PNG（正好 9:16），插件另存 `imageDir/chatgpt-web-20261109-092543.png` |
| 生成前后账号会话总数 | 29 → 29（**没有新建会话**） |
| 该标题的会话数 | 1 → 1 |
| 专用会话轮数 | 1 → 2，且停在该会话（`updated` 变为最新） |
| 该会话最后一条用户消息 | 正是 Magpie 下发的那句提示词 |
| 会话内用户附件 | 16 → 16（参考图未被破坏） |

## 8. Cloudflare 与真实页面（2026-11-09 实测）

这台 ARM 上的头条障碍是 Cloudflare。2026-11-09 再次踩到，并把根因钉死：

**根因（已证）＝ profile 里过期的 Cloudflare 风控 cookie。** 浏览器重启后新开标签页全部停在「Just a moment…」，
等 88 秒、`navigator.webdriver` 已是 `false` 也不放行；清掉 `cf_clearance` / `__cf_bm` / `__cflb` / `_cfuvid` / `cf_chl_rc_ni`
这五个（**不动登录 cookie，登录态保留**）后，**下一次加载 4 秒内就是真实页面**。入口：`session --clear-challenge`。
这与 11-08 登录那轮 `auth.openai.com` 的同名处置是同一类问题：风控标记跟着 profile 走。

**另外加了一道（增量，未单独归因）**：启动参数 `--disable-blink-features=AutomationControlled`，
并在 CDP 连接的 context 上补 `navigator.webdriver → undefined`（`src/kept-browser.ts`）。它没有单独被证明是必要条件，
因为清 cookie 那一步单独就恢复了；留着是因为它零代价且方向正确。

另外：有头浏览器需要显示环境；Magpie 服务已加 drop-in `chatgptweb-display.conf`（`DISPLAY=:98`），否则重启后拉起保留窗口会报 `browser_display_missing`。

真实登录页的 DOM 校准（2026-11-09）：

| 元素 | 实测选择器 |
| --- | --- |
| 输入框 | `form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]`（ProseMirror） |
| 发送 | `form[data-chatgpt-composer] button[aria-label="Send"]`，**有草稿时才出现** |
| 助手回合 | `[data-turn-key]`（group 渲染） |
| 参考图上传 | 4 个 `input[type=file]`（`accept="image/*"`） |
## 9. ARI 侧现状（2026-11-10 已闭环）

- ARI 的图像 provider 在 `backend/app/services/providers/`：`registry.get_image_provider()` 按显式 provider 选适配器，
  `dispatch_image_call()` 把 `agnes/cloudflare/comfy/ideogram/chatgpt-web-image` 交给 registry，其余走 Gemini `generateContent`。
- **已落地**：provider `chatgpt-web-image`（`ChatgptWebImageAdapter`）+ 托管预设 `chatgpt-web-default` + 前端
  「ChatGPT Web（Plus 网页图片额度）」选项。图像槽位选中后按 model 路由：`ai-studio/…` 与 `chatgpt-web/web-image`
  走同一个 Magpie Images 客户端；参考图以**单张 data URI 字符串**放 `image`（Magpie 只保证转发字符串，数组形态默认关闭）。
- **提示词与 Gemini 线分开**：这条线用 `build_chatgpt_web_prompt` 的短中文（场景 + 参考图用法 + 画面要求，约 166 字），
  不搬 Gemini 的 `[PHOTO SPEC]` 长英文合同；人物一致性靠参考图本身。
- **2026-11-10 首次端到端成功**：ARI `/api/v1/images/generate` → Magpie → 网页，约 40–140 秒/张，941×1672，
  落 MinIO 后前端按 ARI 图片地址展示；绑定会话为 `ari项目专用生图会话`，不需要调用方传会话 id。
- 运行约束：Chrome 被强杀留下的 `SingletonLock` 会让请求 409（插件已能识别属主已死并自清）；`magpie` 服务必须带
  `DISPLAY=:98` 才能自己重启浏览器；Cloudflare 挑战复发时先跑 `session --clear-challenge`，仍不行才需人工在窗口点一次。
- 存图走 ARI 共享的 `image_persist`：2026-11-10 因 `user_prompt` 未定义让两条线同时 500，已修复（提交 `245619b1`）
  并加 AST 静态围栏测试。
