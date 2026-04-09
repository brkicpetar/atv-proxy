const http = require("http");
const https = require("https");
const url = require("url");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
};

const JWPLAYER_PAGE = "https://player.mediaklikk.hu/playernew/player.php?video=mtv1live&noflash=yes&autostart=true&mute=false";

function fetchText(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.startsWith("https") ? https : http;
    client.get(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", ...extraHeaders }
    }, (res) => {
      // follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ body: data, headers: res.headers, status: res.statusCode }));
    }).on("error", reject);
  });
}

function proxyUrl(targetUrl, res) {
  const client = targetUrl.startsWith("https") ? https : http;
  client.get(targetUrl, {
    headers: { "User-Agent": "Mozilla/5.0" }
  }, (proxyRes) => {
    const headers = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!k.toLowerCase().startsWith("access-control")) headers[k] = v;
    }
    Object.assign(headers, CORS_HEADERS);
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  }).on("error", (e) => {
    res.writeHead(502, CORS_HEADERS);
    res.end("Proxy error: " + e.message);
  });
}

function rewriteM3u8(content, baseUrl, proxyBase) {
  const base = new URL(baseUrl);
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    let absolute;
    try {
      absolute = new URL(trimmed).href;
    } catch {
      absolute = new URL(trimmed, base).href;
    }
    return `${proxyBase}/segment?url=${encodeURIComponent(absolute)}`;
  }).join("\n");
}

// Extract first m3u8 URL from JWPlayer page HTML
function extractM3u8(html) {
  const patterns = [
    /["']?(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']?/i,
    /file:\s*["'](https?:\/\/[^"']+)["']/i,
    /source[^}]*?["'](https?:\/\/[^"']+m3u8[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
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

  if (path === "/health") {
    res.writeHead(200, CORS_HEADERS);
    res.end("ok");
    return;
  }

  // /m1 — fetch JWPlayer page, extract m3u8, return proxied m3u8
  if (path === "/m1") {
    try {
      const { body } = await fetchText(JWPLAYER_PAGE);
      const m3u8Url = extractM3u8(body);
      if (!m3u8Url) {
        res.writeHead(502, CORS_HEADERS);
        res.end("Could not find m3u8 URL in player page");
        return;
      }

      // Fetch the m3u8 from Render's IP (token is now bound to Render's IP)
      const { body: m3u8Content, headers: m3u8Headers } = await fetchText(m3u8Url);

      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host;
      const proxyBase = `${proto}://${host}`;

      const rewritten = rewriteM3u8(m3u8Content, m3u8Url, proxyBase);

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": m3u8Headers["content-type"] || "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
      });
      res.end(rewritten);
    } catch (e) {
      res.writeHead(502, CORS_HEADERS);
      res.end("M1 fetch failed: " + e.message);
    }
    return;
  }

  // /proxy?url=<encoded-m3u8> — proxy any m3u8 with rewritten segments
  if (path === "/proxy") {
    const targetUrl = query.url;
    if (!targetUrl) { res.writeHead(400, CORS_HEADERS); res.end("Missing url"); return; }
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

  // /segment?url=<encoded-url> — proxy a segment or nested m3u8
  if (path === "/segment") {
    const targetUrl = query.url;
    if (!targetUrl) { res.writeHead(400, CORS_HEADERS); res.end("Missing url"); return; }

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

    proxyUrl(targetUrl, res);
    return;
  }

  // /stream — ATV raw MPEG-TS
  if (path === "/stream") {
    const atvUrl = `http://5.15.3.247:9988/stream/channel/234c63837f38efb4fbefc383a4b8c453`;
    proxyUrl(atvUrl, res);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end("Not found");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Proxy server on port ${PORT}`));
