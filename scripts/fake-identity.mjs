// 自检用的假头显问话口：应答 GET /v1/identity 和 POST /v1/config，
// 用来验证后台「按 IP 找头显 → 收编 → 把后台地址推回头显」这条链路。
// 传 legacy: true 起一台「旧启动器」：只有 /v1/identity，没有推地址的口，用来验后台怎么说。
//
// 当库用（自检脚本里起一个，端口传 0 让系统随便给一个空闲口，免撞上本机已经在用的 8790）：
//   const fake = await startFakeIdentity({ serial: "PICO-TEST-DISCOVER" });
//   ... 用 `127.0.0.1:${fake.port}` 当发现的 target ...
//   await fake.stop();
//
// 当命令用（手工试网页上的「按 IP 找头显」）：
//   node scripts/fake-identity.mjs [端口] [序列号]
import http from "node:http";
import net from "node:net";

/** 占一个空闲端口再立刻放开，拿到一个基本确定没人听的端口：用来验「这台 IP 没人应答」时后台怎么说。 */
export function closedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** 头显报上去的应用清单：一个不在目录里的新应用 + 一个不该被收进来的系统应用。 */
export const FAKE_APPS = [
  { packageName: "com.selftest.coach", label: "自检体测教练", version: "1.2.3", isVr: true, isSystem: false },
  { packageName: "com.pico.vr.launchpad", label: "PICO 桌面", version: "9.0.0", isVr: false, isSystem: true },
];

/**
 * 起一个假头显的问话口。
 * @param {{port?: number, serial?: string, name?: string, apps?: object[], battery?: number}} options
 *   port 传 0 或不传，由系统分配空闲端口；返回的 port 就是实际监听的端口。
 * @returns {Promise<{port: number, target: string, stop: () => Promise<void>, hits: () => number}>}
 */
export async function startFakeIdentity(options = {}) {
  const identity = {
    serial: options.serial ?? "PICO-FAKE-0001",
    name: options.name ?? "启动器",
    model: "PICO 4 Ultra Enterprise",
    launcherVersion: "0.1.0",
    battery: options.battery ?? 66,
    foregroundApp: "com.school.vr.launcher",
    ip: "127.0.0.1",
    apps: options.apps ?? FAKE_APPS,
    // 打包时写死的占位后台地址：收编时被后台推成真实地址，这才是「离线 → 在线」那一步
    serverBaseUrl: options.serverBaseUrl ?? "http://192.168.1.100:8787",
    backendOnline: options.backendOnline ?? false,
    backendError: options.backendError ?? "连不上：Connection refused",
  };
  const legacy = Boolean(options.legacy);

  let hits = 0;
  const pushes = [];
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    hits += 1;
    const path = (req.url ?? "").split("?")[0].replace(/\/$/, "");
    if (req.method === "GET" && (path === "/v1/identity" || path === "")) {
      json(res, 200, identity);
      return;
    }
    if (req.method === "POST" && path === "/v1/config") {
      if (legacy) {
        json(res, 404, { error: "not found: /v1/config" });
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          json(res, 400, { error: "body 不是 JSON" });
          return;
        }
        const next = String(body.serverBaseUrl ?? "").trim();
        if (!/^https?:\/\/[^/]+/.test(next)) {
          json(res, 400, { error: `后台地址得是 http://IP:端口 这样，给的是「${next}」` });
          return;
        }
        const previous = identity.serverBaseUrl;
        identity.serverBaseUrl = next.replace(/\/+$/, "");
        // 推过来就说明这个地址是后台自己报的，当作已连上；真实启动器会等心跳结果再改
        identity.backendOnline = true;
        identity.backendError = "";
        pushes.push({ from: previous, to: identity.serverBaseUrl, at: Date.now() });
        json(res, 200, { serverBaseUrl: identity.serverBaseUrl, applied: true, changed: previous !== identity.serverBaseUrl });
      });
      return;
    }
    json(res, 404, { error: `not found: ${path}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "0.0.0.0", resolve);
  });

  const port = server.address().port;
  return {
    port,
    target: `127.0.0.1:${port}`,
    hits: () => hits,
    /** 收到过几次「推后台地址」，以及每次从哪儿改到了哪儿 */
    pushes: () => pushes.slice(),
    /** 这台假头显现在的状态（后台地址、连上没连上） */
    state: () => ({ ...identity }),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 只有直接跑这个文件才真的起一个进程挂着；被 import 时不起。
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8790);
  const fake = await startFakeIdentity({ port, serial: process.argv[3] || "PICO-FAKE-0001", name: "自检假头显" });
  console.log(`假头显问话口已监听 ${fake.port}（序列号 ${process.argv[3] || "PICO-FAKE-0001"}），网页里填 ${fake.target}`);
  process.on("SIGTERM", () => {
    console.log(`假头显退出，共应答 ${fake.hits()} 次`);
    process.exit(0);
  });
}
