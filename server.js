const http = require("http");
const https = require("https");
const url = require("url");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
};

// Fetch a URL and return body as string
function fetchText(targetUrl) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.startsWith("https") ? https : http;
    client.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ body: data, headers: res.headers, status: res.statusCode }));
    }).on("error", reject);
  });
}

// Proxy a URL, piping response straight to res
function proxyUrl(targetUrl, res, extraHeaders = {}) {
  const client = targetUrl.startsWith("https") ? https : http;
  const req = client.get(targetUrl, {
    headers: { "User-Agent": "Mozilla/5.0", ...extraHeaders }
  }, (proxyRes) => {
    const headers = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!k.toLowerCase().startsWith("access-control")) headers[k] = v;
    }
    Object.assign(headers, CORS_HEADERS);
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  req.on("error", (e) => {
    res.writeHead(502, CORS_HEADERS);
    res.end("Proxy error: " + e.message);
  });
}

// Rewrite m3u8 content so all URLs point back through this proxy
function rewriteM3u8(content, baseUrl, proxyBase) {
  const base = new URL(baseUrl);
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    // It's a URL line — make absolute if relative, then wrap in proxy
    let absolute;
    try {
      absolute = new URL(trimmed).href; // already absolute
    } catch {
      absolute = new URL(trimmed, base).href; // relative → absolute
    }
    return `${proxyBase}/segment?url=${encodeURIComponent(absolute)}`;
  }).join("\n");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  // Health check
  if (path === "/health") {
    res.writeHead(200, CORS_HEADERS);
    res.end("ok");
    return;
  }

  // /proxy?url=<encoded-m3u8-url>
  // Fetches the m3u8, rewrites all segment URLs to go through /segment
  if (path === "/proxy") {
    const targetUrl = query.url;
    if (!targetUrl) {
      res.writeHead(400, CORS_HEADERS);
      res.end("Missing url param");
      return;
    }

    try {
      const { body, headers } = await fetchText(targetUrl);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host;
      const proxyBase = `${proto}://${host}`;
      const rewritten = rewriteM3u8(body, targetUrl, proxyBase);

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": headers["content-type"] || "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
      });
      res.end(rewritten);
    } catch (e) {
      res.writeHead(502, CORS_HEADERS);
      res.end("Failed to fetch m3u8: " + e.message);
    }
    return;
  }

  // /segment?url=<encoded-segment-url>
  // Proxies a .ts segment or nested m3u8 through this server
  if (path === "/segment") {
    const targetUrl = query.url;
    if (!targetUrl) {
      res.writeHead(400, CORS_HEADERS);
      res.end("Missing url param");
      return;
    }

    // If it's a nested m3u8 (e.g. quality variant), rewrite it too
    if (targetUrl.includes(".m3u8") || targetUrl.includes("m3u8")) {
      try {
        const { body, headers } = await fetchText(targetUrl);
        const proto = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host;
        const proxyBase = `${proto}://${host}`;
        const rewritten = rewriteM3u8(body, targetUrl, proxyBase);
        res.writeHead(200, {
          ...CORS_HEADERS,
          "Content-Type": headers["content-type"] || "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        });
        res.end(rewritten);
      } catch (e) {
        res.writeHead(502, CORS_HEADERS);
        res.end("Failed: " + e.message);
      }
      return;
    }

    // Otherwise proxy the segment directly
    proxyUrl(targetUrl, res);
    return;
  }

  // ATV raw MPEG-TS stream (kept for backwards compat)
  if (path === "/stream") {
    const atvUrl = `http://5.15.3.247:9988/stream/channel/234c63837f38efb4fbefc383a4b8c453${query.profile ? "?profile=" + query.profile : ""}`;
    proxyUrl(atvUrl, res);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end("Not found");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Proxy server on port ${PORT}`));
