const http = require("http");
const https = require("https");
const url = require("url");
const { spawn } = require("child_process");

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

function proxyStream(targetUrl, res, extraHeaders = {}) {
  const client = targetUrl.startsWith("https") ? https : http;
  client.get(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://mediaklikk.hu/",
      ...extraHeaders,
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
  const makeAbsolute = (u) => {
    try { return new URL(u).href; }
    catch { return new URL(u, base).href; }
  };
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) =>
        `URI="${proxyBase}/segment?url=${encodeURIComponent(makeAbsolute(uri))}"`
      );
    }
    return `${proxyBase}/segment?url=${encodeURIComponent(makeAbsolute(trimmed))}`;
  }).join("\n");
}

async function getM1Stream() {
  const tokenUrl = "https://player.mediaklikk.hu/playernew/player.php?video=mtv1live&noflash=yes&autostart=true";
  const { body } = await fetch(tokenUrl);
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
      const u = (match[1] || match[0]).replace(/\\\//g, "/");
      console.log("Extracted M1 URL:", u);
      return u;
    }
  }
  const tokenApiUrl = "https://player.mediaklikk.hu/player/api/token?channel=m1";
  const tokenResp = await fetch(tokenApiUrl);
  try {
    const json = JSON.parse(tokenResp.body);
    if (json.url) return json.url;
    if (json.stream) return json.stream;
    if (json.file) return json.file;
  } catch {}
  throw new Error("Could not extract M1 stream URL. Body preview: " + body.slice(0, 500));
}

// RTL Hungary — H.264 video + MP2 audio (native passthrough from TVheadend)
// ffmpeg transcodes audio only: MP2 → AAC-LC. Video is bit-exact H.264 copy.
// CPU cost is minimal — audio-only transcode on a single stereo stream.
const RTL_SOURCE =
  "http://5.15.3.247:9988/stream/channel/2b5c7013a78488b6f2339075d66e0414?profile=pass";

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  if (path === "/health") { res.writeHead(200, CORS_HEADERS); res.end("ok"); return; }

  // /m1 — resolve M1 stream and proxy rewritten m3u8
  if (path === "/m1") {
    try {
      const m3u8Url = await getM1Stream();
      const { body, headers: m3u8Headers } = await fetch(m3u8Url);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const proxyBase = `${proto}://${req.headers.host}`;
      const rewritten = rewriteM3u8(body, m3u8Url, proxyBase);
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

  // /m1debug — raw mediaklikk player page for debugging
  if (path === "/m1debug") {
    try {
      const { body } = await fetch("https://player.mediaklikk.hu/playernew/player.php?video=mtv1live&noflash=yes&autostart=true");
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/plain" });
      res.end(body);
    } catch (e) { res.writeHead(502, CORS_HEADERS); res.end(e.message); }
    return;
  }

  // /rtl — H.264 passthrough + MP2→AAC-LC audio transcode via ffmpeg
  if (path === "/rtl") {
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    });

    const ff = spawn("ffmpeg", [
  "-loglevel", "warning",

  // 1. Improved input flags for live streams
  "-fflags", "nobuffer+genpts+flush_packets", 
  "-flags", "low_delay",

  "-i", RTL_SOURCE,

  "-map", "0:v:0",
  "-map", "0:a:0",

  // 2. VIDEO FIX: Ensure SPS/PPS are injected
  // 'dump_extra' forces headers into the stream for every keyframe
  "-c:v", "copy",
  "-bsf:v", "h264_mp4toannexb,dump_extra",

  // 3. AUDIO: Standard AAC-LC (keep as is or slightly simplified)
  "-c:a", "aac",
  "-b:a", "128k", 
  "-ar", "48000",
  "-ac", "2",

  // 4. MUXER FIX: Force header repetition
  "-f", "mpegts",
  "-mpegts_headers_period", "1", // Resend headers every second
  "-mpegts_flags", "resend_headers",
  "-muxdelay", "0",
  "-muxpreload", "0",

  "pipe:1",
]);

    ff.stdout.pipe(res);
    ff.stderr.on("data", (d) => console.error("[RTL]", d.toString().trim()));
    ff.on("close", (code) => {
      console.log(`[RTL] ffmpeg exited ${code}`);
      if (!res.writableEnded) res.end();
    });
    req.on("close", () => ff.kill("SIGKILL"));
    return;
  }

  // /rtldebug — raw passthrough from TVheadend for debugging
  if (path === "/rtldebug") {
    proxyStream(RTL_SOURCE, res);
    return;
  }

  // /stream — ATV raw MPEG-TS
  if (path === "/stream") {
    proxyStream("http://5.15.3.247:9988/stream/channel/234c63837f38efb4fbefc383a4b8c453", res);
    return;
  }

  // /proxy?url= — generic m3u8 proxy
  if (path === "/proxy") {
    const targetUrl = query.url;
    if (!targetUrl) { res.writeHead(400, CORS_HEADERS); res.end("Missing url"); return; }
    try {
      const { body, headers } = await fetch(targetUrl);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const proxyBase = `${proto}://${req.headers.host}`;
      const rewritten = rewriteM3u8(body, targetUrl, proxyBase);
      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": headers["content-type"] || "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
      });
      res.end(rewritten);
    } catch (e) { res.writeHead(502, CORS_HEADERS); res.end("Failed: " + e.message); }
    return;
  }

  // /segment?url= — proxy individual segments or nested m3u8
  if (path === "/segment") {
    const targetUrl = query.url;
    if (!targetUrl) { res.writeHead(400, CORS_HEADERS); res.end("Missing url"); return; }
    if (targetUrl.includes(".m3u8") || targetUrl.includes("m3u8")) {
      try {
        const { body, headers } = await fetch(targetUrl);
        const proto = req.headers["x-forwarded-proto"] || "https";
        const proxyBase = `${proto}://${req.headers.host}`;
        const rewritten = rewriteM3u8(body, targetUrl, proxyBase);
        res.writeHead(200, {
          ...CORS_HEADERS,
          "Content-Type": headers["content-type"] || "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        });
        res.end(rewritten);
      } catch (e) { res.writeHead(502, CORS_HEADERS); res.end("Failed: " + e.message); }
      return;
    }
    proxyStream(targetUrl, res);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end("Not found");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Proxy service 1 (M1 + ATV + RTL) on port ${PORT}`));
