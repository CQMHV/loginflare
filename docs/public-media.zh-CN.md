# 公开图片交付

[English](public-media.md)

`AVATARS` 存放公开头像、品牌 Logo 和登录提供方图标；`PRIVATE` 存放安装材料和认证密钥，必须分桶。上传、删除和孤儿文件清理保留原 Worker 认证接口及 R2 绑定；公开读取可以通过 R2 自定义域名直出，不调用应用 Worker。

通过非机密文本配置 `PUBLIC_ASSETS_URL` 明确启用，例如 `https://images.example.com`。必须使用独立 HTTPS origin，不含路径、末尾斜杠、凭据、查询或片段；不接受 `r2.dev` 地址。未配置时两个桶保持私有，继续使用 Worker 图片读取路由。仓库未声明时，发布脚本保留 Worker 上已有的文本变量。显式空字符串选择 Worker 交付。更改或关闭已有图片域名需要协调切换，不能只回滚代码。

公开已有桶前检查整个桶的内容：公开访问会暴露所有已知对象键，包括图片草稿。`AVATARS` 不得存放私有文件。

1. 只为 **AVATARS** 绑定图片域名，等待归属和 TLS 状态均为 active。两个桶的 `r2.dev` 均保持关闭，**PRIVATE** 不得有公开域名。图片域名直接指向 R2，不应被应用 Worker 路由覆盖。
2. 为图片域名配置响应头转换规则，使用 **设置** 操作，覆盖所有响应，包括错误响应：

   ```text
   Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
   X-Content-Type-Options: nosniff
   Referrer-Policy: no-referrer
   Cross-Origin-Resource-Policy: cross-origin
   Access-Control-Allow-Origin: *
   ```

   配置桶 CORS：允许来源 `*` 的匿名 `GET`/`HEAD`，允许 `If-None-Match`、`Range` 请求头，暴露 `ETag`、`Content-Length`、`Content-Range`。不需要 Cookie 或带凭据的跨域请求。SVG Logo 和图标保留 attachment 响应方式及内容验证。
3. 只为此域名配置缓存规则，让无扩展名的 UUID 键可以缓存。成功对象的边缘和浏览器缓存最长 300 秒，错误响应绕过缓存。新对象包含 `Cache-Control: public, max-age=300`；已有对象需要等效域名缓存策略。替换图片使用新键；删除后旧图可能缓存五分钟，立即消除缓存需要执行缓存清除。
4. 在环境专用 Wrangler `vars` 或 Worker 文本变量中设置 `PUBLIC_ASSETS_URL`，保留数据库恢复点，再按正常流程发布。脚本在发布前核对准确的 R2 域名及 active 状态、已关闭的托管地址、PRIVATE 隔离，以及只读 `HEAD` 探测的安全头。它不会自动开放桶或修改边缘规则。

已有头像只在 Worker 发布成功后迁移，每页最多 200 条，原子更新所属用户图片和生命周期引用，保留草稿过期时间及其他用户的图片。发布前的图片配置检查只读；构建被取代或无法确认发布成功时，不启动地址迁移。迁移预算为一分钟；发布后迁移中断时，新 Worker 继续运行并支持旧登录域名链接和 R2 直出地址，释放发布锁后可重试剩余地址。实际地址变更会产生原有的 `user.updated` 事件。品牌和图标地址直接从 ID 生成。旧登录域名图片链接保留匿名 CORS 和五分钟公开缓存，外部应用保存的旧 `picture` 地址也能复用跳转。更换图片域名时，旧域名至少保留至这段缓存窗口结束。滚动发布时旧 Worker 仍可能写入旧地址，下一次公开图片发布会补齐，期间旧链接仍可用。域名变更须协调已打开的页面、浏览器缓存和存储地址；Worker 回滚不会还原 D1、R2 或边缘配置。

本地开发使用 Wrangler 原生 `/cdn-cgi/local/r2/public/<bucket_name>/<key>` 端点，已在 `wrangler.local.jsonc` 配置。隔离浏览器测试分别使用 `127.0.0.1` 图片来源与 `localhost` 账号来源，验证跨域加载，不开放线上桶。模拟器会通过开发端点暴露本地绑定；正式环境的私有性由桶设置和发布检查保证，不由这些本地端点保证。

参见 Cloudflare 的[公开桶文档](https://developers.cloudflare.com/r2/buckets/public-buckets/)和[本地公开端点文档](https://developers.cloudflare.com/r2/local-development/#serve-objects-publicly)。R2 存储、读取计费及站点 WAF 规则仍独立生效。
