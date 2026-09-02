# GiveMeOC —— 秋招信息站（offerbiu 缓存版）

展示秋招/春招信息的前端站点。部署于阿里云 ESA Pages（静态资源 + 边缘函数），由边缘函数把 offerbiu 招聘 API 全量缓存进边缘 KV，用户访问时只在缓存过期时**顺手做一次增量同步**（Stale-While-Revalidate），平时读缓存零上游请求。
