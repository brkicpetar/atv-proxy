const http = require("http");
const https = require("https");
const url = require("url");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
};

function fetch(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.startsWith("https") ? https : http;
    const opts = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Referer": "https://mediaklikk.hu/",
        "Origin": "https://mediaklikk.hu",
        ...extraHeaders,
      }
    };
    client.get(targetUrl, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = Buffer.alloc(0);
      res.on("data", (chunk) => data = Buffer.concat([data, chunk]));
      res.on("end", () => resolve({ body: data.toString(), headers: res.headers, status: res.statusCode }));
    }).on("error", reject);
  });
}

function proxyStream(targetUrl, res) {
  const client = targetUrl.startsWith("https") ? https : http;
  client.get(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://mediaklikk.hu/",
    }
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

  const makeAbsolute = (url) => {
    try { return new URL(url).href; }
    catch { return new URL(url, base).href; }
  };

  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." attributes inside tag lines (e.g. #EXT-X-MEDIA, #EXT-X-KEY)
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absolute = makeAbsolute(uri);
        return `URI="${proxyBase}/segment?url=${encodeURIComponent(absolute)}"`;
      });
    }

    // Rewrite plain URL lines (variant playlists, segments)
    const absolute = makeAbsolute(trimmed);
    return `${proxyBase}/segment?url=${encodeURIComponent(absolute)}`;
  }).join("\n");
}


async function getM1Stream() {
  // Step 1: get the token from Mediaklikk's token API
  const tokenUrl = "https://player.mediaklikk.hu/playernew/player.php?video=mtv1live&noflash=yes&autostart=true";
  const { body } = await fetch(tokenUrl);

  // The URL is embedded as JSON with escaped slashes: "file":"https:\/\/..."
  // Match both escaped and unescaped versions, then unescape
  const patterns = [
    /"file"\s*:\s*"(https?:\\\/\\\/[^"]+\.m3u8[^"]*)"/i,
    /"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i,
    /"file"\s*:\s*"(https?:[^"]+\.m3u8[^"]*)"/i,
    /(https?:\\\/\\\/[^\s"']+\.m3u8[^\s"']*)/i,
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      const url = (match[1] || match[0]).replace(/\\\//g, "/");
      console.log("Extracted M1 URL:", url);
      return url;
    }
  }

  // Step 2: try the MTVA token API directly
  const tokenApiUrl = "https://player.mediaklikk.hu/player/api/token?channel=m1";
  const tokenResp = await fetch(tokenApiUrl);
  try {
    const json = JSON.parse(tokenResp.body);
    if (json.url) return json.url;
    if (json.stream) return json.stream;
    if (json.file) return json.file;
  } catch {}

  // Step 3: try known MTVA stream API pattern
  const mtvaApiUrl = "https://player.mediaklikk.hu/playernew/player.php?noflash=yes&video=mtv1live";
  const mtvaResp = await fetch(mtvaApiUrl, { "Accept": "application/json" });
  try {
    const json = JSON.parse(mtvaResp.body);
    const str = JSON.stringify(json);
    const m = str.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
    if (m) return m[0];
  } catch {}

  throw new Error("Could not extract M1 stream URL. Body preview: " + body.slice(0, 500));
}

async function getRtlStream() {
  const pageUrl = "https://livestreamlinks.net/onlinetv/hungary/rtl";
  console.log("Fetching RTL page:", pageUrl);
  const { body: html } = await fetch(pageUrl, {
    "Referer": "https://livestreamlinks.net/",
    "Origin": "https://livestreamlinks.net"
  });

  // Patterns to find .m3u8 URLs in the HTML
  const m3u8Patterns = [
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi,
    /"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i,
    /"url"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i,
    /"source"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i,
    /"hls"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i,
    /<source[^>]+src=["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /data-hls-source=["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];

  let foundUrl = null;
  for (const pattern of m3u8Patterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const candidate = match[1];
      // Filter out obvious non‑stream URLs (e.g. ads, placeholders)
      if (candidate && !candidate.includes("ad") && !candidate.includes("placeholder")) {
        foundUrl = candidate;
        break;
      }
    }
    if (foundUrl) break;
  }

  if (!foundUrl) {
    // Last resort: any .m3u8 in the page (take the first one)
    const anyM3u8 = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    if (anyM3u8) foundUrl = anyM3u8[0];
  }

  if (!foundUrl) {
    throw new Error("Could not find any m3u8 stream URL in the RTL page");
  }

  // Resolve relative URLs (rare, but safe)
  const absoluteUrl = foundUrl.startsWith("http") ? foundUrl : new URL(foundUrl, pageUrl).href;
  console.log("Extracted RTL stream URL:", absoluteUrl);
  return absoluteUrl;
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

  // /m1 — resolve M1 stream and return proxied m3u8
  if (path === "/m1") {
    try {
      const m3u8Url = await getM1Stream();
      console.log("Resolved M1 stream:", m3u8Url);

      const { body: m3u8Content, headers: m3u8Headers } = await fetch(m3u8Url);
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
      console.error("M1 error:", e.message);
      res.writeHead(502, CORS_HEADERS);
      res.end("M1 error: " + e.message);
    }
    return;
  }

  // /m1debug — return raw player page for debugging
  if (path === "/m1debug") {
    try {
      const { body } = await fetch("https://player.mediaklikk.hu/playernew/player.php?video=mtv1live&noflash=yes&autostart=true");
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/plain" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, CORS_HEADERS);
      res.end(e.message);
    }
    return;
  }

  // /rtl — extract RTL stream and return proxied m3u8
  if (path === "/rtl") {
    try {
      const m3u8Url = await getRtlStream();
      console.log("Resolved RTL stream:", m3u8Url);

      // Fetch the master/variant playlist with RTL‑specific headers
      const { body: m3u8Content, headers: m3u8Headers } = await fetch(m3u8Url, {
        "Referer": "https://livestreamlinks.net/",
        "Origin": "https://livestreamlinks.net"
      });

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
      console.error("RTL error:", e.message);
      res.writeHead(502, CORS_HEADERS);
      res.end("RTL error: " + e.message);
    }
    return;
  }

  // /rtldebug — return raw HTML of the RTL page for debugging
  if (path === "/rtldebug") {
    try {
      const { body } = await fetch("https://livestreamlinks.net/onlinetv/hungary/rtl", {
        "Referer": "https://livestreamlinks.net/",
        "Origin": "https://livestreamlinks.net"
      });
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/plain" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, CORS_HEADERS);
      res.end(e.message);
    }
    return;
  }

  // /proxy?url= — proxy any m3u8
  if (path === "/proxy") {
    const targetUrl = query.url;
    if (!targetUrl) { res.writeHead(400, CORS_HEADERS); res.end("Missing url"); return; }
    try {
      const { body, headers } = await fetch(targetUrl);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const proxyBase = `${proto}://${req.headers.host}`;
      const rewritten = rewriteM3u8(body, targetUrl, proxyBase);
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": headers["content-type"] || "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" });
      res.end(rewritten);
    } catch (e) {
      res.writeHead(502, CORS_HEADERS);
      res.end("Failed: " + e.message);
    }
    return;
  }

  // /segment?url= — proxy segment or nested m3u8
  if (path === "/segment") {
    const targetUrl = query.url;
    if (!targetUrl) { res.writeHead(400, CORS_HEADERS); res.end("Missing url"); return; }
    if (targetUrl.includes(".m3u8") || targetUrl.includes("m3u8")) {
      try {
        const { body, headers } = await fetch(targetUrl);
        const proto = req.headers["x-forwarded-proto"] || "https";
        const proxyBase = `${proto}://${req.headers.host}`;
        const rewritten = rewriteM3u8(body, targetUrl, proxyBase);
        res.writeHead(200, { ...CORS_HEADERS, "Content-Type": headers["content-type"] || "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" });
        res.end(rewritten);
      } catch (e) {
        res.writeHead(502, CORS_HEADERS); res.end("Failed: " + e.message);
      }
      return;
    }
    proxyStream(targetUrl, res);
    return;
  }

  // /stream — ATV raw MPEG-TS
  if (path === "/stream") {
    proxyStream(`http://5.15.3.247:9988/stream/channel/234c63837f38efb4fbefc383a4b8c453`, res);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end("Not found");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Proxy server on port ${PORT}`));