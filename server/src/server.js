// HTTP 入口：同一端口提供 API 和老师网页。默认 http://127.0.0.1:8787
import http from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "./api.js";
import { HttpError } from "./api.js";
import { bumpManifestRev, db } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "..", "web");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8787);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 后台在这间机房里的地址：推给头显当「后台地址」用。
 * 老师浏览器地址栏里那个最好使，照抄；但他填的是 127.0.0.1 时不能直接推给头显
 * （那是后台这台电脑的环回口，头显照着连就连到自己身上），换成本机局域网 IP。
 * PUBLIC_BASE_URL 显式配了就用它（机房有多块网卡、走域名或反代时用）。
 */
function lanIpv4() {
  for (const list of Object.values(networkInterfaces() ?? {})) {
    for (const item of list ?? []) {
      if ((item.family === "IPv4" || item.family === 4) && !item.internal) {
        return item.address;
      }
    }
  }
  return null;
}

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }
  const header = String(req.headers.host ?? "").trim();
  const bare = header.replace(/:\d+$/, "");
  if (bare && !/^(127\.|localhost$|::1$|\[::1\]$)/.test(bare)) {
    return `http://${header}`;
  }
  return `http://${lanIpv4() ?? "127.0.0.1"}:${port}`;
}

function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

/** 读原始字节：头显传上来的一帧画面就是 JPEG 二进制，不走 JSON。 */
function readRaw(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, "请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonBody(buffer) {
  const text = buffer.toString("utf8");
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, "请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// 路由表：先匹配固定路径，再匹配带参数的
const routes = [
  ["POST", /^\/api\/v1\/auth\/login$/, (ctx) => api.login(ctx.body), { public: true, cookie: true }],
  // 免登录：头显扫网段找后台时靠它认人（认 product，不认端口号）
  ["GET", /^\/api\/v1\/hello$/, (ctx) => api.hello(ctx), { public: true }],
  ["POST", /^\/api\/v1\/auth\/logout$/, (ctx) => api.logout(ctx.token), { clearCookie: true }],
  ["GET", /^\/api\/v1\/me$/, (ctx) => ({ teacher: ctx.teacher, serverTime: Date.now() })],

  ["POST", /^\/api\/v1\/devices\/enroll$/, (ctx) => api.enrollDevice(ctx.body), { public: true }],
  ["GET", /^\/api\/v1\/manifest$/, (ctx) => api.deviceManifest(ctx.deviceToken), { public: true }],
  ["POST", /^\/api\/v1\/devices\/heartbeat$/, (ctx) => api.deviceHeartbeat(ctx.deviceToken, ctx.body), { public: true }],
  ["POST", /^\/api\/v1\/commands\/ack$/, (ctx) => api.ackCommands(ctx.deviceToken, ctx.body.ids), { public: true }],
  ["POST", /^\/api\/v1\/usage\/batch$/, (ctx) => api.reportUsageBatch(ctx.deviceToken, ctx.body), { public: true }],
  ["POST", /^\/api\/v1\/devices\/apps\/sync$/, (ctx) => api.syncDeviceApps(ctx.deviceToken, ctx.body), { public: true }],
  ["POST", /^\/api\/v1\/devices\/violation$/, (ctx) => api.reportViolation(ctx.deviceToken, ctx.body), { public: true }],

  ["GET", /^\/api\/v1\/dashboard$/, (ctx) => api.dashboard()],
  // 顺带把「这台后台该被头显怎么访问」一起报出去：老师用 127.0.0.1 打开网页时，
  // 地址栏那个地址对头显是没用的（头显照抄就连到自己身上），得用后台自己的局域网地址
  ["GET", /^\/api\/v1\/devices$/, (ctx) => ({ devices: api.listDevices(), backendUrl: ctx.publicBase })],
  ["PATCH", /^\/api\/v1\/devices\/(\d+)$/, (ctx, m) => api.patchDevice(m[1], ctx.body, ctx.teacher)],
  ["GET", /^\/api\/v1\/devices\/(\d+)\/apps$/, (ctx, m) => api.deviceAppInventory(m[1])],
  ["POST", /^\/api\/v1\/devices\/screen$/, (ctx) => api.uploadScreen(ctx), { public: true, raw: true }],
  ["POST", /^\/api\/v1\/devices\/(\d+)\/command$/, (ctx, m) => api.queueCommand(m[1], ctx.body, ctx.teacher)],
  ["POST", /^\/api\/v1\/devices$/, (ctx) => api.createDevice(ctx.body, ctx.teacher)],
  // 按 IP 找头显：后台反过来敲头显的问话口，不用头显先连上后台
  ["POST", /^\/api\/v1\/devices\/discover$/, (ctx) => api.discoverDevices(ctx.body, ctx.teacher)],
  ["POST", /^\/api\/v1\/devices\/discover\/adopt$/, (ctx) => api.adoptDevice(ctx.body, ctx.teacher, ctx.publicBase)],
  ["POST", /^\/api\/v1\/devices\/(\d+)\/backend$/, (ctx, m) => api.pushDeviceBackend(m[1], ctx.body, ctx.teacher, ctx.publicBase)],
  ["DELETE", /^\/api\/v1\/devices\/(\d+)$/, (ctx, m) => api.deleteDevice(m[1], ctx.body, ctx.teacher)],
  ["POST", /^\/api\/v1\/devices\/(\d+)\/apps$/, (ctx, m) => api.addDeviceApp(m[1], ctx.body, ctx.teacher)],
  ["DELETE", /^\/api\/v1\/devices\/(\d+)\/apps\/(.+)$/, (ctx, m) => api.deleteDeviceApp(m[1], m[2], ctx.teacher)],

  ["GET", /^\/api\/v1\/students$/, (ctx) => ({ students: api.listStudents() })],
  ["POST", /^\/api\/v1\/students$/, (ctx) => api.createStudent(ctx.body, ctx.teacher)],
  ["POST", /^\/api\/v1\/students\/bulk$/, (ctx) => api.bulkCreateStudents(ctx.body, ctx.teacher)],
  ["PATCH", /^\/api\/v1\/students\/(\d+)$/, (ctx, m) => api.patchStudent(m[1], ctx.body, ctx.teacher)],
  ["DELETE", /^\/api\/v1\/students\/(\d+)$/, (ctx, m) => api.deleteStudent(m[1], ctx.body, ctx.teacher)],
  ["GET", /^\/api\/v1\/students\/(\d+)\/usage$/, (ctx, m) => api.studentUsage(m[1], ctx.url.searchParams)],

  ["GET", /^\/api\/v1\/classes$/, (ctx) => ({ classes: api.listClasses() })],
  ["POST", /^\/api\/v1\/classes$/, (ctx) => api.createClass(ctx.body, ctx.teacher)],
  ["PATCH", /^\/api\/v1\/classes\/(\d+)$/, (ctx, m) => api.patchClass(m[1], ctx.body, ctx.teacher)],
  ["DELETE", /^\/api\/v1\/classes\/(\d+)$/, (ctx, m) => api.deleteClass(m[1], ctx.body, ctx.teacher)],

  ["GET", /^\/api\/v1\/apps$/, (ctx) => ({ apps: api.listApps() })],
  ["POST", /^\/api\/v1\/apps$/, (ctx) => api.registerApp(ctx.body, ctx.teacher)],
  ["PATCH", /^\/api\/v1\/apps\/(\d+)$/, (ctx, m) => api.patchApp(m[1], ctx.body, ctx.teacher)],
  ["DELETE", /^\/api\/v1\/apps\/(\d+)$/, (ctx, m) => api.deleteApp(m[1], ctx.body, ctx.teacher)],

  ["POST", /^\/api\/v1\/admin\/reset$/, (ctx) => api.resetData(ctx.body, ctx.teacher)],

  // 上课：老师开一节课，当堂指定谁用哪台头显、能跑哪些应用，并可看头显实时画面
  ["GET", /^\/api\/v1\/lessons$/, (ctx) => ({ lessons: api.listLessons(ctx.url.searchParams.get("limit") ?? 30) })],
  ["GET", /^\/api\/v1\/lessons\/active$/, (ctx) => ({ lesson: api.currentLesson(ctx.teacher) })],
  ["POST", /^\/api\/v1\/lessons$/, (ctx) => api.startLesson(ctx.body, ctx.teacher)],
  ["GET", /^\/api\/v1\/lessons\/(\d+)$/, (ctx, m) => ({ lesson: api.getLesson(m[1]) })],
  ["POST", /^\/api\/v1\/lessons\/(\d+)\/assign$/, (ctx, m) => api.assignStudent(m[1], ctx.body)],
  ["POST", /^\/api\/v1\/lessons\/(\d+)\/apps$/, (ctx, m) => api.setLessonApps(m[1], ctx.body)],
  ["POST", /^\/api\/v1\/lessons\/(\d+)\/devices$/, (ctx, m) => api.addLessonDevice(m[1], ctx.body, ctx.teacher)],
  ["POST", /^\/api\/v1\/lessons\/(\d+)\/end$/, (ctx, m) => api.endLesson(m[1], ctx.teacher)],
  ["GET", /^\/api\/v1\/devices\/(\d+)\/screen$/, (ctx, m) => api.screenFrame(m[1]), { binary: true }],

  ["GET", /^\/api\/v1\/policies$/, (ctx) => ({ policies: api.listPolicies() })],
  ["PUT", /^\/api\/v1\/policies$/, (ctx) => api.putPolicy(ctx.body, ctx.teacher)],

  ["GET", /^\/api\/v1\/reports\/usage$/, (ctx) => api.reportUsage(ctx.url.searchParams)],
  ["GET", /^\/api\/v1\/violations$/, (ctx) => ({ violations: api.listViolations(ctx.url.searchParams.get("limit") ?? 60) })],
  ["GET", /^\/api\/v1\/audit$/, (ctx) => ({ logs: api.listAudit(ctx.url.searchParams.get("limit") ?? 80) })],
];

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.join(webRoot, rel);
  if (!target.startsWith(webRoot)) {
    send(res, 403, { error: "路径不合法" });
    return true;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      return false;
    }
    const data = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (!url.pathname.startsWith("/api/")) {
      if (await serveStatic(req, res, url.pathname)) {
        return;
      }
      // 单页应用兜底
      const data = await readFile(path.join(webRoot, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      res.end(data);
      return;
    }

    // DELETE 也得读体：像「删班但把学生移到未分班」这种二次确认就是写在体里的。
    // 以前这里连 DELETE 一起跳过，处理函数拿到的 body 永远是空对象，确认参数静默丢掉。
    const raw = req.method === "GET" ? Buffer.alloc(0) : await readRaw(req);
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const token = bearer || readCookie(req.headers.cookie, "suite_session");
    const deviceToken = req.headers["x-device-token"] ?? null;

    for (const [method, pattern, handler, options = {}] of routes) {
      if (method !== req.method) {
        continue;
      }
      const match = url.pathname.match(pattern);
      if (!match) {
        continue;
      }
      const ctx = {
        body: options.raw ? {} : parseJsonBody(raw),
        raw,
        headers: req.headers,
        url,
        token,
        deviceToken,
        teacher: null,
        publicBase: publicBaseUrl(req),
      };
      if (!options.public) {
        ctx.teacher = api.requireTeacher(token);
      }
      const result = await handler(ctx, match);
      // 老师做任何改动都可能影响某台头显的清单（放开应用、点名、下课、锁定……），
      // 与其在一百多个地方各补一句「通知头显」，不如在所有需要登录的写操作出口统一 +1：
      // 头显下次心跳（10 秒内）发现版本号变了就立刻重拉清单。
      // 头显自己上报的那批接口都是 public，不参与递增，否则心跳会把版本号自己推高、清单永远拉不完。
      if (!options.public && method !== "GET") {
        bumpManifestRev();
      }
      if (options.binary) {
        if (!result?.data) {
          send(res, 404, { error: "这台头显还没传过画面" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": result.contentType ?? "image/jpeg",
          "Content-Length": result.data.length,
          "Cache-Control": "no-store",
          "X-Frame-Ts": String(result.ts ?? ""),
        });
        res.end(result.data);
        return;
      }
      const headers = {};
      if (options.cookie && result?.token) {
        headers["Set-Cookie"] = `suite_session=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
          (result.expiresIn ?? 43200_000) / 1000,
        )}`;
      }
      if (options.clearCookie) {
        headers["Set-Cookie"] = "suite_session=; Path=/; HttpOnly; Max-Age=0";
      }
      send(res, 200, result, headers);
      return;
    }
    send(res, 404, { error: `没有这个接口：${req.method} ${url.pathname}` });
  } catch (error) {
    if (error instanceof HttpError) {
      send(res, error.status, { error: error.message });
    } else {
      console.error("[后台] 未处理异常：", error);
      send(res, 500, { error: `服务器内部错误：${error.message}` });
    }
  }
});

server.listen(port, host, () => {
  const devices = db.prepare("SELECT COUNT(*) AS n FROM devices").get().n;
  console.log(`VR 学习套件后台已启动： http://127.0.0.1:${port}  （数据库设备数 ${devices}）`);
  console.log(`PICO 端 API 基址：        http://<这台电脑的局域网IP>:${port}/api/v1`);
});
