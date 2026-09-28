// ログイン不要のローカル確認用サーバー（Vercel不要）。
// ビルド済みの dist/ を配信しつつ、/api/generate を本物のAIで動かす。
// 使い方:
//   1) .env に ANTHROPIC_API_KEY を書く（cp .env.example .env）
//   2) npm run build
//   3) npm run start:local  → http://localhost:3001 を開く
// これで「本物のAIが入力に応じて動的に返す」ことをローカルで確認できる。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../api/generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const PORT = process.env.PORT || 3001;

// .env から ANTHROPIC_API_KEY を読む（dotenv 非依存の簡易パーサ）
(function loadEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(distDir, rel);
  // dist の外へは出さない
  if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(distDir, "index.html"); // SPA フォールバック
    if (fs.existsSync(idx)) {
      res.setHeader("Content-Type", MIME[".html"]);
      fs.createReadStream(idx).pipe(res);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // Vercel ハンドラ互換の shim（res.status().json()）
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (o) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(o));
  };

  if (req.method === "POST" && req.url.startsWith("/api/generate")) {
    let raw = "";
    let aborted = false;
    const MAX_BODY = 1024 * 1024; // 1MB 上限（過大な POST を拒否）
    req.on("data", (c) => {
      if (aborted) return;
      raw += c;
      if (raw.length > MAX_BODY) {
        aborted = true;
        res.status(413).json({ error: "input_too_large" });
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (aborted) return;
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = {};
      }
      try {
        await handler(req, res);
      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) });
        else res.end();
      }
    });
    return;
  }

  if (!fs.existsSync(distDir)) {
    res.status(500).json({ error: "dist/ がありません。先に `npm run build` を実行してください。" });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  const provider = process.env.GEMINI_API_KEY
    ? "Gemini（本物AI）"
    : process.env.ANTHROPIC_API_KEY
      ? "Claude（本物AI）"
      : "未設定（デモ再生に自動フォールバック）";
  console.log(`ローカル確認サーバー: http://localhost:${PORT}`);
  console.log(`AIプロバイダ: ${provider}`);
});
