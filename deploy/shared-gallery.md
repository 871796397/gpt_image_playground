# 成员共享部署

此部署在原应用上增加 Cloudflare Worker API 和私有 R2 图库。前端 `.env.production` 只包含公共开关和预置文件路径；Key 仅保存在 Worker 的 `OPENAI_API_KEY` Secret 中。

## 部署

- 创建私有 R2 桶 `gpt-image-shared-gallery`，保持 Public Access 关闭。
- `wrangler.jsonc` 中的 `APP_ORIGIN`、`ACCESS_ISSUER`、`ACCESS_AUD` 必须对应正式域名及 Access 应用。
- 使用 GitHub 连接构建：`npm run build`，部署：`npx wrangler deploy`。首次有 Worker 入口后，在 Cloudflare Runtime variables and secrets 中添加 Secret `OPENAI_API_KEY` 并部署。
- `workers_dev` 和 `preview_urls` 保持 `false`。Access 邮箱策略覆盖整个 `imgae.godling.uk`，包含 `/api/` 和 `/api-proxy/`。
- 更换 Key 时只更新 Secret，无需重建前端。
- Worker 通过 `placement.region = aws:us-east-1` 请求在美国东部附近运行。Placement 是调度提示，不保证上游看到的网络来源；需同时核验实际请求结果。`/api/health` 的 `ingressColo` 是访问入口，响应头 `cf-placement` 表示调度节点，两者不能混为一谈。
- 登录后访问 `/api/health?diagnose=1` 可读取固定模型元信息并执行无凭据的 Cloudflare 网络诊断，不生成图片。返回上游状态、错误码、追踪 ID、网络诊断节点和国家；不返回 Key、完整上游响应或访问者 IP。
- `GALLERY_ADMIN_EMAILS` 用逗号分隔图库管理员邮箱；成员只能删除自己的共享作品，管理员可删除全部作品。权限由 Worker 使用已验证的 Access 身份校验。

## 行为与范围

- 图片生成、编辑和 Agent 调用都经同源代理访问固定的官方 API，不接收客户端提供的上游地址或 Key。允许图像模型为 GPT Image 2.5 Sunburst、Flare 和 GPT Image 2；Agent 文本模型为 GPT 6.1 Sol。
- API 对 Access JWT 校验 RS256 签名、issuer、audience、有效期。作者取自已校验的邮箱，客户端无法指定作者。写请求要求同源 Origin。
- 新完成的画廊和 Agent 作品自动上传，历史本机作品不主动公开。同步失败保留本机记录及待同步任务 ID，可在共享图库重试，重新打开页面也会恢复待同步队列。
- 成员可共同查看提示词、作者、生成时间和图片并下载。个人收藏、参考图、对话和 API 设置不上传；删除本地作品不会删除共享副本。
- 共享作品删除前要求确认，删除会清理云端元数据和图片，本机作品保留。`deleted/` 仅保留作者、创建时间和删除时间，防止离线同步恢复已删除作品。
- 图库每页 24 条，每 15 秒更新首批作品。只上传 PNG/JPEG/WebP，每张最多 20MB、每次最多 10 张、总计最多 50MB。
- R2 `tasks/` 保存作品元数据，`images/` 保存图片。以作者和本机任务 ID 的 SHA-256 做幂等标识，同一作品重试不会增加重复列表项。R2 没有公共域名或公共开发地址，所有图片读取都经过认证 API。
- Worker 日志启用。上游失败记录 `openai_error`、请求 ID、邮箱 SHA-256、模型、接口、状态和已脱敏的上游原因，不记录 Key、请求提示词或图片。403 保留实际原因，不统一推断为模型权限不足。

## 验证

`npm run build`、`npm test`、`npx wrangler deploy --dry-run`。Worker 测试使用本机临时签名密钥和模拟 R2/OpenAI，验证签名拒绝、源站校验、固定上游、Secret 注入、作品幂等和跨成员读取；不使用真实 Key。

线上验收应在邮箱登录后生成一张小图，并从另一登录会话打开共享图库。未登录请求正式域名应跳转 Access，默认 workers.dev 地址应返回 404。
