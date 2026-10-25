
const express = require("express");
const { Readable } = require("node:stream");

const app = express();

const UPSTREAM =
  "http://212.200.230.50:1935";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

app.use((req, res, next) => {
  const origin = req.get("origin");

  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).send("Origin not allowed");
  }

  res.setHeader(
    "Access-Control-Allow-Origin",
    ALLOWED_ORIGIN
  );
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Range"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use("/hls", async (req, res) => {
  try {
    const path = req.path;

    // Only allow paths belonging to the RTV stream.
    if (
      !path.startsWith("/RTV/") ||
      path.includes("..") ||
      path.includes("\\")
    ) {
      return res.sendStatus(403);
    }

    const upstreamUrl = new URL(
      UPSTREAM + path + req.url.substring(
        req.path.length
      )
    );

    const upstream = await fetch(upstreamUrl, {
      headers: {
        ...(req.headers.range
          ? { Range: req.headers.range }
          : {})
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status).send(
        "Upstream stream request failed"
      );
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const isPlaylist =
      path.toLowerCase().endsWith(".m3u8") ||
      contentType.includes("mpegurl");

    res.status(upstream.status);
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    if (isPlaylist) {
      let playlist = await upstream.text();

      // Rewrite playlist URLs so segments and
      // nested playlists also go through HTTPS.
      const rewrite = (value, base) => {
        const url = new URL(value, base);

        if (
          url.hostname !== "212.200.230.50" ||
          url.port !== "1935" ||
          !url.pathname.startsWith("/RTV/")
        ) {
          throw new Error(
            "Playlist references an unexpected host"
          );
        }

        return "/hls" +
          url.pathname +
          url.search;
      };

      const base = upstreamUrl;

      playlist = playlist
        .split(/\r?\n/)
        .map(line => {
          const trimmed = line.trim();

          if (!trimmed) return line;

          if (trimmed.startsWith("#")) {
            return line.replace(
              /URI="([^"]+)"/g,
              (_, uri) =>
                `URI="${rewrite(uri, base)}"`
            );
          }

          return rewrite(trimmed, base);
        })
        .join("\n");

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      return res.send(playlist);
    }

    const headersToForward = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges"
    ];

    for (const header of headersToForward) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    res.setHeader(
      "Content-Type",
      contentType || "application/octet-stream"
    );

    if (req.method === "HEAD") {
      await upstream.body.cancel();
      return res.end();
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("Proxy error:", error.message);

    if (!res.headersSent) {
      res.status(502).send(
        "Unable to retrieve upstream stream"
      );
    } else {
      res.destroy(error);
    }
  }
});

app.get("/", (_req, res) => {
  res.send("RTV HLS proxy is running");
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Proxy listening on ${port}`);
});
