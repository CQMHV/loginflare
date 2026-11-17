# Public image delivery

[简体中文](public-media.zh-CN.md)

`AVATARS` contains public avatars, brand logos and provider icons. `PRIVATE` contains installation material and authentication keys. Use separate buckets. Uploads, deletion and orphan collection retain the authenticated Worker APIs and R2 binding; public reads can use an R2 custom domain without invoking the application Worker.

Enable this explicitly with the non-secret text setting `PUBLIC_ASSETS_URL`, for example `https://images.example.com`. It must be a separate HTTPS origin, without a path, trailing slash, credentials, query or fragment; `r2.dev` addresses are rejected. Without a setting, both buckets stay private and Worker image routes serve reads. The release helper preserves an existing text variable when the repository omits it. An explicit empty string selects Worker delivery. Changing or disabling a live image domain needs a coordinated cutover, not just a code rollback.

Before exposing an existing bucket, inspect its entire contents: public access exposes every known object key, including image drafts. Never store private files in `AVATARS`.

1. Attach the image hostname to **AVATARS only**, with active ownership and TLS. Keep both buckets' `r2.dev` URLs disabled and **PRIVATE** without public domains. The image hostname must route directly to R2, without an application Worker route.
2. Add a Response Header Transform Rule scoped to the image hostname. **Set** these headers on all responses, including errors:

   ```text
   Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
   X-Content-Type-Options: nosniff
   Referrer-Policy: no-referrer
   Cross-Origin-Resource-Policy: cross-origin
   Access-Control-Allow-Origin: *
   ```

   Configure bucket CORS for anonymous `GET`/`HEAD` from `*`, allowing `If-None-Match` and `Range`, and exposing `ETag`, `Content-Length` and `Content-Range`. No cookies or credentialed CORS are needed. SVG logos and icons retain attachment disposition and content validation.
3. Add a Cache Rule scoped to this hostname so UUID keys without extensions are eligible. Cache successful objects for at most 300 seconds at the edge and in browsers; bypass caching for errors. New uploads include `Cache-Control: public, max-age=300`; existing objects need an equivalent domain cache policy. Replacement uses a new key. Deleted images may remain cached for five minutes; immediate erasure requires cache purging.
4. Set `PUBLIC_ASSETS_URL` in environment-specific Wrangler `vars` or the Worker's text variables, keep a database recovery point, and release normally. The helper checks the exact active R2 domain, disabled managed URLs, PRIVATE isolation and a read-only `HEAD` probe's security headers before publishing. It never opens buckets or changes edge rules automatically.

Existing owned avatar URLs migrate only after Worker publication succeeds, in atomic pages of 200, retaining lifecycle references, draft expiry and other users' images. Pre-publication media checks are read-only. A superseded build or an unconfirmed publication does not start the URL migration. The migration has a one-minute budget; if interrupted after publication, the new Worker stays active and serves both existing issuer links and direct R2 URLs. The release lock is freed and a retry resumes remaining URLs. Actual URL changes produce existing `user.updated` events. Branding and icon URLs derive from IDs. Old issuer image links redirect to R2 with anonymous CORS and a five-minute public cache, so applications retaining old `picture` URLs can reuse the redirect. Keep the old image domain available for at least that cache window during any hostname cutover. An old Worker can still write an old avatar URL during rollout; the next public-media release reconciles it while the old link remains usable. Domain changes must account for open browser documents, caches and stored URLs. Worker rollback does not roll back D1, R2 or edge configuration.

Local development uses Wrangler's native `/cdn-cgi/local/r2/public/<bucket_name>/<key>` endpoint, configured in `wrangler.local.jsonc`. Isolated browser tests use `127.0.0.1` for images and `localhost` for accounts to test cross-origin loading without exposing deployed buckets. The simulator exposes local R2 bindings through development endpoints; production privacy comes from bucket settings and release checks, not these local endpoints.

See Cloudflare's [public bucket documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/) and [local public endpoint documentation](https://developers.cloudflare.com/r2/local-development/#serve-objects-publicly). R2 storage/read charges and zone WAF rules apply independently of application Worker billing.
