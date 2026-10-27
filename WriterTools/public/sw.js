/*
 * WriterTools Service Worker（运行时缓存，离线可打开应用壳）
 * ============================================================
 * 策略：
 *  - install：预缓存应用壳（index.html + manifest + 图标），并从 index.html 中解析出
 *    带哈希的生产资源（/assets/*.js|css）一并预缓存；skipWaiting。
 *  - activate：clients.claim()；清理本应用旧版本缓存（只清理前缀为 writertools- 的）。
 *  - fetch：
 *      · 非 GET / 跨域 / chrome-extension: 等协议不处理，直接走网络；
 *      · 导航请求（页面地址）：network-first，失败回退缓存的应用壳（离线打开）；
 *      · 同源静态资源（/assets/、/icons/、字体、manifest 等）：stale-while-revalidate。
 *  - 开发期资源（/src/、/@vite、/@fs、node_modules）不缓存；本次构建产物才缓存。
 *
 * 注意：本文件是纯静态脚本，不参与 TS 类型检查；修改后需更新 VERSION 才能让老客户端刷新缓存。
 */
'use strict';

const VERSION = 'writertools-v1';
const PRECACHE = `${VERSION}-precache`;
const RUNTIME = `${VERSION}-runtime`;
const CACHE_PREFIX = 'writertools-';

/** 本应用部署根路径（支持 GitHub Pages 子路径，如 /WriterTools/）。 */
const BASE = new URL('./', self.location).pathname;

// 应用壳（生产构建的入口 HTML 与 PWA 元数据）；hashed assets 在 install 时解析补全。
const APP_SHELL = [
  BASE,
  `${BASE}index.html`,
  `${BASE}manifest.webmanifest`,
  `${BASE}icons/icon.svg`,
  `${BASE}icons/icon-192.png`,
  `${BASE}icons/icon-512.png`,
  `${BASE}icons/icon-maskable-512.png`,
];

/** 只缓存同源的、非开发期资源。 */
function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  const relative = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  if (relative.startsWith('src/') || relative.startsWith('@') || relative.startsWith('node_modules/')) return false;
  if (relative === 'sw.js') return false;
  return true;
}

/** 静态资源：带版本号的 assets/、图标、字体、manifest、根下常见静态后缀。 */
function isStaticAsset(url) {
  const p = url.pathname;
  const relative = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  if (relative.startsWith('assets/') || relative.startsWith('icons/')) return true;
  if (relative === 'manifest.webmanifest') return true;
  return /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|json|txt|webmanifest)$/i.test(relative);
}

/** 缓存单个 URL；失败不阻塞整体安装（例如图标缺失）。 */
async function addToCache(cache, url) {
  try {
    const response = await fetch(url, { cache: 'reload' });
    if (response && response.ok) await cache.put(url, response);
  } catch (err) {
    /* 应用壳是增强项：单个资源失败不影响 SW 安装 */
  }
}

/** 从 index.html 中提取生产资源 URL（assets/*.js|css 等），用于首次安装即离线可用。 */
function extractBuildAssets(html) {
  const urls = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw.startsWith('/')) continue;
    if (raw.startsWith(`${BASE}assets/`) || raw.startsWith(`${BASE}icons/`) || raw === `${BASE}manifest.webmanifest`) {
      urls.add(raw);
    }
  }
  return [...urls];
}

async function precacheAppShell(cache) {
  await Promise.all(APP_SHELL.map((url) => addToCache(cache, url)));
  // 解析入口 HTML 里的 hashed 资源，使"首次访问后即可离线"。
  try {
    const response = await fetch(`${BASE}index.html`, { cache: 'reload' });
    if (response && response.ok) {
      const html = await response.clone().text();
      const assets = extractBuildAssets(html);
      await Promise.all(assets.map((url) => addToCache(cache, url)));
    }
  } catch (err) {
    /* 忽略：运行时缓存仍可工作 */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await precacheAppShell(cache);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== PRECACHE && key !== RUNTIME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/** 导航请求：network-first，失败回退缓存的应用壳。 */
async function handleNavigation(request) {
  const runtime = await caches.open(RUNTIME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      // 只缓存同源 HTML 响应；重定向等异常响应不缓存。
      if (fresh.type === 'basic' || fresh.type === 'default') {
        runtime.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    }
    return fresh;
  } catch (err) {
    // 离线：优先返回应用壳（SPA 任意路径都回退到 index.html）。
    // ignoreVary：预缓存的 Request 与页面导航请求可能带不同 Origin 头（静态服务器常返回 Vary: Origin）。
    const shell = await caches.match(`${BASE}index.html`, { cacheName: PRECACHE, ignoreVary: true });
    if (shell) return shell;
    const root = await caches.match(BASE, { cacheName: PRECACHE, ignoreVary: true });
    if (root) return root;
    const cachedNav = await runtime.match(request, { ignoreVary: true });
    if (cachedNav) return cachedNav;
    return new Response('WriterTools 当前离线，且尚未缓存应用壳。', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** 静态资源：stale-while-revalidate（先返回缓存，同时后台更新）。 */
async function handleStatic(request) {
  const runtime = await caches.open(RUNTIME);
  // 同时查运行时缓存与安装时预缓存（首次访问后离线可用依赖 PRECACHE 里的 hashed assets）。
  // ignoreVary：<script crossorigin> 等子资源请求带 Origin 头，而预缓存时没有，Vary: Origin 会导致 miss。
  const cached = (await runtime.match(request, { ignoreVary: true })) || (await caches.match(request, { ignoreVary: true }));
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) runtime.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);

  if (cached) {
    // 后台更新失败也不产生未处理的 rejection。
    network.catch(() => {});
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  return new Response('', { status: 504, statusText: 'Gateway Timeout' });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isCacheableRequest(request)) return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(handleStatic(request));
  }
});
