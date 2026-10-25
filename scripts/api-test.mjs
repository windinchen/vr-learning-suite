// 后台接口自检：不引第三方测试框架，直接把「登记 → 扫描本机应用 → 逐台管控 → 越权 → 时长 → 报表」跑一遍并断言。
// 用法：node scripts/api-test.mjs [--base http://127.0.0.1:8787] [--account admin] [--password pico123456]
// 用一台固定的「自检专用」头显跑，重复跑不会让设备表和应用目录越长越大。
import { FAKE_APPS, startFakeIdentity, closedPort } from "./fake-identity.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = flag("base", "http://127.0.0.1:8787").replace(/\/$/, "");
const serial = flag("serial", "PICO-TEST-SELFCHECK");
const account = flag("account", "admin");
const password = flag("password", "pico123456");
// scripts/test.sh 会把它起的一次性临时库路径放这儿：有两条断言要把心跳时间拨回过去
const dbPath = flag("db", process.env.SELFTEST_DB ?? "");

// 自检专用的包名：前 3 个对应种子数据里已有的应用，第 4 个故意是后台没登记的第三方应用
const PKG = {
  ski: "com.school.vr.ski",
  shooting: "com.school.vr.shooting",
  therapy: "com.school.vr.therapy",
  system: "com.pico.vr.browser",
  unlisted: "com.school.test.unlisted",
  // 第 5、6 个用来验「清单跟着头显走」：一个头显报上来又消失（该自动退场），
  // 一个老师上过架后消失（该留着标「头显上没有了」）。跑完由自检删干净。
  tmpGone: "com.selftest.retired",
  tmpKept: "com.selftest.keptlisted",
};

let passed = 0;
const failures = [];

function check(title, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${title}${detail ? "　" + detail : ""}`);
  } else {
    failures.push(title);
    console.log(`  ❌ ${title}${detail ? "　" + detail : ""}`);
  }
}

function step(title) {
  console.log(`\n【${title}】`);
}

async function call(path, { method = "GET", body, token, deviceToken } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceToken ? { "X-Device-Token": deviceToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function must(path, options) {
  const result = await call(path, options);
  if (result.status >= 400) {
    throw new Error(`${options?.method ?? "GET"} ${path} → HTTP ${result.status} ${result.json?.error ?? ""}`);
  }
  return result.json;
}

const found = (list, packageName) => list.find((item) => item.packageName === packageName) ?? null;

// ---------- 0. 后台活着没 ----------
step("后台连通");
try {
  await fetch(base, { method: "GET" });
  check("后台可访问", true, base);
} catch {
  console.log(`  ❌ 连不上 ${base}，先 bash scripts/dev.sh`);
  process.exit(1);
}

// 头显「自动找后台」就是挨个地址敲这一句（免登录、认 product 暗号）。
// 这一条断了，真机上就只会一直显示「连不上这个后台」，而且怎么推地址都没用。
const hello = await call("/hello");
check("后台能自报家门（头显自动找后台靠它）",
  hello.status === 200 && hello.json?.product === "vr-suite" && Boolean(hello.json?.baseUrl),
  `product=${hello.json?.product}｜baseUrl=${hello.json?.baseUrl}`);

// ---------- 1. 登录 ----------
step("老师登录");
const badLogin = await call("/auth/login", { method: "POST", body: { account, password: "不对的密码" } });
check("错误密码被拒（HTTP 401）", badLogin.status === 401, badLogin.json?.error ?? "");

const session = await must("/auth/login", { method: "POST", body: { account, password } });
const teacher = session.token;
check("登录拿到会话", Boolean(teacher), `${session.teacher?.name}（${session.teacher?.account}）`);

const noToken = await call("/manifest", { deviceToken: "dev_not_a_real_token" });
check("乱填设备令牌被拒（HTTP 403）", noToken.status === 403, noToken.json?.error ?? "");
const noHeader = await call("/manifest");
check("没带设备令牌被拒（HTTP 401）", noHeader.status === 401, noHeader.json?.error ?? "");

// ---------- 1.5 自检前的准备 ----------
// 应用上不上架是老师说了算，自检不能假定它一定开着：全下架时课堂清单会把每个应用都标灰，
// 那几条断言就变成在测「下架」而不是在测「课堂安排」。这里临时把要用的几个上架，跑完原样还回去。
step("自检前的准备");
const needRunning = [PKG.ski, PKG.shooting, PKG.therapy];
const catalogBefore = (await must("/apps", { token: teacher })).apps;
const lacking = needRunning.filter((pkg) => !catalogBefore.some((app) => app.packageName === pkg));
check("自检要用的应用都在目录里", lacking.length === 0,
  lacking.length ? `缺 ${lacking.join("、")}｜先跑一轮 node scripts/mock-pico.mjs 让它扫出来` : "雪山滑雪／射击打靶／心理拓展");
const relisted = [];
for (const app of catalogBefore.filter((item) => needRunning.includes(item.packageName))) {
  if (!app.enabled) {
    await must(`/apps/${app.id}`, { method: "PATCH", token: teacher, body: { enabled: true } });
    relisted.push(app.id);
  }
}
check("要用的应用改成上架（老师下架过的只是临时上架）",
  (await must("/apps", { token: teacher })).apps
    .filter((app) => needRunning.includes(app.packageName))
    .every((app) => app.enabled === true),
  relisted.length ? `临时上架 ${relisted.length} 个：#${relisted.join("、#")}` : "本来就是上架的，没动老师的东西");

// ---------- 2. 设备登记 ----------
step("头显登记");
const enrolled = await must("/devices/enroll", {
  method: "POST",
  body: { serial, name: "自检专用头显（可忽略）", model: "PICO 4 Ultra Enterprise", launcherVersion: "0.1.0" },
});
const deviceId = enrolled.deviceId;
const deviceToken = enrolled.token;
check("登记成功", Boolean(deviceId) && Boolean(deviceToken), `设备 #${deviceId} 配对码 ${enrolled.pairingCode}`);

const first = await must("/manifest", { deviceToken });
check("首次清单能拉到", Array.isArray(first.apps) && first.apps.length > 0, `${first.apps.length} 个应用`);
check("默认白名单模式", first.mode === "allowlist", `mode=${first.mode}`);
const states = new Set(first.apps.map((item) => item.installState));
check("安装状态与实际扫描记录一致", first.local?.scanned ? [...states].every((state) => state === "installed" || state === "missing") : states.size === 1 && states.has("unknown"),
  `scanned=${first.local?.scanned}｜状态=${[...states].join("/")}`);

// ---------- 3. 扫描本机应用上报 ----------
step("上报本机应用");
const scanAll = [
  { packageName: PKG.ski, label: "雪山滑雪", version: "1.0.0", isVr: true },
  { packageName: PKG.shooting, label: "射击打靶", version: "1.0.0", isVr: true },
  { packageName: PKG.system, label: "PICO 浏览器", version: "3.1.0", isVr: false },
  { packageName: PKG.unlisted, label: "偷偷装的游戏", version: "0.9.0", isVr: true },
];
const sync1 = await must("/devices/apps/sync", { method: "POST", deviceToken, body: { apps: scanAll } });
check("扫到的都入库", sync1.scanned === scanAll.length, `scanned=${sync1.scanned}`);
const catalog = (await must("/apps", { token: teacher })).apps;
const stray = catalog.find((item) => item.packageName === PKG.unlisted) ?? null;
check("未登记的第三方应用自动进目录", Boolean(stray), stray ? `#${stray.id} ${stray.name}｜来源=${stray.source}` : "没找到");
check("自动进来的应用先不上架", stray ? stray.enabled === false : false, stray ? `enabled=${stray.enabled}` : "");
check("系统应用不会被当成新应用", !catalog.some((item) => item.packageName === PKG.system && item.source === "device"),
  `本次新发现 ${sync1.discovered} 个（PICO 浏览器按包名前缀识别为系统应用）`);
// 已装/缺失这两个数准不准，要看清单里的行对不对得上：断言写在下面拉到清单之后
// 「哪几台头显装着」是这张表的口径来源：由扫描记录现算，后台不另存一份
const skiCatalogRow = catalog.find((item) => item.packageName === PKG.ski);
check("应用目录里能看出它装在哪几台头显上",
  skiCatalogRow?.installedOn?.some((row) => row.id === deviceId) === true && Number(skiCatalogRow?.installedDevices) === skiCatalogRow.installedOn.length,
  skiCatalogRow ? `${skiCatalogRow.installedOn.map((row) => `${row.name}｜${row.version}`).join("、")}` : "没找到雪山滑雪");
check("应用目录里带最近一次扫到它的时间", Number(skiCatalogRow?.lastScanAt) > 0,
  skiCatalogRow?.lastScanAt ? new Date(skiCatalogRow.lastScanAt).toLocaleString("zh-CN") : "没给时间");
const absentCatalogRow = catalog.find((item) => item.packageName === PKG.therapy);
check("这台没报上来的应用，「哪几台」里不会把它算进去",
  absentCatalogRow?.installedOn?.some((row) => row.id === deviceId) === false,
  `${absentCatalogRow?.name}｜装着它的头显：${absentCatalogRow?.installedOn?.map((row) => row.name).join("、") || "无"}`);

const emptySync = await call("/devices/apps/sync", { method: "POST", deviceToken, body: { apps: [] } });
check("空清单被拒（HTTP 400）", emptySync.status === 400, emptySync.json?.error ?? "");

const afterSync = await must("/manifest", { deviceToken });
const installedRows = afterSync.apps.filter((item) => item.installState === "installed").length;
const missingRows = afterSync.apps.filter((item) => item.installState === "missing").length;
check("已装/缺失统计跟清单里的行对得上",
  sync1.installedCount === installedRows && sync1.missingCount === missingRows,
  `报的 已装 ${sync1.installedCount}／缺失 ${sync1.missingCount}｜清单里 installed ${installedRows} 行／missing ${missingRows} 行`);
check("清单里每个应用都被明确了装没装",
  afterSync.apps.every((item) => item.installState === "installed" || item.installState === "missing"),
  afterSync.apps.map((item) => `${item.key}=${item.installState}`).join(" "));
check("扫到的应用标成已安装", found(afterSync.apps, PKG.ski)?.installState === "installed");
check("清单内没扫到的标成未安装", found(afterSync.apps, PKG.therapy)?.installState === "missing", "心理拓展这次没报上来");
check("新应用先不上架等老师确认", found(afterSync.apps, PKG.unlisted)?.allowed === false, found(afterSync.apps, PKG.unlisted)?.reason ?? "");

// ---------- 4. 卸载检测 ----------
step("应用被卸载");
const sync2 = await must("/devices/apps/sync", {
  method: "POST",
  deviceToken,
  body: { apps: scanAll.filter((item) => item.packageName !== PKG.shooting) },
});
check("少报的应用记成已卸载", sync2.uninstalled >= 1, `uninstalled=${sync2.uninstalled}`);
const afterUnload = await must("/manifest", { deviceToken });
check("卸载后头显上显示「这台头显没装」", found(afterUnload.apps, PKG.shooting)?.installState === "missing",
  `射击打靶 installState=${found(afterUnload.apps, PKG.shooting)?.installState}`);

// ---------- 5. 老师逐台管控 ----------
step("老师逐台管控");
const inventory = await must(`/devices/${deviceId}/apps`, { token: teacher });
check("后台能看到这台的本机应用", inventory.items.length > 0, `清单内 ${inventory.items.length} 个｜已装 ${inventory.installedCount} 个`);
check("清单外应用单独列出", Array.isArray(inventory.unmanaged), `unmanaged=${inventory.unmanaged.length} 个`);
const skiRow = found(inventory.items, PKG.ski);
check("每行带安装状态与专属策略", skiRow && "installState" in skiRow && "deviceAllowed" in skiRow);

const skiId = skiRow.id;
await must("/policies", { method: "PUT", token: teacher, body: { scope: "device", scopeId: deviceId, appId: skiId, allowed: false } });
const banned = await must("/manifest", { deviceToken });
const bannedSki = found(banned.apps, PKG.ski);
check("这台禁止后清单里变灰", bannedSki.allowed === false, bannedSki.reason);
check("原因写明是这台头显的专属策略", bannedSki.reason.includes("该头显"), bannedSki.reason);

await must("/policies", {
  method: "PUT",
  token: teacher,
  body: { scope: "device", scopeId: deviceId, appId: skiId, allowed: true, dailyMinutes: 0 },
});
const limited = found((await must("/manifest", { deviceToken })).apps, PKG.ski);
check("每日上限 0 分钟直接拦下", limited.allowed === false && limited.reason.includes("分钟已用完"), limited.reason);

await must("/policies", {
  method: "PUT",
  token: teacher,
  body: { scope: "device", scopeId: deviceId, appId: skiId, allowed: true, dailyMinutes: 20 },
});
const reopened = found((await must("/manifest", { deviceToken })).apps, PKG.ski);
check("改回允许后又能跑", reopened.allowed === true, `每日上限 ${reopened.dailyMinutes} 分钟｜剩余 ${reopened.remainingMinutes} 分钟`);

// ---------- 6. 移出清单 / 重新纳入 ----------
step("移出清单");
await must(`/apps/${skiId}`, { method: "PATCH", token: teacher, body: { managed: false } });
const unmanaged = await must("/manifest", { deviceToken });
check("移出清单后不再下发给头显", found(unmanaged.apps, PKG.ski) === null);
await must(`/apps/${skiId}`, { method: "PATCH", token: teacher, body: { managed: true } });
const rehomed = found((await must("/manifest", { deviceToken })).apps, PKG.ski);
check("重新纳入后又回来了", rehomed !== null);

// ---------- 6.5 允许时段（不能看时钟的脸色）----------
step("允许时段：跟现在是几点无关");
const therapyId = (await must("/apps", { token: teacher })).apps.find((item) => item.packageName === PKG.therapy).id;
const pad2 = (n) => String(((n % 24) + 24) % 24).padStart(2, "0");
// 「必定含现在」和「必定不含现在」的窗口都得算：写死 14:00-18:00 的话，
// 这条断言就变成在测「现在是下午几点」，早上和晚上跑必挂一条。
const clock = new Date();
const hour = clock.getHours();
const nowHHMM = `${pad2(hour)}:${String(clock.getMinutes()).padStart(2, "0")}`;
// 挑不跨午夜的一侧：午夜前取「现在之后两小时」，午夜后取「现在之前三小时」
const outOfWindow = hour >= 20
  ? { start: `${pad2(hour - 3)}:00`, end: `${pad2(hour - 2)}:00` }
  : { start: `${pad2(hour + 2)}:00`, end: `${pad2(hour + 3)}:00` };

await must("/policies", {
  method: "PUT",
  token: teacher,
  body: { scope: "global", scopeId: 0, appId: therapyId, allowed: true, windowStart: "00:00", windowEnd: "23:59" },
});
const insideWindow = found((await must("/manifest", { deviceToken })).apps, PKG.therapy);
check("时段覆盖全天时不拦", insideWindow?.allowed === true,
  `${insideWindow?.name}｜窗口 ${insideWindow?.window}｜现在 ${nowHHMM}｜原因=${insideWindow?.reason ?? "无"}`);

await must("/policies", {
  method: "PUT",
  token: teacher,
  body: { scope: "global", scopeId: 0, appId: therapyId, allowed: true, windowStart: outOfWindow.start, windowEnd: outOfWindow.end },
});
const outsideWindow = found((await must("/manifest", { deviceToken })).apps, PKG.therapy);
check("时段不含当前时刻时拦下，并把时段说清楚",
  outsideWindow?.allowed === false && String(outsideWindow?.reason).includes("不在允许时段")
    && String(outsideWindow?.reason).includes(`${outOfWindow.start}-${outOfWindow.end}`),
  `${outsideWindow?.name}｜窗口 ${outOfWindow.start}-${outOfWindow.end}｜现在 ${nowHHMM}｜原因=${outsideWindow?.reason}`);

await must("/policies", {
  method: "PUT",
  token: teacher,
  body: { scope: "global", scopeId: 0, appId: therapyId, allowed: null, dailyMinutes: null, windowStart: null, windowEnd: null },
});
const afterWindowGone = found((await must("/manifest", { deviceToken })).apps, PKG.therapy);
check("时段撤掉后立刻恢复可跑", afterWindowGone?.allowed === true, `原因=${afterWindowGone?.reason ?? "无"}`);
const policiesNow = (await must("/policies", { token: teacher })).policies;
check("「跟随默认 + 不限时长 + 不限时段」等于把这条专属策略删掉，不留一条全空的记录",
  !policiesNow.some((item) => item.appId === therapyId && item.scope === "global"),
  `全校级策略共 ${policiesNow.filter((item) => item.scope === "global").length} 条，没有一条是空壳`);

// ---------- 7. 管控模式 ----------
step("白名单 / 自由运行");
await must(`/devices/${deviceId}`, { method: "PATCH", token: teacher, body: { appMode: "open" } });
check("切成自由运行", (await must("/manifest", { deviceToken })).mode === "open");
await must(`/devices/${deviceId}`, { method: "PATCH", token: teacher, body: { appMode: "allowlist" } });
check("切回白名单", (await must("/manifest", { deviceToken })).mode === "allowlist");

// ---------- 8. 越权记录 ----------
step("越权拦截留痕");
await must("/devices/violation", {
  method: "POST",
  deviceToken,
  body: { packageName: PKG.unlisted, label: "偷偷装的游戏", action: "blocked" },
});
const violations = await must("/violations?limit=20", { token: teacher });
const mine = violations.violations.filter((item) => item.deviceId === deviceId);
check("越权记录进了后台", mine.length >= 1, `${mine[0]?.label}｜${mine[0]?.packageName}`);
check("记录带上设备和学生", Boolean(mine[0]?.device), `${mine[0]?.device}／${mine[0]?.student ?? "未绑定"}`);
const deviceView = await must(`/devices/${deviceId}/apps`, { token: teacher });
check("设备详情页也看得到越权", deviceView.violations.length >= 1);

// ---------- 9. 指令下发 ----------
step("下发指令");
await must(`/devices/${deviceId}/command`, { method: "POST", token: teacher, body: { type: "scan" } });
const withCommand = await must("/manifest", { deviceToken });
const scanCommand = withCommand.pendingCommands.find((item) => item.type === "scan");
check("重新扫描指令到达", Boolean(scanCommand), scanCommand ? `指令 #${scanCommand.id}` : "");
// 这一段以前整个包在 if 里：指令没到就静默跳过，断言条数悄悄变少，看着还是全绿
if (scanCommand) {
  await must("/commands/ack", { method: "POST", deviceToken, body: { ids: [scanCommand.id] } });
}
const acked = await must("/manifest", { deviceToken });
check("确认之后队列里不该再躺着扫描指令", !acked.pendingCommands.some((item) => item.type === "scan"),
  scanCommand ? `已确认指令 #${scanCommand.id}` : `这台压根没拿到指令（队列里还剩 ${acked.pendingCommands.length} 条）`);
const badCommand = await call(`/devices/${deviceId}/command`, { method: "POST", token: teacher, body: { type: "重启一下" } });
check("不认识的指令被拒（HTTP 400）", badCommand.status === 400, badCommand.json?.error ?? "");
// 老师「带句话」：话必须原样到端上。原来端上 case "message" 是空的，payload 连模型都没有，
// 指令被 ack 掉、学生啥也没看见 —— 这里把 payload.text 钉死在接口上
await must(`/devices/${deviceId}/command`, { method: "POST", token: teacher, body: { type: "message", text: "下课前三分钟收尾" } });
const sayCommand = (await must("/manifest", { deviceToken })).pendingCommands.find((item) => item.type === "message");
check("带句话的指令带着原文到达头显", sayCommand?.payload?.text === "下课前三分钟收尾",
  sayCommand ? `端上收到「${sayCommand.payload?.text ?? "（没有 payload）"}」` : "队列里没有 message 指令");
if (sayCommand) {
  await must("/commands/ack", { method: "POST", deviceToken, body: { ids: [sayCommand.id] } });
}
check("带过的话确认完就从队列清掉，不会反复弹",
  !(await must("/manifest", { deviceToken })).pendingCommands.some((item) => item.type === "message"));

// ---------- 10. 心跳与打开次数 ----------
step("心跳统计打开次数");
// 先把前台切到别的应用，再连报两次同一个包名：只有第一次算「打开了一次」
await must("/devices/heartbeat", { method: "POST", deviceToken, body: { battery: 66, foregroundApp: PKG.system, wifi: "edu-lab" } });
const before = await must(`/devices/${deviceId}/apps`, { token: teacher });
const beforeCount = found(before.items, PKG.ski)?.launchCount ?? 0;
await must("/devices/heartbeat", { method: "POST", deviceToken, body: { battery: 66, foregroundApp: PKG.ski, wifi: "edu-lab" } });
await must("/devices/heartbeat", { method: "POST", deviceToken, body: { battery: 66, foregroundApp: PKG.ski, wifi: "edu-lab" } });
const after = await must(`/devices/${deviceId}/apps`, { token: teacher });
const afterCount = found(after.items, PKG.ski)?.launchCount ?? 0;
check("前台包名变了才算打开一次", afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}（同一包名连报两次只算一次）`);
const deviceRow = (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId);
check("心跳里的电量落到设备上", deviceRow?.battery === 66, `${deviceRow?.name}｜电量 ${deviceRow?.battery}`);

const online = await must("/dashboard", { token: teacher });
check("这台被算成在线", online.totals.onlineDevices >= 1, `在线 ${online.totals.onlineDevices} 台`);
const catalogNow = (await must("/apps", { token: teacher })).apps;
check("总览的应用数跟目录对得上", online.totals.apps === catalogNow.length && online.totals.enabledApps <= catalogNow.length,
  `总览 ${online.totals.apps} 个（上架 ${online.totals.enabledApps}）｜目录 ${catalogNow.length} 个`);
check("刚才那次越权算进了「今日越权」", online.totals.violationsToday >= 1, `今日越权 ${online.totals.violationsToday} 次`);

// ---------- 11. 时长上报与幂等 ----------
step("时长上报");
const startedAt = Date.now() - 120_000;
const batchId = `selftest-${Date.now()}`;
const events = [{ appKey: found(after.items, PKG.ski).key, packageName: PKG.ski, startedAt, endedAt: startedAt + 90_000, seconds: 90 }];
const firstReport = await must("/usage/batch", { method: "POST", deviceToken, body: { batchId, events } });
check("时长收下", firstReport.accepted === 1, `accepted=${firstReport.accepted}`);
const againReport = await must("/usage/batch", { method: "POST", deviceToken, body: { batchId, events } });
check("同一批重发不重复计", againReport.accepted === 0 && againReport.duplicates === 1, `accepted=${againReport.accepted}｜duplicates=${againReport.duplicates}`);

const report = await must("/reports/usage?groupBy=device", { token: teacher });
const row = (report.rows ?? []).find((item) => item.label === "自检专用头显（可忽略）");
check("报表里查得到这台", Boolean(row) && row.seconds >= 90, row ? `${row.label}｜${row.seconds} 秒｜${row.sessions} 次` : "报表没有这台");

// ---------- 12. 老师端手工增删（头显 / 本机应用 / 学生 / 应用）----------
step("老师端手工增删");
// 上一次中途跑挂可能留下自检头显，先扫干净（自检专用那台要留着）
const strays = (await must("/devices", { token: teacher }))
  .devices.filter((item) => /^PICO-TEST-/.test(String(item.serial ?? "")) && item.serial !== serial);
for (const stray of strays) {
  await call(`/devices/${stray.id}`, { method: "DELETE", token: teacher });
}
if (strays.length) {
  console.log(`  ↺ 扫掉上次残留的 ${strays.length} 台自检头显：${strays.map((item) => item.serial).join("、")}`);
}

const noSerial = await call("/devices", { method: "POST", token: teacher, body: { name: "忘了填序列号" } });
check("手工登记头显缺序列号被拒（HTTP 400）", noSerial.status === 400, noSerial.json?.error ?? "");

const manual = await must("/devices", {
  method: "POST",
  token: teacher,
  body: { serial: "PICO-TEST-MANUAL", name: "自检手工登记的头显（可忽略）", model: "PICO 4 Ultra" },
});
const manualId = manual.id;
check("手工登记一台还没开机配对过的头显", Boolean(manualId) && Boolean(manual.pairingCode), `设备 #${manualId} 配对码 ${manual.pairingCode}`);

const dupSerial = await call("/devices", { method: "POST", token: teacher, body: { serial: "PICO-TEST-MANUAL" } });
check("序列号重复被拒（HTTP 400）", dupSerial.status === 400, dupSerial.json?.error ?? "");

const looseDevice = await must("/devices", { method: "POST", token: teacher, body: { serial: "PICO-TEST-NOSTUDENT", studentId: 999999 } });
check("登记头显时不再绑学生（设备和学生各自独立）", looseDevice.id > 0, `设备 #${looseDevice.id} 建好，没绑任何人`);
await call(`/devices/${looseDevice.id}`, { method: "DELETE", token: teacher });

const tempStudent = await must("/students", { method: "POST", token: teacher, body: { name: "自检临时生（可忽略）", studentNo: "PICO-TEST-NO" } });
const tempStudentId = tempStudent.id;
check("新建一个临时学生", Boolean(tempStudentId), `学生 #${tempStudentId}`);

const bindDevice = await must("/devices", {
  method: "POST",
  token: teacher,
  body: { serial: "PICO-TEST-BOUND", studentId: tempStudentId },
});
const boundNow = (await must("/students", { token: teacher })).students.find((item) => item.id === tempStudentId);
check("登记时传了学生也不绑（谁用哪台改到「上课」页当堂定）", !boundNow?.device, `${boundNow?.name} 现在没头显`);

const badPkg = await call(`/devices/${manualId}/apps`, { method: "POST", token: teacher, body: { packageName: "没有点号" } });
check("手工登记本机应用包名不合法被拒（HTTP 400）", badPkg.status === 400, badPkg.json?.error ?? "");

await must(`/devices/${manualId}/apps`, {
  method: "POST",
  token: teacher,
  body: { packageName: PKG.unlisted, label: "自检手工加的应用", version: "9.9.9", isVr: true },
});
const manualInventory = await must(`/devices/${manualId}/apps`, { token: teacher });
const manualRow = found(manualInventory.unmanaged, PKG.unlisted) ?? found(manualInventory.items, PKG.unlisted);
check("手工登记的本机应用出现在这台清单里", Boolean(manualRow), manualRow ? `${manualRow.name}｜${manualRow.packageName}` : "没找到");

check("删掉这台上的本机应用记录", (await call(`/devices/${manualId}/apps/${encodeURIComponent(PKG.unlisted)}`, { method: "DELETE", token: teacher })).status === 200);
const deleteAgain = await call(`/devices/${manualId}/apps/${encodeURIComponent(PKG.unlisted)}`, { method: "DELETE", token: teacher });
check("重复删除本机应用记录被拒（HTTP 404）", deleteAgain.status === 404, deleteAgain.json?.error ?? "");
check("没扫描记录可删时说清该用「从清单删除」", deleteAgain.status === 404
  && String(deleteAgain.json?.error).includes("从清单删除"), deleteAgain.json?.error ?? "");

const devicesBefore = (await must("/devices", { token: teacher })).devices.length;
check("删除头显", (await call(`/devices/${bindDevice.id}`, { method: "DELETE", token: teacher })).status === 200);
check("删除后设备表少一台", (await must("/devices", { token: teacher })).devices.length === devicesBefore - 1, `${devicesBefore} → ${devicesBefore - 1}`);

const boundStudentAfter = (await must("/students", { token: teacher })).students.find((item) => item.id === tempStudentId);
check("删头显后绑着的学生回到「未绑定」", !boundStudentAfter?.device, `${boundStudentAfter?.name} 现在没设备`);

const deleteMissingDevice = await call(`/devices/${bindDevice.id}`, { method: "DELETE", token: teacher });
check("删除不存在的头显被拒（HTTP 404）", deleteMissingDevice.status === 404, deleteMissingDevice.json?.error ?? "");

await call(`/devices/${manualId}`, { method: "DELETE", token: teacher });
const leaked = (await must("/devices", { token: teacher }))
  .devices.filter((item) => /PICO-TEST-(MANUAL|BOUND|NOSTUDENT|LESSON)/.test(String(item.serial ?? "")));
check("删除时不留孤儿设备记录", leaked.length === 0, leaked.length ? `还留着 ${leaked.map((item) => item.serial).join(",")}` : "两台自检机都已删干净");

check("删除学生", (await call(`/students/${tempStudentId}`, { method: "DELETE", token: teacher })).status === 200);
check("删掉的学生不在列表里", !(await must("/students", { token: teacher })).students.some((item) => item.id === tempStudentId));
// 先删完再查报表：以前是先查后删，那条「删学生不影响报表」压根没测到删除之后的事
const reportAfterStudentDelete = await call("/reports/usage?groupBy=device", { token: teacher });
check("删掉学生之后报表接口照常", reportAfterStudentDelete.status === 200, `HTTP ${reportAfterStudentDelete.status}`);
const deleteStudentAgain = await call(`/students/${tempStudentId}`, { method: "DELETE", token: teacher });
check("重复删除学生被拒（HTTP 404）", deleteStudentAgain.status === 404, deleteStudentAgain.json?.error ?? "");

// ---------- 学生管理与班级 ----------
// 学生录错名 / 学号写错 / 学期中途转班 / 机房一节课几十号人一次性导入：
// 这几件事以前后台压根做不了，只能删了重录，而一删就把这个学生的时长记录断成两段
step("改学生、管班级、批量导入");
const clsA = await must("/classes", { method: "POST", token: teacher, body: { name: "自检一班（可删）", grade: "初三" } });
check("新建班级", clsA.id > 0, `班级 #${clsA.id}`);
const dupClass = await call("/classes", { method: "POST", token: teacher, body: { name: "自检一班（可删）" } });
check("同名班级被拒（HTTP 400）", dupClass.status === 400, dupClass.json?.error ?? "");

const bulk = await must("/students/bulk", {
  method: "POST",
  token: teacher,
  body: {
    text: "9001 自检甲 自检一班（可删）\n自检乙 9002\n9003 自检丙 自检二班（可删）\n9001 自检丁\n只有名字\n",
  },
});
check("批量导入认得「学号 姓名」和「姓名 学号」两种写法", bulk.created.length === 3,
  `导入 ${bulk.created.length} 人：${bulk.created.map((item) => `${item.name}/${item.studentNo}`).join("、")}`);
check("第三段班级名没有的班当场建一个", bulk.newClasses.join("") === "自检二班（可删）", `新建：${bulk.newClasses.join("、") || "无"}`);
check("学号撞了的那行跳过并说明原因", bulk.skipped.some((item) => item.reason.includes("已经在名单里")),
  bulk.skipped.map((item) => item.reason).join("｜"));
check("只写了一段的那行跳过并给出写法", bulk.skipped.some((item) => item.reason.includes("写成")),
  bulk.skipped.map((item) => item.reason).join("｜"));
const emptyBulk = await call("/students/bulk", { method: "POST", token: teacher, body: { text: "   " } });
check("贴个空名单进来被拒（HTTP 400）", emptyBulk.status === 400, emptyBulk.json?.error ?? "");

const rosterAll = (await must("/students", { token: teacher })).students;
const jia = rosterAll.find((item) => item.studentNo === "9001");
const yi = rosterAll.find((item) => item.studentNo === "9002");
check("写了班级的那行分到对应的班", jia?.class?.name === "自检一班（可删）", `${jia?.name} → ${jia?.class?.name ?? "未分班"}`);
check("没写班级的那行留在未分班", !yi?.class, `${yi?.name} → ${yi?.class?.name ?? "未分班"}`);

const moved = await must(`/students/${yi.id}`, { method: "PATCH", token: teacher, body: { classId: clsA.id } });
check("学生能改班级了（原来只能删了重录）", Boolean(moved.changes?.length), moved.changes?.join("；") ?? "");
check("改完名单里他就是这个班的",
  (await must("/students", { token: teacher })).students.find((item) => item.id === yi.id)?.class?.name === "自检一班（可删）");
const badClass = await call(`/students/${yi.id}`, { method: "PATCH", token: teacher, body: { classId: 999999 } });
check("改到一个不存在的班级被拒（HTTP 400）", badClass.status === 400, badClass.json?.error ?? "");
const dupNo = await call(`/students/${yi.id}`, { method: "PATCH", token: teacher, body: { studentNo: "9001" } });
check("学号撞了别人被拒、并说是谁的（HTTP 400）",
  dupNo.status === 400 && String(dupNo.json?.error).includes("自检甲"), dupNo.json?.error ?? "");
check("学号能改（录错了不用删了重录）", (await must(`/students/${yi.id}`, { method: "PATCH", token: teacher, body: { studentNo: "9002B" } })).ok === true);
const audited = (await must("/audit", { token: teacher })).logs.filter((item) => String(item.detail).includes("9002B"));
check("改学号这件事进了操作日志", audited.length > 0, audited[0]?.detail ?? "日志里找不到 9002B");

await must(`/classes/${clsA.id}`, { method: "PATCH", token: teacher, body: { name: "自检一班改名（可删）" } });
check("班级改名后学生那侧跟着变",
  (await must("/students", { token: teacher })).students.find((item) => item.studentNo === "9002B")?.class?.name === "自检一班改名（可删）");
const dupRename = await call(`/classes/${clsA.id}`, { method: "PATCH", token: teacher, body: { name: "初三(2)班" } });
check("班级改成和别的班同名被拒（HTTP 400）", dupRename.status === 400, dupRename.json?.error ?? "");

const classPolicyApp = (await must("/apps", { token: teacher })).apps.find((item) => item.packageName === PKG.ski);
await must("/policies", { method: "PUT", token: teacher, body: { appId: classPolicyApp.id, scope: "class", scopeId: clsA.id, allowed: false } });
const denyDrop = await call(`/classes/${clsA.id}`, { method: "DELETE", token: teacher, body: {} });
check("班里还有人时删班先报人数（HTTP 400）",
  denyDrop.status === 400 && String(denyDrop.json?.error).includes("个学生"), denyDrop.json?.error ?? "");
const classDropped = await must(`/classes/${clsA.id}`, { method: "DELETE", token: teacher, body: { moveStudents: true } });
check("确认后删班，学生落到未分班、记录不丢",
  !(await must("/students", { token: teacher })).students.find((item) => item.studentNo === "9002B")?.class,
  classDropped.notice ?? "");
check("删班时这个班的策略一起清掉，不留孤儿",
  (await must("/policies", { token: teacher })).policies.filter((item) => item.scope === "class" && item.scopeId === clsA.id).length === 0);

for (const no of ["9001", "9002B", "9003"]) {
  const row = (await must("/students", { token: teacher })).students.find((item) => item.studentNo === no);
  if (row) {
    await call(`/students/${row.id}`, { method: "DELETE", token: teacher });
  }
}
const strayClass = (await must("/classes", { token: teacher })).classes.find((item) => String(item.name).startsWith("自检二班"));
if (strayClass) {
  await call(`/classes/${strayClass.id}`, { method: "DELETE", token: teacher, body: { moveStudents: true } });
}
const leftoverStudents = (await must("/students", { token: teacher })).students.filter((item) => /^900\d/.test(item.studentNo));
check("自检建的学生和班级都清干净，不脏下一次的表", leftoverStudents.length === 0,
  leftoverStudents.length ? `还剩 ${leftoverStudents.map((item) => item.studentNo).join("、")}` : "一个不剩");

const tempApp = await must("/apps", {
  method: "POST",
  token: teacher,
  body: { key: "selftest-delapp", name: "自检临时应用（可忽略）", packageName: "com.selftest.deleteapp", category: "自检" },
});
check("新建一个临时应用", Boolean(tempApp.id), `应用 #${tempApp.id}`);
check("删除应用", (await call(`/apps/${tempApp.id}`, { method: "DELETE", token: teacher })).status === 200);
check("删掉的应不在清单里", !(await must("/apps", { token: teacher })).apps.some((item) => item.id === tempApp.id));
const deleteAppAgain = await call(`/apps/${tempApp.id}`, { method: "DELETE", token: teacher });
check("重复删除应用被拒（HTTP 404）", deleteAppAgain.status === 404, deleteAppAgain.json?.error ?? "");

const badScope = await call("/admin/reset", { method: "POST", token: teacher, body: { scope: "随便写的范围" } });
check("清空范围写错被拒（HTTP 400）", badScope.status === 400, badScope.json?.error ?? "");

// ---------- 12.5 上课（课堂）----------
step("上课：开课 → 指定使用者 → 限定应用 → 画面回传 → 记录归属");
const { mockScreenFrame } = await import("./png-frame.mjs");

const rawPost = async (path, bytes, token) => {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "image/png", ...(token ? { "X-Device-Token": token } : {}) },
    body: bytes,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
};

const pullFrame = async (id, token) => {
  const response = await fetch(`${base}/api/v1/devices/${id}/screen`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, type: response.headers.get("content-type") ?? "", buffer: Buffer.from(await response.arrayBuffer()) };
};

// 上一次跑挂了、或者后台里还压着一节没下课的，都先收掉，保证能一遍跑通
const leftovers = (await must("/lessons?limit=50", { token: teacher })).lessons.filter((item) => item.status === "active");
for (const leftover of leftovers) {
  await call(`/lessons/${leftover.id}/end`, { method: "POST", token: teacher });
}
if (leftovers.length) {
  console.log(`  ↺ 先替老师下课 ${leftovers.length} 节：${leftovers.map((item) => item.title).join("、")}`);
}

const emptyLesson = await call("/lessons", { method: "POST", token: teacher, body: { title: "自检课（可忽略）", deviceIds: [] } });
check("一台头显都不选就没法开课（HTTP 400）", emptyLesson.status === 400, emptyLesson.json?.error ?? "");

const lesson = await must("/lessons", {
  method: "POST",
  token: teacher,
  body: { title: "自检课（可忽略）", classId: null, note: "自检自动开的", deviceIds: [deviceId], appKeys: ["ski", "shooting"] },
});
check("开课成功", Boolean(lesson.id) && lesson.status === "active", `课 #${lesson.id}《${lesson.title}》`);

const doubleStart = await call("/lessons", { method: "POST", token: teacher, body: { title: "第二节自检课", deviceIds: [deviceId] } });
check("同一时间只能有一节正在上的课（HTTP 400）", doubleStart.status === 400 && String(doubleStart.json?.error).includes("还没下课"), doubleStart.json?.error ?? "");
check("/lessons/active 查得到正在上的这节课", (await must("/lessons/active", { token: teacher })).lesson?.id === lesson.id, `课 #${lesson.id}`);

const roster = (await must("/students", { token: teacher })).students.filter((item) => item.status === "active");
const seatStudent = roster[0];
const spareStudent = roster[1];
check("有可用学生做当堂分配", Boolean(seatStudent && spareStudent), `${seatStudent?.name}／${spareStudent?.name}`);
check("当堂指定使用者", (await call(`/lessons/${lesson.id}/assign`, { method: "POST", token: teacher, body: { deviceId, studentId: seatStudent.id } })).status === 200,
  `${seatStudent.name} → 自检专用头显`);

const lessonManifest = await must("/manifest", { deviceToken });
check("头显收到的清单里带课堂状态", lessonManifest.lesson?.active === true, lessonManifest.lesson?.title ?? "");
check("头显知道这节课是谁在用", lessonManifest.lesson?.student?.name === seatStudent.name, `${lessonManifest.lesson?.student?.name ?? "没人"}`);
check("清单里下发了画面回传要求", lessonManifest.lesson?.screen?.enabled === true && lessonManifest.lesson?.screen?.intervalMs > 0,
  `每 ${lessonManifest.lesson?.screen?.intervalMs} 毫秒一帧`);
const offLesson = found(lessonManifest.apps, PKG.therapy);
check("这节课没安排的应用在头显上变灰", offLesson?.allowed === false && String(offLesson?.reason).includes("这节课没安排"), offLesson?.reason ?? "");
const onLesson = found(lessonManifest.apps, PKG.ski);
check("这节课安排了的不会被课堂规则挡", onLesson?.inLesson === true && !String(onLesson?.reason).includes("这节课没安排"),
  `${onLesson?.name}｜在课上=${onLesson?.inLesson}｜${onLesson?.reason || "没被挡"}${onLesson?.allowed ? "" : "（今日时长另有上限）"}`);

const uploaded = await rawPost("/devices/screen", mockScreenFrame({ foreground: PKG.ski, progress: 0.4 }), deviceToken);
check("头显上传一帧画面", uploaded.status === 200 && uploaded.json?.ok === true, `${uploaded.json?.bytes ?? 0} 字节`);
const pulled = await pullFrame(deviceId, teacher);
check("老师在网页上取到这一帧", pulled.status === 200 && pulled.buffer.length > 100, `${pulled.type}｜${pulled.buffer.length} 字节`);
check("没登录取画面被拒（HTTP 401）", (await pullFrame(deviceId, null)).status === 401, "");
check("画面上传也算一次心跳", (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId)?.online === true, "在线");

const wrongApp = await call(`/lessons/${lesson.id}/apps`, { method: "POST", token: teacher, body: { appKeys: ["后台清单里根本没这个 key"] } });
check("课堂清单里塞后台没有的应用被拒（HTTP 400）", wrongApp.status === 400, wrongApp.json?.error ?? "");

const spareDevice = await must("/devices", { method: "POST", token: teacher, body: { name: "自检备用头显（可忽略）", serial: "PICO-TEST-LESSON" } });
check("再拉一台头显进这节课", (await call(`/lessons/${lesson.id}/devices`, { method: "POST", token: teacher, body: { deviceId: spareDevice.id } })).status === 200,
  `#${spareDevice.id}｜这节课共 ${spareDevice.id > 0 ? 2 : 1} 台`);
const twice = await call(`/lessons/${lesson.id}/assign`, { method: "POST", token: teacher, body: { deviceId: spareDevice.id, studentId: seatStudent.id } });
check("一个学生同一节课只能占一台头显（HTTP 400）", twice.status === 400 && String(twice.json?.error).includes("已经在用"), twice.json?.error ?? "");
check("换个学生就能坐第二台", (await call(`/lessons/${lesson.id}/assign`, { method: "POST", token: teacher, body: { deviceId: spareDevice.id, studentId: spareStudent.id } })).status === 200,
  `${spareStudent.name} → 自检备用头显`);
check("往课上塞不在课上的头显被拒（HTTP 400）", (await call(`/lessons/${lesson.id}/assign`, { method: "POST", token: teacher, body: { deviceId: 999999, studentId: seatStudent.id } })).status === 400, "");

// 单台可以比整节课更严；清空单台是「跟随整节课」，不是「这台不限」
check("单独给某台再收窄清单", (await call(`/lessons/${lesson.id}/apps`, { method: "POST", token: teacher, body: { appKeys: ["ski"], deviceId } })).status === 200, "这台只留雪山滑雪");
const narrowed = found((await must("/manifest", { deviceToken })).apps, PKG.shooting);
check("被单台收窄掉的应用在这台上变灰", narrowed?.allowed === false && String(narrowed?.reason).includes("这节课没安排"), narrowed?.reason ?? "");
check("把单台的收窄清空＝恢复跟随整节课", (await call(`/lessons/${lesson.id}/apps`, { method: "POST", token: teacher, body: { appKeys: [], deviceId } })).status === 200, "");
const followed = found((await must("/manifest", { deviceToken })).apps, PKG.shooting);
const stillGated = found((await must("/manifest", { deviceToken })).apps, PKG.therapy);
check("跟随整节课而不是变成不限", followed?.allowed === true && stillGated?.allowed === false,
  `射击打靶=${followed?.allowed}｜心理拓展=${stillGated?.allowed}（整节课只安排了滑雪和打靶）`);
check("正在上课的学生不能被删（HTTP 400）", (await call(`/students/${seatStudent.id}`, { method: "DELETE", token: teacher })).status === 400, "");
const bindAgain = await call(`/devices/${deviceId}`, { method: "PATCH", token: teacher, body: { studentId: seatStudent.id } });
check("设备页不再直接绑学生，让去「上课」页（HTTP 400）", bindAgain.status === 400 && String(bindAgain.json?.error).includes("上课"), bindAgain.json?.error ?? "");
// 日志里得写头显的名字。以前查 lesson_devices 却去读 row.name（这张表没这一列），
// 日志永远是「改用 头显 #7」，老师翻日志根本对不出是哪一台
const seatDeviceName = (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId)?.name ?? "";
const assignLog = (await must("/audit", { token: teacher })).logs.find(
  (item) => item.action === "lesson.assign" && String(item.target).includes(`device:${deviceId}`),
);
check("点名日志写的是头显名字，不是「头显 #编号」",
  Boolean(assignLog) && assignLog.detail.includes(seatDeviceName) && !assignLog.detail.includes("头显 #"),
  assignLog?.detail ?? "没找到这条日志");
// 停用中的学生被点到某台上：能点，但后台必须当场说清这台会被锁住（判断在后台，不靠网页下拉框标小字）
await must(`/students/${seatStudent.id}`, { method: "PATCH", token: teacher, body: { status: "suspended" } });
const suspendedAssign = await must(`/lessons/${lesson.id}/assign`, { method: "POST", token: teacher, body: { deviceId, studentId: seatStudent.id } });
check("给「暂停使用」的学生分头显能成，但后台带回一句警告", Boolean(suspendedAssign.warning?.includes("暂停使用")),
  suspendedAssign.warning ?? "没给警告");
const lockedManifest = await must("/manifest", { deviceToken });
check("警告不是吓人的：这台在清单里真被锁住、还写了原因",
  lockedManifest.locked?.locked === true && String(lockedManifest.locked?.reason).includes("暂停使用"),
  lockedManifest.locked?.reason ?? "没锁");
await must(`/students/${seatStudent.id}`, { method: "PATCH", token: teacher, body: { status: "active" } });
check("把学生恢复使用，这台的锁跟着解开", (await must("/manifest", { deviceToken })).locked?.locked === false, "");

const lessonBatch = `selftest-lesson-${Date.now()}`;
const lessonEvents = [{ appKey: onLesson.key, packageName: PKG.ski, startedAt: Date.now() - 90_000, endedAt: Date.now(), seconds: 60 }];
const lessonUsage = await must("/usage/batch", { method: "POST", deviceToken, body: { batchId: lessonBatch, events: lessonEvents } });
check("上课期间的时长能入库", lessonUsage.accepted === 1, `accepted=${lessonUsage.accepted}`);

const lessonDetail = (await must(`/lessons/${lesson.id}`, { token: teacher })).lesson;
const seatRow = (lessonDetail.devices ?? []).find((item) => item.deviceId === deviceId);
check("课堂详情里这台头显挂着当堂指定的学生", seatRow?.student?.name === seatStudent.name, `${seatRow?.student?.name ?? "没人"}`);
check("课堂详情带这台最新一帧画面的时间", Boolean(seatRow?.screen?.ts), seatRow?.screen ? `${seatRow.screen.width}x${seatRow.screen.height}｜${seatRow.screen.bytes} 字节` : "没画面");
const mineOnLesson = (lessonDetail.summary ?? []).filter((item) => item.studentId === seatStudent.id);
check("这节课的时长算到了学生头上", mineOnLesson.reduce((sum, item) => sum + item.seconds, 0) >= 60,
  mineOnLesson.map((item) => `${item.app} ${item.seconds} 秒`).join("／"));
// 学生名单上只有「今日／累计」两个数，老师真问的是「他跑了哪几个、各多久、在哪台、算哪节课」
const seatUsage = await must(`/students/${seatStudent.id}/usage?days=7`, { token: teacher });
check("单个学生的使用明细能拉出来",
  seatUsage.student?.id === seatStudent.id && Array.isArray(seatUsage.apps) && seatUsage.apps.length > 0,
  `${seatUsage.student?.name}｜近 ${seatUsage.days} 天 ${seatUsage.rangeSeconds} 秒｜${seatUsage.apps.length} 个应用`);
const usageSkiRow = seatUsage.apps.find((item) => item.name === "雪山滑雪");
check("明细里有应用、时长、次数、用过的头显数",
  Boolean(usageSkiRow) && usageSkiRow.seconds >= 60 && usageSkiRow.sessions >= 1 && usageSkiRow.devices >= 1,
  usageSkiRow ? `${usageSkiRow.name}｜${usageSkiRow.seconds} 秒｜${usageSkiRow.sessions} 次｜${usageSkiRow.devices} 台` : "没找到滑雪记录");
check("明细的逐条记录写清了算哪节课、哪台头显",
  seatUsage.sessions.some((item) => item.lesson === lesson.title && item.device === seatDeviceName),
  JSON.stringify(seatUsage.sessions[0] ?? {}));
check("明细的总数和逐条对得上", seatUsage.rangeSeconds === seatUsage.apps.reduce((sum, item) => sum + item.seconds, 0),
  `${seatUsage.rangeSeconds} 秒`);
const ghostUsage = await call(`/students/999999/usage`, { token: teacher });
check("查不存在的学生明细（HTTP 404）", ghostUsage.status === 404 && String(ghostUsage.json?.error).includes("学生不存在"),
  ghostUsage.json?.error ?? "");
check("没登录拉学生明细被拒（HTTP 401）", (await call(`/students/${seatStudent.id}/usage`)).status === 401, "");
check("总览把正在上的课列出来了", (await must("/dashboard", { token: teacher })).lessons?.some((item) => item.id === lesson.id) === true, "");

check("清空课堂清单＝恢复跟后台默认", (await call(`/lessons/${lesson.id}/apps`, { method: "POST", token: teacher, body: { appKeys: [] } })).status === 200, "");
const afterLessonCleared = found((await must("/manifest", { deviceToken })).apps, PKG.therapy);
check("恢复默认后刚才被挡的应用又能跑了", afterLessonCleared?.allowed === true,
  `${afterLessonCleared?.name}｜allowed=${afterLessonCleared?.allowed}｜原因=${afterLessonCleared?.reason ?? "无"}｜装=${afterLessonCleared?.installState}`);

check("下课", (await call(`/lessons/${lesson.id}/end`, { method: "POST", token: teacher })).status === 200, "");
check("下课后头显收到「没在上课」", (await must("/manifest", { deviceToken })).lesson?.active === false, "");
check("重复下课被拒（HTTP 400）", (await call(`/lessons/${lesson.id}/end`, { method: "POST", token: teacher })).status === 400, "");
check("下课撤回当堂分配", !(await must("/students", { token: teacher })).students.find((item) => item.id === seatStudent.id)?.device, `${seatStudent.name} 现在没头显`);
const endedLesson = (await must("/lessons?limit=50", { token: teacher })).lessons.find((item) => item.id === lesson.id);
check("下课记录永久保留", endedLesson?.status === "ended", `课 #${lesson.id}｜${endedLesson?.seconds ?? 0} 秒｜${endedLesson?.studentCount ?? 0} 个学生`);
// 下课之后再改这节课的应用清单，头显那边早就不看这节课了：默默存下来谁也不看见，不如当场说清去哪改
const appsAfterEnd = await call(`/lessons/${lesson.id}/apps`, { method: "POST", token: teacher, body: { appKeys: ["ski"] } });
check("下课后再改这节课的应用清单被拒并指路（HTTP 400）",
  appsAfterEnd.status === 400 && String(appsAfterEnd.json?.error).includes("头显应用"), appsAfterEnd.json?.error ?? "");
await call(`/devices/${spareDevice.id}`, { method: "DELETE", token: teacher });
check("清掉自检备用头显", !(await must("/devices", { token: teacher })).devices.some((item) => item.serial === "PICO-TEST-LESSON"), "");

// ---------- 11.4 老师改完，头显多久知道（清单版本号）----------
step("老师改动立刻能察觉");
const revManifest = await must("/manifest", { deviceToken });
const rev0 = Number(revManifest.rev);
check("清单带改动版本号", rev0 > 0, `rev=${rev0}`);
const revBeat0 = await must("/devices/heartbeat", { method: "POST", deviceToken, body: { foregroundApp: PKG.ski } });
check("心跳带同一个版本号，头显照着它决定要不要重拉清单", Number(revBeat0.rev) === rev0, `清单 ${rev0}｜心跳 ${revBeat0.rev}`);
const nameBefore = (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId)?.name ?? "";
await must(`/devices/${deviceId}`, { method: "PATCH", token: teacher, body: { name: `${nameBefore}·改过一次` } });
const revBeat1 = await must("/devices/heartbeat", { method: "POST", deviceToken, body: {} });
check("老师在网页上动一下手，版本号就变，头显下次心跳（10 秒）就察觉",
  Number(revBeat1.rev) > rev0, `${rev0} → ${revBeat1.rev}`);
await call(`/devices/${deviceId}`, { method: "PATCH", token: teacher, body: { name: nameBefore } });

// 真机房里「课开着却一台头显都没有」不是开课造成的（开课必选头显），
// 而是课上着着老师把那台头显从设备列表里删了——删完这节课就空了，却还挂着「上课中」。
const bareSpare = await must("/devices/enroll", { method: "POST", body: { serial: "PICO-TEST-BARE", name: "自检备胎头显", model: "Pico A821C" } });
const bareLesson = await must("/lessons", { method: "POST", token: teacher, body: { title: "自检·会被删空的课", deviceIds: [Number(bareSpare.deviceId)] } });
const bareId = Number(bareLesson.id);
check("开一节课，先只放一台备胎头显", bareId > 0, `课 #${bareId}`);
check("这台头显此刻不受「没定头显」提醒", !((await must("/dashboard", { token: teacher })).abnormal ?? [])
  .some((item) => item.type === "lesson"), "");
const dropped = await call(`/devices/${bareSpare.deviceId}`, { method: "DELETE", token: teacher });
check("删掉课上那台头显能删（不卡住）", dropped.status === 200, dropped.json?.error ?? "");
check("删的时候顺带说明这台正在上课，已从课上移出", String(dropped.json?.notice ?? "").includes("节课"),
  dropped.json?.notice ?? "没提示");
const bareWarn = ((await must("/dashboard", { token: teacher })).abnormal ?? [])
  .find((item) => item.type === "lesson" && item.detail.includes("一台头显都没指定"));
check("总览提醒「这节课还没定头显」", Boolean(bareWarn), bareWarn?.detail ?? "总览没提");

const backSpare = await must("/devices/enroll", { method: "POST", body: { serial: "PICO-TEST-BARE2", name: "自检补位头显", model: "Pico A821C" } });
const added = await call(`/lessons/${bareId}/devices`, { method: "POST", token: teacher, body: { deviceId: Number(backSpare.deviceId) } });
check("开课之后能把新头显补加进这节课", added.status === 200, added.json?.error ?? "加上了");
check("补加进来的头显立刻算在上课", (await must("/manifest", { deviceToken: backSpare.token })).lesson?.active === true, "");
check("同一台不能重复加进同一节课", (await call(`/lessons/${bareId}/devices`, { method: "POST", token: teacher, body: { deviceId: Number(backSpare.deviceId) } })).status === 400, "");
check("审计记下了是谁加的", ((await must("/audit?limit=5", { token: teacher })).logs ?? [])
  .some((item) => item.action === "lesson.device" && item.detail.includes("自检补位头显")), "");
check("下掉这节课", (await call(`/lessons/${bareId}/end`, { method: "POST", token: teacher })).status === 200, "");
await call(`/devices/${backSpare.deviceId}`, { method: "DELETE", token: teacher });

// ---------- 11.5 按 IP 找头显（后台反问头显，头显不用先连上后台）----------
step("按 IP 找头显");
const fakeHeadset = await startFakeIdentity({ serial: "PICO-TEST-DISCOVER" });
try {
  const hit = await must("/devices/discover", { method: "POST", token: teacher, body: { target: fakeHeadset.target } });
  const seen = hit.found?.[0] ?? {};
  check("问到一台没登记过的头显", hit.ok === true && seen.serial === "PICO-TEST-DISCOVER" && seen.known === null,
    `${hit.target} → ${seen.serial}《${seen.name}》`);
  check("答复里带着型号、版本、应用数", seen.model === "PICO 4 Ultra Enterprise" && seen.launcherVersion === "0.1.0" && seen.appCount === 2,
    `${seen.model}｜启动器 ${seen.launcherVersion}｜${seen.appCount} 个应用`);

  const silentPort = await closedPort();
  const miss = await call("/devices/discover", { method: "POST", token: teacher, body: { target: `127.0.0.1:${silentPort}` } });
  check("IP 上没人应答：HTTP 200 + 中文原因，不报错", miss.status === 200 && miss.json?.ok === false
    && String(miss.json?.reason).includes("拒了连接"), miss.json?.reason ?? "");

  const sweep = await must("/devices/discover", { method: "POST", token: teacher, body: { target: `127.0.0:${fakeHeadset.port}` } });
  check("扫整个网段能把它捞出来（前缀也允许写端口）", sweep.mode === "segment" && sweep.scanned === 254
    && sweep.found.some((item) => item.serial === "PICO-TEST-DISCOVER"), `扫了 ${sweep.scanned} 个地址，问到 ${sweep.found.length} 台`);

  const segmentAdopt = await call("/devices/discover/adopt", { method: "POST", token: teacher, body: { target: "127.0.0" } });
  check("收编只给一整段网段被拒（HTTP 400）", segmentAdopt.status === 400 && String(segmentAdopt.json?.error).includes("完整 IP"),
    segmentAdopt.json?.error ?? "");
  check("填得根本不像 IP 被拒（HTTP 400）", (await call("/devices/discover", { method: "POST", token: teacher, body: { target: "教室第三排" } })).status === 400, "");

  const adopt = await must("/devices/discover/adopt", { method: "POST", token: teacher, body: { target: fakeHeadset.target } });
  check("收编登记成新头显并给出配对码", adopt.ok === true && adopt.created === true && /^\d{4}$/.test(String(adopt.pairingCode)),
    `id=${adopt.id}｜配对码 ${adopt.pairingCode}`);
  check("收编顺手把它报的应用落了库", adopt.apps?.scanned === 2, `报来 ${adopt.apps?.scanned} 个｜待确认 ${adopt.apps?.discovered} 个`);
  const coachApp = (await must("/apps", { token: teacher })).apps.find((item) => item.packageName === FAKE_APPS[0].packageName);
  check("报来的新应用进了目录、默认没上架", coachApp?.source === "device" && coachApp?.enabled === false,
    coachApp ? `#${coachApp.id}《${coachApp.name}》来源=头显扫描` : `没找到 ${FAKE_APPS[0].packageName}`);
  check("系统应用（桌面）不进目录", !(await must("/apps", { token: teacher })).apps.some((item) => item.packageName === FAKE_APPS[1].packageName),
    FAKE_APPS[1].packageName + " 没被当成可控应用");

  const listed = (await must("/devices", { token: teacher })).devices.find((item) => item.serial === "PICO-TEST-DISCOVER");
  check("设备列表里能看到这台，地址和问到它的时间都记下来了", listed?.ip === "127.0.0.1" && Number(listed?.lastProbeAt) > 0,
    `IP=${listed?.ip}｜已装 ${listed?.installedApps} 个应用`);

  await must(`/devices/${adopt.id}`, { method: "PATCH", token: teacher, body: { name: "老师改的名" } });
  const again = await must("/devices/discover/adopt", { method: "POST", token: teacher, body: { target: fakeHeadset.target } });
  check("再收编一次走更新、不重复建", again.created === false && again.id === adopt.id, `id=${again.id}｜created=${again.created}`);
  check("老师起的名字不被冲掉", again.name === "老师改的名", again.name ?? "");
  check("设备表里这台只有一条", (await must("/devices", { token: teacher })).devices
    .filter((item) => item.serial === "PICO-TEST-DISCOVER").length === 1, "");
  const knownAgain = await must("/devices/discover", { method: "POST", token: teacher, body: { target: fakeHeadset.target } });
  check("登记过的再问一次标成「已登记」", knownAgain.found?.[0]?.known?.id === adopt.id,
    knownAgain.found?.[0]?.known ? `已登记 id=${knownAgain.found[0].known.id}` : "没标已登记");
} finally {
  await fakeHeadset.stop();
}

// ---------- 11.55 把后台地址推给头显：收编不上线的九成是它不知道后台在哪 ----------
step("让它连上后台");
const basePort = new URL(base).port || "80";
const placeholderBackend = "http://192.168.1.100:8787";
const pushed = await startFakeIdentity({ serial: "PICO-TEST-PUSH", serverBaseUrl: placeholderBackend });
let pushedId = null;
try {
  const hit = await must("/devices/discover", { method: "POST", token: teacher, body: { target: pushed.target } });
  const seen = hit.found?.[0] ?? {};
  check("发现结果里带着这台正在连的后台（还没推之前是打包占位地址、没连上）",
    seen.serverBaseUrl === placeholderBackend && seen.backendOnline === false,
    `${seen.serverBaseUrl}｜连上=${seen.backendOnline}｜${seen.backendError ?? ""}`);

  const took = await must("/devices/discover/adopt", { method: "POST", token: teacher, body: { target: pushed.target } });
  pushedId = took.id;
  check("收编时顺手把后台地址推过去", took.backend?.ok === true && took.backend?.applied === true,
    `ok=${took.backend?.ok}｜推成=${took.backend?.applied}｜${took.backend?.reason ?? ""}`);
  const nowBackend = pushed.state();
  check("头显收到的地址能连回这台后台（不是 127.0.0.1，也不是占位地址）",
    nowBackend.serverBaseUrl !== placeholderBackend && nowBackend.serverBaseUrl.endsWith(`:${basePort}`)
      && /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(nowBackend.serverBaseUrl),
    `推过去的地址=${nowBackend.serverBaseUrl}`);
  check("后台确实收到过这一次推送", pushed.pushes().length === 1
    && pushed.pushes()[0].from === placeholderBackend && pushed.pushes()[0].to === nowBackend.serverBaseUrl,
    pushed.pushes().map((item) => `${item.from}→${item.to}`).join("，"));

  const listed = (await must("/devices", { token: teacher })).devices.find((item) => item.serial === "PICO-TEST-PUSH");
  check("这台还没心跳，离线原因说清是「不知道后台在哪」而不是「睡了」",
    listed?.online === false && String(listed?.offlineReason).includes("后台地址") && !String(listed?.offlineReason).includes("睡了"),
    listed?.offlineReason ?? "");
  check("问到它的端口也记下来了，推送不用再猜 8790", listed?.probePort === pushed.port, `probePort=${listed?.probePort}`);

  const again = await must(`/devices/${pushedId}/backend`, { method: "POST", token: teacher, body: {} });
  check("网页上再点一次「让它连上后台」也成（不用重填 IP）", again.ok === true && again.applied === true
    && again.port === pushed.port, `ok=${again.ok}｜端口=${again.port}`);

  const silentPort = await closedPort();
  const unreachable = await must(`/devices/${pushedId}/backend`, { method: "POST", token: teacher, body: { host: "127.0.0.1", port: silentPort } });
  check("头显睡了再推：HTTP 200 + 中文原因，不报 500", unreachable.ok === false
    && Boolean(unreachable.reason), unreachable.reason ?? "居然说成功了");

  // 另一种离线：心跳过一阵、后来不吭声了（自己改一下库里的 last_seen 造出来）
  if (dbPath) {
    // 后台那边也可能正在写这个库，抢不到锁就跳过这条断言，别把整轮自检带崩
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(dbPath);
      const before = Number(raw.prepare("SELECT last_seen FROM devices WHERE id = ?").get(deviceId)?.last_seen ?? Date.now());
      // 先把心跳拨到 60 秒前：窗口收紧到 45 秒之后，这一步就该判离线
      // （原先 3 分钟窗口下它还算「在线」，老师照着在线数点重扫，一台都不动）
      raw.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(before - 60_000, deviceId);
      const stale = (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId);
      check("心跳断满 1 分钟就算离线（在线窗口已从 3 分钟收到 45 秒）",
        stale?.online === false, `online=${stale?.online}`);
      raw.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(before - 250_000, deviceId);
      const slept = (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId);
      check("连上过又不吭声的头显，离线原因说清是「睡了」而不是「没配对」",
        slept?.online === false && String(slept?.offlineReason).includes("睡了") && Boolean(slept?.lastHeartbeatAt),
        slept?.offlineReason ?? "");
      raw.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(before, deviceId);
      raw.close();
      check("心跳一恢复就重新算在线", (await must("/devices", { token: teacher })).devices.find((item) => item.id === deviceId)?.online === true, "");
    } catch (error) {
      console.log(`  ↺ 跳过「心跳过期」两条断言（改不动临时库：${error.message}）`);
    }
  }
} finally {
  await pushed.stop();
  if (pushedId) {
    await call(`/devices/${pushedId}`, { method: "DELETE", token: teacher });
  }
}

// 旧启动器没有 POST /v1/config：收编仍要成功，但要告诉老师得手填
const oldLauncher = await startFakeIdentity({ serial: "PICO-TEST-OLD", legacy: true });
let oldId = null;
try {
  const adopted = await must("/devices/discover/adopt", { method: "POST", token: teacher, body: { target: oldLauncher.target } });
  oldId = adopted.id;
  check("旧启动器不认推送：收编照样成功，只提醒去头显里手填", adopted.created === true && adopted.backend?.ok === false
    && String(adopted.backend?.reason).includes("设置 → 后台地址"), adopted.backend?.reason ?? "");
  const pushOld = await must(`/devices/${oldId}/backend`, { method: "POST", token: teacher, body: {} });
  check("对旧启动器点「让它连上后台」给的是中文说明，不是报错", pushOld.ok === false
    && String(pushOld.reason).includes("太旧") && String(pushOld.reason).includes("手填"), pushOld.reason ?? "");
} finally {
  await oldLauncher.stop();
  if (oldId) {
    await call(`/devices/${oldId}`, { method: "DELETE", token: teacher });
  }
}

// ---------- 11.57 已允许却被课上拦下：存策略时就说清 ----------
step("允许了仍被课上拦下");
{
  const noticeDevice = await must("/devices/enroll", {
    method: "POST",
    body: { serial: "PICO-TEST-NOTICE", name: "自检拦课机", model: "PICO 4", launcherVersion: "0.1.0" },
  });
  const noticeToken = noticeDevice.token;
  const noticeId = noticeDevice.deviceId;
  // 造一节正在上的课，只安排滑雪；打靶这时允许了也点不开
  const openLesson = await must("/lessons", { method: "POST", token: teacher, body: { title: "自检拦课（可忽略）", deviceIds: [noticeId], appKeys: ["ski"] } });
  const target = (await must("/apps", { token: teacher })).apps.find((item) => item.packageName === PKG.shooting);
  const saved = await must("/policies", { method: "PUT", token: teacher, body: { appId: target.id, scope: "device", scopeId: noticeId, allowed: true } });
  check("允许打靶时提醒「这节课没安排它」", saved.ok === true && String(saved.notice).includes("上课")
    && String(saved.notice).includes("自检拦课"), saved.notice ?? "没给提醒");
  const manifest = found((await must("/manifest", { deviceToken: noticeToken })).apps, PKG.shooting);
  check("这条提醒不是吓人的：清单里确实还不允许", manifest?.allowed === false
    && String(manifest?.reason).includes("没安排这个应用"), manifest?.reason ?? "");
  // 把它勾进这节课之后，同样的策略就不再提醒
  await must(`/lessons/${openLesson.id}/apps`, { method: "POST", token: teacher, body: { appKeys: ["ski", "shooting"] } });
  const saved2 = await must("/policies", { method: "PUT", token: teacher, body: { appId: target.id, scope: "device", scopeId: noticeId, allowed: true } });
  check("勾进这节课之后不再提醒", saved2.ok === true && (saved2.notice === null || saved2.notice === ""), String(saved2.notice ?? ""));
  check("勾进去之后清单里就允许了", found((await must("/manifest", { deviceToken: noticeToken })).apps, PKG.shooting)?.allowed === true, "");
  await must(`/lessons/${openLesson.id}/end`, { method: "POST", token: teacher });
  await call(`/devices/${noticeId}`, { method: "DELETE", token: teacher });
}

// ---------- 11.6 这张清单跟着头显实际装着的东西走 ----------
step("应用跟着头显的实际清单退场");
const tmpScan = [
  { packageName: PKG.tmpGone, label: "试一下就删", version: "1.0.0", isVr: true },
  { packageName: PKG.tmpKept, label: "上过架的游戏", version: "2.0.0", isVr: true },
];
const arrived = await must("/devices/apps/sync", { method: "POST", deviceToken, body: { apps: [...scanAll, ...tmpScan] } });
const arrivedCatalog = (await must("/apps", { token: teacher })).apps;
const tmpGoneRow = arrivedCatalog.find((item) => item.packageName === PKG.tmpGone);
const tmpKeptRow = arrivedCatalog.find((item) => item.packageName === PKG.tmpKept);
check("头显上新装的应用自己进目录", Boolean(tmpGoneRow && tmpKeptRow),
  `本次新发现 ${arrived.discovered} 个：《${tmpGoneRow?.name}》《${tmpKeptRow?.name}》`);
check("刚扫来的应用先不上架", tmpGoneRow?.enabled === false && tmpKeptRow?.enabled === false,
  `${tmpGoneRow?.name} enabled=${tmpGoneRow?.enabled}`);
check("刚扫来的应用立刻记上装在这台头显上",
  tmpGoneRow?.installedOn?.some((row) => row.id === deviceId) === true,
  tmpGoneRow ? tmpGoneRow.installedOn.map((row) => `${row.name}｜${row.version}`).join("、") : "没找到");
// 老师把其中一个上架，模拟「这应用学校要用」
await must(`/apps/${tmpKeptRow.id}`, { method: "PATCH", token: teacher, body: { enabled: true } });
// 头显再扫一遍：这两个都卸载了，报不上来
const leftSync = await must("/devices/apps/sync", { method: "POST", deviceToken, body: { apps: scanAll } });
const afterLeft = (await must("/apps", { token: teacher })).apps;
check("没上架过的应用跟着头显退了场", leftSync.retired >= 1 && !afterLeft.some((item) => item.packageName === PKG.tmpGone),
  `retired=${leftSync.retired}｜目录里已无 ${PKG.tmpGone}`);
const keptRow = afterLeft.find((item) => item.packageName === PKG.tmpKept);
check("上过架的应用不跟着退，留着标「头显上没有了」", Boolean(keptRow) && keptRow.installedDevices === 0,
  keptRow ? `#${keptRow.id}《${keptRow.name}》还在目录里｜装着它的头显 ${keptRow.installedDevices} 台` : "被误删了");
const keptLocal = await must(`/devices/${deviceId}/apps`, { token: teacher });
check("这台头显装过它的记录留着，报表对得上账",
  (found(keptLocal.items, PKG.tmpKept) ?? found(keptLocal.unmanaged, PKG.tmpKept))?.installState === "missing",
  `installState=${(found(keptLocal.items, PKG.tmpKept) ?? found(keptLocal.unmanaged, PKG.tmpKept))?.installState}`);
await must(`/apps/${keptRow.id}`, { method: "PATCH", token: teacher, body: { enabled: false } });

// ---------- 12. 收尾 ----------
step("收尾");
const skiApp = (await must("/apps", { token: teacher })).apps.find((item) => item.packageName === PKG.ski);
check("滑雪应用回到「在清单里、允许跑」", skiApp.managed === true && skiApp.enabled === true, `#${skiApp.id} 纳管=${skiApp.managed} 上架=${skiApp.enabled}`);
// 重新拉一遍目录再断言：`stray` 是几十行前拿到的旧对象，中间它被误删了也照样绿
const strayNow = (await must("/apps", { token: teacher })).apps.find((item) => item.packageName === PKG.unlisted) ?? null;
check("《偷偷装的游戏》还留在目录里等老师确认（没被自动上架、也没被移出清单）",
  strayNow !== null && strayNow.enabled === false && strayNow.source === "device" && strayNow.managed === true,
  strayNow ? `#${strayNow.id}《${strayNow.name}》来源=${strayNow.source}｜上架=${strayNow.enabled}｜纳管=${strayNow.managed}` : "目录里已经找不到它了");
const reset = await must(`/devices/${deviceId}`, { method: "PATCH", token: teacher, body: { appMode: "allowlist" } });
check("管控模式复位成白名单", reset.ok === true, JSON.stringify(reset.changes ?? []));

// 老师原本下架的应用要还回去：自检临时上架只是为了让断言有东西可断，不是替老师改主意
for (const appId of relisted) {
  await must(`/apps/${appId}`, { method: "PATCH", token: teacher, body: { enabled: false } });
}
const backOff = (await must("/apps", { token: teacher })).apps.filter((app) => relisted.includes(app.id));
check("老师原本下架的应用原样还回去", backOff.every((app) => app.enabled === false),
  relisted.length ? `#${relisted.join("、#")} 恢复下架` : "老师没下架过，不用还");

// 「清空数据」不再猜哪些应用是自检脏数据（它猜错过一回：把真头显扫出来的清单整个清光了），
// 所以自检塞进去的那两个应用由自检自己删干净 —— 谁弄出来的谁收。
const injected = [PKG.unlisted, FAKE_APPS[0].packageName, PKG.tmpGone, PKG.tmpKept];
for (const app of (await must("/apps", { token: teacher })).apps.filter((item) => injected.includes(item.packageName))) {
  await must(`/apps/${app.id}`, { method: "DELETE", token: teacher });
}

step("清空数据后不掉登录");
const wiped = await must("/admin/reset", { method: "POST", token: teacher, body: { scope: "run" } });
check("清空跑出来的数据", wiped.ok === true && wiped.remaining.usage_events === 0,
  `删掉自检头显 ${wiped.removedTestDevices} 台｜时长/心跳/越权/扫描记录清零`);
const keptCatalog = (await must("/apps", { token: teacher })).apps;
// 只要求「老师自己的那些」一个不少：自检用的那两个包名（含上几遍跑剩的）由自检负责清掉
const teachersOwn = catalogBefore.filter((app) => !injected.includes(app.packageName));
check("清空数据不动老师的应用目录",
  teachersOwn.every((app) => keptCatalog.some((item) => item.id === app.id)),
  `老师原有的 ${teachersOwn.length} 个一个没少（现在目录共 ${keptCatalog.length} 个）`);
check("自检塞进去的应用自检收干净", !keptCatalog.some((app) => injected.includes(app.packageName)),
  `《偷偷装的游戏》《${FAKE_APPS[0].label}》都不留在目录里`);
const stillLogged = await call("/me", { token: teacher });
check("清空后当前这次登录还能用（不掉线）", stillLogged.status === 200, stillLogged.status === 200 ? "会话保住了" : (stillLogged.json?.error ?? ""));
check("清空后总览照常打开", (await call("/dashboard", { token: teacher })).status === 200);
const keptStudents = (await must("/students", { token: teacher })).students.length;
check("清空后保留班级/学生/头显/应用清单", keptStudents > 0, `${keptStudents} 个学生还在`);

console.log(`\n—— 断言 ${passed + failures.length} 条，通过 ${passed} 条`);
if (failures.length) {
  console.log(`结果：失败（${failures.length} 条）`);
  for (const title of failures) {
    console.log(`  · ${title}`);
  }
  process.exit(1);
}
console.log("结果：通过");
