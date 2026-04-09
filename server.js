const http = require("http");

const TARGET_HOST = "5.15.3.247";
const TARGET_PORT = 9988;
const TARGET_PATH = "/stream/channel/79a8c00f96580b33b6599b9651cf89eb";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, CORS_HEADERS);
    res.end("ok");
    return;
  }

  if (req.url === "/stream.m3u8" || req.url === "/live.m3u8") {
    const host = req.headers.host;
    const streamUrl = `https://${host}/stream`;
    const m3u8 = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:0",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXTINF:0,",
      streamUrl,
    ].join("\n");
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/vnd.apple.mpegurl" });
    res.end(m3u8);
    return;
  }

  // Pass query params (e.g. ?profile=xxx) through to TVHeadend
  const query = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
  const targetPath = TARGET_PATH + query;

  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: targetPath,
    method: "GET",
    headers: {
      host: `${TARGET_HOST}:${TARGET_PORT}`,
      "user-agent": "Mozilla/5.0",
    },
  };

  const proxy = http.request(options, (proxyRes) => {
    const headers = {};
    for (const [key, val] of Object.entries(proxyRes.headers)) {
      if (!key.toLowerCase().startsWith("access-control")) headers[key] = val;
    }
    Object.assign(headers, CORS_HEADERS);
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxy.on("error", (err) => {
    res.writeHead(502, CORS_HEADERS);
    res.end("Proxy error: " + err.message);
  });

  req.pipe(proxy);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`ATV proxy on port ${PORT}`));
