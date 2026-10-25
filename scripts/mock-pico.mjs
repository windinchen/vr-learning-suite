// 模拟一台 PICO 头显：登记 → 拉清单 → 心跳 → 传画面 → 上报时长，没有真机时用来验证整条链路。
// 用法：node scripts/mock-pico.mjs [--serial PICO-4U-A1B2C3] [--base http://127.0.0.1:8787] [--interval 5] [--rounds 6] [--no-screen]
//      --serve [--respond-port 8790]  额外开一个「问话口」，让后台能按 IP 找上门来（对应真机上的 IdentityServer）；
//                                     开了这个口，跑完轮数也不退出，当成一台一直开着的头显
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

// 后台地址：老师从网页「让它连上后台」会敲 POST /v1/config 改它，所以是个能变的值
let base = flag("base", "http://127.0.0.1:8787").replace(/\/$/, "");
const serial = flag("serial", `PICO-4U-MOCK${String(Date.now()).slice(-4)}`);
const interval = Number(flag("interval", 5)) * 1000;
const rounds = Number(flag("rounds", 6));

import { mockScreenFrame } from "./png-frame.mjs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const noScreen = args.includes("--no-screen");
const noApps = args.includes("--no-apps");
const serve = args.includes("--serve");
const respondPort = Number(flag("respond-port", 8790));

/** 写死的一份「这台装着什么」：没开过 Unity 编辑器时的兜底，够把链路跑通。 */
const BUILTIN_INSTALLS = [
  { packageName: "com.school.vr.ski", label: "雪山滑雪", version: "1.0.0", isVr: true },
  { packageName: "com.school.vr.shooting", label: "射击打靶", version: "1.0.0", isVr: true },
  { packageName: "com.school.vr.therapy", label: "心理拓展·疗法训练", version: "1.0.0", isVr: true },
  { packageName: "com.pico.vr.browser", label: "PICO 浏览器", version: "3.1.0", isSystem: true },
  { packageName: "com.pico.vr.store", label: "PICO 商店", version: "5.2.1", isSystem: true },
  { packageName: "com.qualcomm.qti.xrserver", label: "XR 系统服务", version: "1.4.0", isSystem: true },
];

/**
 * 优先读启动器在 Mac 上模拟本机清单用的那份 JSON（`LocalAppScanner` 读的就是它）：
 * 两边都用同一个序列号上线时，各报各的清单会让后报的那个把对方的应用标成「已卸载」，看着像后台在乱改。
 * 读不到就退回写死的那份；加 `--builtin-apps` 强制用写死的（想让自检结果固定时用）。
 */
function loadInstalls() {
  if (args.includes("--builtin-apps")) {
    return BUILTIN_INSTALLS;
  }
  const file = path.join(os.homedir(), "Library", "Application Support", "school", "VR 学习启动器", "local-apps.json");
  try {
    const installs = (JSON.parse(readFileSync(file, "utf8")).apps ?? [])
      .filter((item) => item?.packageName && !item.isSelf)
      .map((item) => ({
        packageName: item.packageName,
        label: item.label ?? item.packageName,
        version: item.version ?? "1.0.0",
        isVr: Boolean(item.isVr),
        isSystem: Boolean(item.isSystem),
      }));
    if (installs.length) {
      console.log(`本机清单读的是启动器那份 ${file}（${installs.length} 个应用，两边报的就是一致的）`);
      return installs;
    }
  } catch {
    // 没这个文件就是纯脚本模拟，用写死的那份，不用吵
  }
  return BUILTIN_INSTALLS;
}

const INSTALLS = loadInstalls();

/** 画面是二进制，和 JSON 接口分开走。 */
async function uploadScreen(token, frame, foreground) {
  const response = await fetch(`${base}/api/v1/devices/screen`, {
    method: "POST",
    headers: {
      "X-Device-Token": token,
      "Content-Type": "image/png",
      "X-Frame-Width": "480",
      "X-Frame-Height": "270",
      "X-Frame-App": foreground,
    },
    body: frame,
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function call(path, { method = "GET", body, token } = {}) {
  try {
    const result = await runCall(path, { method, body, token });
    backendOnline = true;
    backendError = "";
    return result;
  } catch (error) {
    backendOnline = false;
    backendError = error.message;
    throw error;
  }
}

async function runCall(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Device-Token": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${json.error ?? ""}`);
  }
  return json;
}

// 这台「现在能不能连上后台」：问话口答话时如实回报，口径跟启动器里的 IdentityServer 一致
let backendOnline = false;
let backendError = "";
// 老师推来新后台地址时置位：旧地址拿的令牌在新后台不作数，得重新登记一次
let reenroll = false;

const minutes = (value) => (value / 60).toFixed(1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 向「当前这个后台」登记拿令牌；后台重启的一瞬间别把模拟头显一起带走，失败就一直重试到它起来。 */
async function enrollToBackend(note = "") {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await call("/devices/enroll", {
        method: "POST",
        body: { serial, name: "模拟头显", model: "PICO 4 Ultra Enterprise", launcherVersion: "0.1.0" },
      });
      token = result.token;
      reenroll = false;
      if (note) {
        console.log(`${note}：已重新登记到 ${base}，设备 #${result.deviceId}`);
      }
      return result;
    } catch (error) {
      if (attempt === 1 || attempt % 10 === 0) {
        console.log(`后台还没起来（${base}·${error?.cause?.code ?? error.message}），3 秒后重试…`);
      }
      await sleep(3000);
    }
  }
}

// 前台在跑什么、电量多少：问话口答话时要用，所以得在开问话口之前就备好
let running = null;
let runningSince = Date.now();
// 前台包名：报成应用 key 老师就看不懂在跑什么了，一律报包名
let foregroundPackage = "com.school.vr.launcher";
let battery = 88;

let token = "";
// 问话口先开起来再去登记：真启动器也是不管连没连上后台都一直开着 8790。
// 老师最常撞的就是「头显不知道后台地址、一直登记不上」——这时问话口开着，才谈得上按 IP 找到它、把地址推过来
if (serve) {
  startResponder();
}
const enrolled = await enrollToBackend();
console.log(`已登记：设备 #${enrolled.deviceId} 配对码 ${enrolled.pairingCode}｜后台 ${base}`);

/** 把这台「装着什么」报给后台，老师在网页的「头显应用」页就能逐台配策略。 */
async function syncApps(reason) {
  const result = await call("/devices/apps/sync", { method: "POST", token, body: { apps: INSTALLS } });
  console.log(
    `本机应用上报${reason ? `（${reason}）` : ""}：扫到 ${result.scanned} 个，新发现 ${result.discovered} 个，标记卸载 ${result.uninstalled} 个`,
  );
}

// 开机先报一次本机应用，老师不用点「扫描」也能在这台头显的页面上看到装着什么
if (!noApps) {
  await syncApps();
}

/** 本机局域网 IPv4：模拟头显的问话口绑在 0.0.0.0，老师从别的电脑要填的是这个地址。 */
function lanIpv4() {
  for (const list of Object.values(networkInterfaces() ?? {})) {
    for (const item of list ?? []) {
      if ((item.family === "IPv4" || item.family === 4) && !item.internal) {
        return item.address;
      }
    }
  }
  return "";
}

/**
 * 「问话口」：后台按 IP 登记头显时，是它主动来敲 GET /v1/identity 问「你是谁、装着什么」。
 * 真机上是 Unity 里的 IdentityServer 在答，这里用 node 复刻一个，没真机也能把这条链路跑通。
 * 顺带支持 POST /v1/config：老师在网页点「让它连上后台」时，后台会把真实地址推过来，这台从此照新地址上线。
 */
function startResponder() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && path === "/v1/config") {
      const raw = await readBody(req);
      let wanted = "";
      try {
        wanted = String(JSON.parse(raw || "{}").serverBaseUrl ?? "").trim().replace(/\/+$/, "");
      } catch {
        wanted = "";
      }
      if (!/^https?:\/\/[^/]+:\d+$/.test(wanted)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `后台地址得是 http://IP:端口 这样，这儿给的是「${wanted}」` }));
        return;
      }
      const previous = base;
      base = wanted;
      reenroll = true;
      console.log(`问话口收到后台地址：${previous} → ${base}，后面的登记心跳都改敲这个`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ serverBaseUrl: base, applied: true, changed: previous !== base }));
      return;
    }
    if (req.method !== "GET" || path !== "/v1/identity") {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "这台只答 GET /v1/identity 和 POST /v1/config" }));
      return;
    }
    // 报的是「被敲的那个地址」，跟 Unity 那边 IdentityServer 的口径一致：
    // 老师从另一台电脑敲局域网 IP 时，答的就得是局域网 IP，不是 127.0.0.1
    const answered = req.socket.localAddress?.replace("::ffff:", "") || "127.0.0.1";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        serial,
        name: "模拟头显",
        model: "PICO 4 Ultra Enterprise",
        launcherVersion: "0.1.0",
        battery,
        foregroundApp: foregroundPackage,
        ip: answered,
        serverBaseUrl: base,
        backendOnline,
        backendError,
        apps: INSTALLS,
      }),
    );
  });
  server.on("error", (error) => {
    console.log(`问话口 :${respondPort} 没开起来（${error.code ?? error.message}），这台只能自己连后台`);
  });
  server.listen(respondPort, "0.0.0.0", () => {
    const lan = lanIpv4();
    const fill = lan ? `127.0.0.1 或 ${lan}` : "127.0.0.1";
    console.log(`问话口已开：http://127.0.0.1:${respondPort}/v1/identity　后台「按 IP 找头显」填 ${fill} 就能问到它`);
  });
  return server;
}

/** 读一小段请求体（问话口只收后台那一两句配置，量很小）。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

async function oneRound(round) {
  if (reenroll) {
    await enrollToBackend("后台地址被老师改过");
  }
  const manifest = await call("/manifest", { token });
  const status = manifest.locked.locked ? `🔒 锁定：${manifest.locked.reason}` : "✅ 可用";
  const lesson = manifest.lesson;
  const lessonText = lesson?.active
    ? `上课中《${lesson.title}》· 使用者 ${lesson.student?.name ?? "还没定"}`
    : "没在课上";
  console.log(`\n—— 第 ${round} 轮（${status}）${lessonText}`);
  for (const app of manifest.apps) {
    const left = app.remainingMinutes === null ? "不限时长" : `剩 ${app.remainingMinutes} 分钟`;
    console.log(
      `   ${app.allowed ? "▶" : "⛔"} ${app.icon} ${app.name}｜今日已用 ${minutes(app.usedMinutes * 60)} 分钟｜${left}${app.reason ? `｜原因：${app.reason}` : ""}`,
    );
  }

  // 心跳 + 挑一个允许的应用「运行」一段时间
  const candidate = manifest.locked.locked ? null : manifest.apps.find((app) => app.allowed);
  const foreground = candidate ? candidate.packageName : "com.school.vr.launcher";
  foregroundPackage = foreground;

  // 上课中就把画面传上去，老师在网页的「上课」页能直接看到这台在跑什么
  if (!noScreen && lesson?.active && lesson.screen?.enabled) {
    const frame = mockScreenFrame({ foreground, progress: (round % 10) / 10 });
    const upload = await uploadScreen(token, frame, foreground);
    console.log(`   画面上传 ${upload.status === 200 ? `OK（${frame.length} 字节）` : `失败 ${upload.status} ${upload.text}`} ${
      lesson.screen.intervalMs ? `· 服务端要求 ${lesson.screen.intervalMs}ms 一帧` : ""
    }`);
  }
  const beat = await call("/devices/heartbeat", {
    method: "POST",
    token,
    body: { battery, foregroundApp: foreground, wifi: "school-5G", launcherVersion: "0.1.0" },
  });
  console.log(`   心跳 OK，前台=${foreground}，待执行指令 ${beat.commands.length} 条`);

  for (const command of beat.commands) {
    console.log(`   收到指令 ${command.type}${command.payload?.text ? `：${command.payload.text}` : ""}`);
    if (command.type === "lock" || command.type === "unlock") {
      console.log("   → 已切换锁定状态");
    }
    if (command.type === "scan" && !noApps) {
      await syncApps("响应老师的扫描指令");
    }
    await call("/commands/ack", { method: "POST", token, body: { ids: [command.id] } });
  }

  if (candidate) {
    const seconds = Math.max(60, Math.round(interval / 1000) * 10);
    const endedAt = Date.now();
    const report = await call("/usage/batch", {
      method: "POST",
      token,
      body: {
        batchId: `mock-${serial}-${round}`,
        events: [
          {
            appKey: candidate.key,
            startedAt: running === candidate.key ? runningSince : endedAt - seconds * 1000,
            endedAt,
            seconds,
          },
        ],
      },
    });
    console.log(`   上报 ${candidate.name} ${seconds}s → 入库 ${report.accepted} 条，重复 ${report.duplicates} 条`);
    running = candidate.key;
    runningSince = endedAt;
  } else {
    console.log("   没有可运行的应用，本轮不上报时长");
    running = null;
  }
}

// 开着问话口就等于「这台头显一直开着」，不指定轮数就一直心跳下去
const totalRounds = serve && !args.includes("--rounds") ? Infinity : rounds;
for (let round = 1; round <= totalRounds; round += 1) {
  battery = Math.max(6, 88 - (round % 80));
  try {
    await oneRound(round);
  } catch (error) {
    // 后台重启、网络抖一下都算正常，等下一轮自己接上
    console.log(`\n—— 第 ${round} 轮没跑完（${error?.cause?.code ?? error.message}），等下一轮自动重试`);
  }

  if (round < totalRounds) {
    await sleep(interval);
  }
}
console.log("\n模拟结束。打开后台网页即可看到时长与状态变化。");
