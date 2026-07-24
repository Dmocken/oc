// 阿里云 ESA 边缘函数：反向代理 givemeoc.com API，解决跨域
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 只代理 /api 路径，其他请求交给静态资源
    if (!url.pathname.startsWith('/api/')) {
      return fetch(request);
    }

    // 构造目标 URL：/api/companies → /wp-json/givemeoc/v1/companies
    const targetPath = url.pathname.replace('/api', '/wp-json/givemeoc/v1');
    const targetUrl = `https://www.givemeoc.com${targetPath}${url.search}`;

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: '代理请求失败', detail: err.message }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
