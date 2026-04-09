const http = require("http");

const TARGET_HOST = "5.15.3.247";
const TARGET_PORT = 9988;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

const server = http.createServer((req, res) => {
  // Handle preflight
  if (req.method === "OPTIONS" || req.method === "HEAD") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: "GET",
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`,
    },
  };

  const proxy = http.request(options, (proxyRes) => {
    // Strip any existing CORS headers from upstream, replace with ours
    const headers = {};
    for (const [key, val] of Object.entries(proxyRes.headers)) {
      if (!key.toLowerCase().startsWith("access-control")) {
        headers[key] = val;
      }
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
server.listen(PORT, () => console.log(`ATV proxy running on port ${PORT}`));
