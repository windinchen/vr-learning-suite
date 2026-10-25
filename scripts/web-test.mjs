// 老师网页的浏览器自检：真开一个 Chromium，把控制台各页点一遍，顺便抓图到 Build/WebScreens/。
// 用法：bash scripts/web-test.sh                 （缺 playwright 会自动装到 .webtest/）
//      node scripts/web-test.mjs --base http://127.0.0.1:8787 --shots 0
// 断言的是「页面能出来、点了有反应、文案没跑偏」，接口层面的事交给 api-test.mjs。
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closedPort, startFakeIdentity } from "./fake-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const BASE = flag("base", "http://127.0.0.1:8787");
const ACCOUNT = flag("account", "admin");
const PASSWORD = flag("password", "pico123456");
const wantShots = flag("shots", "1") !== "0";
const OUT = path.join(root, "Build/WebScreens");

async function loadChromium() {
  const local = path.join(root, ".webtest/node_modules/playwright-core/index.js");
  const places = ["playwright-core", existsSync(local) ? pathToFileURL(local).href : null];
  for (const target of places) {
    if (!target) {
      continue;
    }
    try {
      const mod = await import(target);
      const driver = mod.chromium ?? mod.default?.chromium;
      if (driver) {
        return driver;
      }
    } catch {}
  }
  console.log("❌ 缺 playwright-core。跑 bash scripts/web-test.sh 会自动装到 .webtest/。");
  process.exit(2);
}

/** 找本机已下载的 Chromium（Playwright 缓存里有就直接用，不再下载 100 MB 浏览器）。 */
function findChromium() {
  const cache = path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  const candidates = [];
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      for (const rel of [
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      ]) {
        const candidate = path.join(cache, entry, rel);
        if (existsSync(candidate)) {
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates.find((item) => item.includes("headless")) ?? candidates[0] ?? null;
}

const chromium = await loadChromium();
const executablePath = findChromium();
const errors = [];
const results = [];
let failed = 0;
const check = (name, pass, detail = "") => {
  if (!pass) {
    failed += 1;
  }
  results.push(`${pass ? "✅" : "❌"} ${name}${detail ? `　${detail}` : ""}`);
};
const step = (title) => results.push(`\n—— ${title}`);

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
page.on("pageerror", (error) => errors.push(`页面报错：${error.message}`));
// 改名 / 删班用的是 window.prompt、window.confirm：不接住对话框，这些路径一次都没被跑过
let dialogReply = { accept: true, text: "" };
page.on("dialog", async (dialog) => {
  await (dialogReply.accept ? dialog.accept(dialogReply.text) : dialog.dismiss());
});
/** 等 .view 里出现某段文字再返回它的文本：比 sleep 稳，也比 sleep 快。 */
async function viewHas(needle, timeout = 9000) {
  await page.waitForFunction((text) => (document.querySelector(".view")?.innerText ?? "").includes(text), needle, { timeout });
  return (await page.textContent(".view")).replace(/\s+/g, " ");
}

const shot = async (name) => {
  if (!wantShots) {
    return;
  }
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
};
if (wantShots) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
}

try {
  step("登录");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click("#login-form button");
  await page.waitForSelector("#nav button", { timeout: 10000 });
  check("老师登录进得去", (await page.textContent(".side-brand")).includes("VR 学习套件"));
  const nav = await page.textContent("#nav");
  for (const name of ["总览", "PICO 设备", "上课", "头显应用", "学生", "应用与策略", "时长报表", "操作日志"]) {
    check(`侧栏有「${name}」`, nav.includes(name));
  }

  step("各页面都能打开");
  const shotNames = {
    dashboard: "01-总览.png",
    devices: "02-PICO设备.png",
    lesson: "03-上课.png",
    "device-apps": "04-头显应用.png",
    students: "05-学生.png",
    apps: "06-应用与策略.png",
    reports: "07-时长报表.png",
    audit: "08-操作日志.png",
  };
  // 锚点用各页自己的面板标题：以前写的是「上课」「学生」这种侧栏就有的词，
  // 加上 length > 60 基本永真，页面整块渲染不出来也能绿
  for (const [pageId, anchor] of [
    ["dashboard", "今日各应用时长"],
    ["devices", "已登记头显"],
    ["lesson", "最近上的课"],
    ["device-apps", "选一台头显"],
    ["students", "名单"],
    ["apps", "应用清单"],
    ["reports", "时长统计"],
    ["audit", "操作日志"],
  ]) {
    await page.click(`#nav button[data-page="${pageId}"]`);
    let text = "";
    try {
      text = await viewHas(anchor);
    } catch {
      text = (await page.textContent(".view") ?? "").replace(/\s+/g, " ");
    }
    check(`「${pageId}」页出得来（认得出面板「${anchor}」）`, text.includes(anchor), text.slice(0, 26));
    if (pageId !== "device-apps") {
      await shot(shotNames[pageId]);
    }
  }

  step("头显应用页");
  await page.click('#nav button[data-page="device-apps"]');
  await page.waitForSelector(".dev-tab", { timeout: 8000 });
  const { devices } = await page.evaluate(() => fetch("/api/v1/devices").then((r) => r.json()));
  const tabs = await page.$$(".dev-tab");
  check("每台头显一个切换卡片", tabs.length === devices.length, `卡片 ${tabs.length} 个｜后台 ${devices.length} 台`);
  await page.click(".dev-tab:nth-child(1)");
  await viewHas("装了哪些应用");
  const picked = devices[0];
  const inventory = await page.evaluate(
    (id) => fetch(`/api/v1/devices/${id}/apps`).then((r) => r.json()),
    picked.id,
  );
  const wantInstalled = inventory.items.filter((item) => item.installState === "installed").length;
  // 读「这台已装」那张卡的数字跟后台比，不再用 includes(数字) —— 那种写法页面里任何数字都能糊过去
  const kpiInstalled = await page.$$eval(".card", (cards) => {
    const hit = cards.find((c) => (c.querySelector(".label")?.textContent ?? "").trim() === "这台已装");
    return hit ? Number(hit.querySelector(".kpi")?.textContent) : null;
  }, );
  check("「这台已装」的数字跟后台算的一致", kpiInstalled === wantInstalled, `界面 ${kpiInstalled}｜后台 ${wantInstalled}｜清单 ${inventory.items.length} 个`);
  await shot("04-头显应用.png");

  const rows = await page.$$("#devapp-rows tr");
  check("应用策略表列出这台的管理清单", rows.length > 0, `${rows.length} 行`);
  await page.fill("#devapp-search", "射击");
  await page.waitForTimeout(300);
  const searched = await page.$$eval("#devapp-rows tr", (ts) => ts.filter((t) => !t.classList.contains("hidden")).length);
  check("搜索能过滤", searched >= 1 && searched < rows.length, `搜「射击」剩 ${searched} 行｜${await page.textContent("#devapp-shown")}`);
  await page.fill("#devapp-search", "");
  // 系统应用（桌面、商店）按规矩不进管理清单，所以筛选条里不该有「系统应用」这一项，它们列在下面的「清单外的应用」面板
  const chips = await page.$$eval("#devapp-filters .chip", (ts) => ts.map((t) => t.dataset.filter));
  check("筛选条不再摆「系统应用」——系统应用压根不进管理清单", !chips.includes("system"), chips.join("／"));
  const pageText = await page.textContent(".view");
  check("扫到的系统应用列在「清单外的应用」面板里",
    pageText.includes("清单外的应用") && pageText.includes("系统应用"), "PICO 浏览器／商店这类列在清单外，可以一键纳入管理");
  await page.click('#devapp-filters .chip[data-filter="installed"]');
  await page.waitForTimeout(300);
  const installed = await page.$$eval("#devapp-rows tr", (ts) => ts.filter((t) => !t.classList.contains("hidden")).length);
  check("「已装」筛选跟后台口径一致", installed === wantInstalled, `界面 ${installed} 行｜后台已装 ${wantInstalled} 个`);
  await page.click('#devapp-filters .chip[data-filter="all"]');
  await page.waitForTimeout(300);
  await shot("09-头显应用-筛选与搜索.png");

  // 「删不掉」那次的根因：这台根本没装的应用去删扫描记录，后台回 404，界面又没接住
  const delButtons = await page.$$eval("#devapp-rows tr", (rows) =>
    rows.map((tr) => ({ state: tr.dataset.state, act: tr.querySelector("[data-act='local-app-delete'], [data-act='app-delete']")?.dataset.act ?? "" })),
  );
  const wrongButton = delButtons.filter((row) => row.act !== (row.state === "installed" ? "local-app-delete" : "app-delete"));
  check("删除按钮按「这台装没装」分派：装了删扫描记录，没装从清单删除",
    delButtons.length > 0 && wrongButton.length === 0,
    `已装 ${delButtons.filter((r) => r.state === "installed").length} 行／没装 ${delButtons.filter((r) => r.state !== "installed").length} 行｜不对的 ${wrongButton.length} 行`);

  step("逐台策略（改完还原）");
  // GET /policies 不支持 scope 查询参数（返回全部），要筛就在拿回来之后自己筛
  const before = await page.evaluate(() =>
    fetch("/api/v1/policies").then((r) => r.json())
      .then((d) => d.policies.filter((p) => p.scope === "device" && p.allowed !== null).length),
  );
  await page.click("#devapp-deny-all");
  if (wantInstalled) {
    await page.waitForFunction(
      (want) => document.querySelectorAll('select[data-act="dev-allow"] option[selected]') !== null
        && [...document.querySelectorAll('select[data-act="dev-allow"]')].filter((x) => x.value === "0").length >= want,
      wantInstalled,
      { timeout: 12000 },
    ).catch(() => {});
  } else {
    await page.waitForTimeout(1500);
  }
  const denied = await page.$$eval('select[data-act="dev-allow"]', (s) => s.filter((x) => x.value === "0").length);
  if (wantInstalled) {
    check("批量禁止写进这台的专属策略", denied === wantInstalled, `${denied} 个应用变成「禁止」（应等于已装 ${wantInstalled} 个）`);
  } else {
    const toastText = await page.textContent("body");
    check("这台没已装应用时批量按钮给提示不空跑", denied === 0 && toastText.includes("没有已装的应用"), "没改动任何策略，提示正确");
  }
  await shot("10-头显应用-批量禁止.png");
  const restored = await page.evaluate(async (target) => {
    const { apps } = await fetch("/api/v1/apps").then((r) => r.json());
    const { devices } = await fetch("/api/v1/devices").then((r) => r.json());
    const device = devices.find((d) => d.id === target) ?? devices[0];
    for (const app of apps) {
      await fetch("/api/v1/policies", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: app.id, scope: "device", scopeId: device.id, allowed: null, dailyMinutes: null }),
      });
    }
    const after = await fetch("/api/v1/policies").then((r) => r.json());
    return after.policies.filter((p) => p.scope === "device" && p.allowed !== null).length;
  }, devices[0].id);
  check("改回「跟随默认」会把策略行删掉", restored <= before, `残留 ${restored} 条（改之前 ${before} 条）`);

  step("扫描指令下发");
  // 先在真的那台（模拟头显）身上验：指令入队后 web-test.sh 收尾会让它上第二轮班把指令执行掉
  await page.click("#devapp-scan");
  let afterScan = "";
  try {
    afterScan = await viewHas("条指令等头显联网执行", 9000);
  } catch {
    afterScan = (await page.textContent(".view") ?? "").replace(/\s+/g, " ");
  }
  // 待执行指令数在 GET /devices 的每一行上（网页上那句提示也是从那儿读的），别去猜别的接口
  const pendingFromApi = await page.evaluate(
    (id) => fetch("/api/v1/devices").then((r) => r.json())
      .then((d) => Number((d.devices.find((item) => item.id === id) ?? {}).pendingCommands ?? -1)),
    devices[0].id,
  );
  check(
    "点「扫描这台头显」后指令真的入了队",
    afterScan.includes("还有") && pendingFromApi >= 1,
    `${afterScan.match(/还有 \d+ 条指令[^。]*。/)?.[0] ?? "页面没写条数"}｜接口说这台待执行 ${pendingFromApi} 条`,
  );
  await shot("12-头显应用-扫描已下发.png");

  step("没扫过的头显（自己造一台，不再看库里有没有）");
  // 以前是「库里恰好有一台没扫过的才测」，平时每台都扫过了 → 这块常年不测，11 号图也常年缺。
  // 现在当场登记一台从没上报过扫描结果的，测完删掉。
  const idleDevice = await page.evaluate(() =>
    fetch("/api/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serial: "PICO-TEST-WEBIDLE", name: "自检没扫过的头显" }),
    }).then((r) => r.json()),
  );
  check("临时登记一台没扫过的头显", Boolean(idleDevice?.id), `设备 #${idleDevice?.id}｜${idleDevice?.name ?? ""}`);
  await page.click('#nav button[data-page="device-apps"]');
  await page.waitForSelector(".dev-tab", { timeout: 8000 });
  const idleTab = await page.$$eval(".dev-tab", (tabs, name) => tabs.findIndex((t) => (t.textContent ?? "").includes(name)), "自检没扫过的头显");
  check("这台出现在头显卡片里", idleTab >= 0, `第 ${idleTab + 1} 张卡片`);
  await page.click(`.dev-tab:nth-child(${idleTab + 1})`);
  let idleText = "";
  try {
    idleText = await viewHas("还没扫描过应用");
  } catch {
    idleText = (await page.textContent(".view") ?? "").replace(/\s+/g, " ");
  }
  check("没扫过的头显提示去扫描，不是空表装样子", idleText.includes("还没扫描过应用"),
    idleText.match(/这台头显还没扫描过[^。]*。/)?.[0] ?? idleText.slice(0, 50));
  check("没扫过时「这台已装」是 0 而不是问号",
    (await page.$$eval(".card", (cards) => {
      const hit = cards.find((c) => (c.querySelector(".label")?.textContent ?? "").trim() === "这台已装");
      return hit ? hit.querySelector(".kpi")?.textContent : null;
    })) === "0", "没扫过就明说没装着，别显示 unknown");
  await shot("11-头显应用-没扫过的头显.png");
  await page.evaluate(
    async (id) => {
      await fetch(`/api/v1/devices/${id}`, { method: "DELETE" });
    },
    idleDevice.id,
  );
  await page.click('#nav button[data-page="device-apps"]');
  await page.waitForSelector(".dev-tab", { timeout: 8000 });
  check("用完删掉，不脏下一次的表",
    (await page.$$eval(".dev-tab", (ts) => ts.map((t) => t.textContent))).join("").includes("自检没扫过的头显") === false,
    `现在 ${await page.$$eval(".dev-tab", (ts) => ts.length)} 张卡片`);

  step("清单只能扫出来：没有手工登记的入口");
  await page.click('#nav button[data-page="apps"]');
  await page.waitForTimeout(1200);
  const appsText = (await page.textContent(".view")).replace(/\s+/g, " ");
  check("应用页没有「登记新应用」表单了", (await page.$("#app-form")) === null);
  check(
    "应用页讲清了清单从头显实际读取",
    appsText.includes("这张表是从哪来的") && appsText.includes("头显实际装着什么，这里就列什么"),
    appsText.match(/这张表是从哪来的[^。]*/)?.[0] ?? "",
  );
  const appHeaders = await page.$$eval('.view table thead th', (cells) => cells.map((c) => c.textContent.trim()));
  check(
    "应用表列的是「哪几台头显装着」，不再有「来源」",
    appHeaders.includes("哪几台头显装着") && !appHeaders.includes("来源"),
    appHeaders.join("｜"),
  );
  // 口径必须和接口一致：默认只列头显上真装着的，上架过的才留在开关里。
  const appsCatalog = await page.evaluate(() => fetch("/api/v1/apps").then((r) => r.json()));
  const onDevicesCount = appsCatalog.apps.filter((a) => a.installedDevices > 0).length;
  const goneCount = appsCatalog.apps.length - onDevicesCount;
  const rowMatch = appsText.match(/(\d+) 个是从 (\d+) 台头显上读出来的/);
  check(
    "默认只列头显上装着的应用",
    rowMatch !== null && Number(rowMatch[1]) === onDevicesCount,
    `页面 ${rowMatch?.[1] ?? "?"} 个｜接口 ${onDevicesCount} 个（头显上已没有的 ${goneCount} 个）`,
  );
  check(
    "「也显示头显上已经没有的」开关在位",
    (await page.$('[data-act="apps-toggle-gone"]')) !== null,
    (await page.textContent('[data-act="apps-toggle-gone"]'))?.replace(/\s+/g, " ") ?? "",
  );
  check("应用页能一键让在线头显重扫", (await page.$('[data-act="rescan-all-devices"]')) !== null,
    (await page.textContent('[data-act="rescan-all-devices"]'))?.replace(/\s+/g, " ") ?? "");
  await shot("15-应用与策略-清单来源.png");

  await page.click('#nav button[data-page="device-apps"]');
  await page.waitForSelector("#devapp-rows", { timeout: 8000 });
  const localText = (await page.textContent(".view")).replace(/\s+/g, " ");
  check("头显应用页没有「手工补录」表单了", (await page.$("#add-local-app")) === null);
  check("头显应用页写明只认头显扫的", localText.includes("只认头显自己扫的"),
    localText.match(/这台的应用清单从哪来[^。]*。/)?.[0] ?? "");

  step("上课页：课上没头显要看得出来，也要补得进去");
  const postJson = (path, body) =>
    page.evaluate(
      ([p, b]) =>
        fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
      [path, body],
    );
  const seatDevice = await postJson("/api/v1/devices", { serial: "PICO-TEST-WEBSIZE", name: "自检课上头显" });
  const spareDevice = await postJson("/api/v1/devices", { serial: "PICO-TEST-WEBSPARE", name: "自检待补头显" });
  check("为这一节自检课临时登记两台头显", Boolean(seatDevice?.id) && Boolean(spareDevice?.id),
    `课上 #${seatDevice?.id}｜待补 #${spareDevice?.id}`);
  const started = await postJson("/api/v1/lessons", { title: "自检·网页上课页", deviceIds: [seatDevice.id], appKeys: [] });
  check("开一节课，只放一台头显", Boolean(started?.id), `课 #${started?.id}`);
  await page.click('#nav button[data-page="lesson"]');
  await viewHas("参加的头显");
  const lessonText = (await page.textContent(".view")).replace(/\s+/g, " ");
  check("上课页写明几台在课上、几台没加进来", /1 台在课上/.test(lessonText) && lessonText.includes("没加进来"),
    lessonText.match(/参加的头显\s*\d[^｜]*｜[^<]{0,20}/)?.[0] ?? "");
  await page.click(`button[data-act="lesson-add-device"][data-device="${spareDevice.id}"]`);
  await viewHas("自检待补头显");
  check("点「加进这节课」真的补了进去", (await page.textContent(".view")).includes("自检待补头显"),
    `现在 ${await page.$$eval(".seat", (nodes) => nodes.length)} 个座位`);
  // 停用的学生也能被点到，点完那台会直接锁住：下拉里就得先说清楚，别让老师当场纳闷
  const pausedStudent = await page.evaluate(() =>
    fetch("/api/v1/students")
      .then((r) => r.json())
      .then(async (d) => {
        const student = d.students.find((item) => item.status === "active");
        await fetch(`/api/v1/students/${student.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "suspended" }),
        });
        return student;
      }),
  );
  await page.click('[data-act="lesson-refresh"]');
  await page.waitForTimeout(1500);
  const seatOptions = await page.$$eval('select[data-act="lesson-assign"] option', (nodes) =>
    nodes.map((node) => node.textContent.replace(/\s+/g, " ").trim()),
  );
  check("已停用的学生在当堂点名下拉里就写明「点了会被锁住」",
    seatOptions.some((text) => text.includes(pausedStudent.name) && text.includes("已停用")),
    seatOptions.find((text) => text.includes(pausedStudent.name)) ?? `下拉里没找到 ${pausedStudent.name}`);
  await page.evaluate(
    (id) =>
      fetch(`/api/v1/students/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      }),
    pausedStudent.id,
  );
  const deleteDevice = (id) =>
    page.evaluate(async (deviceId) => (await fetch(`/api/v1/devices/${deviceId}`, { method: "DELETE" })).json(), id);
  const dropped = await deleteDevice(seatDevice.id);
  check("删掉课上那台时后台回话说清「已从课上移出」", String(dropped?.notice ?? "").includes("节课"),
    dropped?.notice ?? "没回说，老师不会知道课被删空了");
  await deleteDevice(spareDevice.id);
  await page.click('#nav button[data-page="lesson"]');
  await viewHas("这节课还没定头显");
  const emptyText = (await page.textContent(".view")).replace(/\s+/g, " ");
  check("课上头显删空时，上课页不再摆一个空墙装样子", emptyText.includes("这节课还没定头显"),
    emptyText.match(/这节课还没定头显[^<]{0,40}/)?.[0] ?? "");
  check("总览把这种课列进「需要关注」", (await page.evaluate(async () => (await (await fetch("/api/v1/dashboard")).json()).abnormal))
    .some((row) => row.type === "lesson"), "");
  await shot("16-上课-课上没定头显.png");
  await postJson(`/api/v1/lessons/${started.id}/end`, {});

  step("学生页：改得动、筛得动、批量进得来");
  const webClass = await postJson("/api/v1/classes", { name: "自检网页班（可删）", grade: "初二" });
  check("临时建一个班", Boolean(webClass?.id), `班级 #${webClass?.id}`);
  const webBulk = await postJson("/api/v1/students/bulk", {
    text: "9101 自检网页甲 自检网页班（可删）\n9102 自检网页乙 自检网页班（可删）\n9103 自检网页丙\n",
  });
  check("一次贴三个学生进来（第三个没写班级→未分班）", webBulk?.created?.length === 3,
    `导入 ${webBulk?.created?.length ?? 0} 人｜跳过 ${webBulk?.skipped?.length ?? 0} 行`);
  await page.click('#nav button[data-page="students"]');
  await viewHas("整份名单贴进来");
  const rosterText = (await page.textContent(".view")).replace(/\s+/g, " ");
  check("班级成了卡片，人数写在上面", rosterText.includes("自检网页班（可删）") && /2\s*人/.test(rosterText),
    rosterText.match(/自检网页班（可删）[^｜]{0,14}/)?.[0] ?? "");
  const rosterHeads = await page.$$eval('.view table thead th', (cells) => cells.map((c) => c.textContent.trim()));
  check("名单多了「累计时长」这一列（接口早就算了，页面一直没用）",
    rosterHeads.includes("累计时长") && rosterHeads.includes("今日时长"), rosterHeads.join("｜"));
  check("每行姓名学号就是输入框，点开直接改",
    (await page.$$eval('input[data-act="student-field"]', (inputs) => inputs.length)) >= 6,
    `${await page.$$eval('input[data-act="student-field"]', (i) => i.length)} 个行内输入框`);
  check("新增学生的班级下拉有「未分班」",
    (await page.$eval('#add-student select[name="classId"]', (s) => s.options[0].textContent.trim())) === "未分班");
  await shot("17-学生-名单与班级.png");

  await page.fill("#student-search", "9103");
  await page.waitForTimeout(350);
  const searchedRows = await page.$$eval("#view tbody tr", (ts) => ts.filter((t) => !t.classList.contains("hidden")).length);
  check("按学号搜能筛到一个人", searchedRows === 1, `筛出 ${searchedRows} 行｜计数写「${await page.textContent("#roster-shown")}」`);
  check("筛完的计数跟着改", (await page.textContent("#roster-shown")).includes("筛出 1 人"),
    await page.textContent("#roster-shown"));
  await page.fill("#student-search", "");
  await page.waitForTimeout(350);

  const classChip = await page.$$eval("#student-filters button", (bs) =>
    bs.findIndex((b) => (b.textContent ?? "").includes("自检网页班")), );
  check("班级筛选条里有这个班", classChip >= 0, `第 ${classChip + 1} 个筛选片`);
  // 姓名和学号现在是行内输入框：innerText 读不到 value，断言一律读输入框本身
  const rosterNames = () => page.$$eval('input[data-field="name"]', (ins) => ins.map((node) => node.value));
  const rosterNos = () => page.$$eval('input[data-field="studentNo"]', (ins) => ins.map((node) => node.value));
  await page.click(`#student-filters button:nth-child(${classChip + 1})`);
  await page.waitForTimeout(1400);
  const inClass = await rosterNames();
  const filtered = await page.$$eval("#view tbody tr", (ts) => ts.filter((t) => !t.classList.contains("hidden")).length);
  check("按班级筛出来正好是这个班那两个人", filtered === 2 && inClass.includes("自检网页甲") && inClass.includes("自检网页乙"),
    `${filtered} 行｜${inClass.join("、")}`);
  await page.click("#student-filters button:nth-child(1)");
  await page.waitForTimeout(1400);
  check("切回「全部」，没分班的那个也回来了", (await rosterNames()).includes("自检网页丙"),
    `${(await rosterNames()).length} 行`);

  const setCell = async (selector, value) => {
    await page.$eval(selector, (node, text) => {
      node.value = text;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };
  await setCell('tr[data-search*="9101"] select[data-act="student-class"]', "");
  await page.waitForTimeout(1000);
  const movedOut = await page.evaluate(() =>
    fetch("/api/v1/students").then((r) => r.json()).then((d) => d.students.find((s) => s.studentNo === "9101")?.class ?? null),
  );
  check("行内改班级直接生效（原来只能删了重录）", movedOut === null, `9101 现在的班级：${movedOut?.name ?? "未分班"}`);

  await setCell('tr[data-search*="9102"] input[data-field="studentNo"]', "9101");
  await page.waitForTimeout(900);
  const clash = (await page.textContent("body")).replace(/\s+/g, " ");
  check("学号撞车时网页把后台那句中文原样说给老师", clash.includes("已经是") && clash.includes("换个学号"),
    clash.match(/学号 9101 已经是[^！]{0,24}/)?.[0] ?? clash.slice(-70));
  await setCell('tr[data-search*="9102"] input[data-field="studentNo"]', "9102X");
  await page.waitForTimeout(1400);
  check("学号改完名单立刻是新学号", (await rosterNos()).includes("9102X"), (await rosterNos()).join("、"));
  await shot("18-学生-行内改学与班.png");

  // 库里本来就有两个班，删班按钮得认准自检那一个，别误删老师的班
  const classDeleteHandle = async () => {
    for (const handle of await page.$$('[data-act="class-delete"]')) {
      if ((await handle.evaluate((node) => node.dataset.name)) === "自检网页班（可删）") {
        return handle;
      }
    }
    return null;
  };
  dialogReply = { accept: false, text: "" };
  const cancelTarget = await classDeleteHandle();
  check("这个班有自己的「删班」按钮", cancelTarget !== null);
  await cancelTarget.click();
  await page.waitForTimeout(800);
  check("删班对话框点「取消」就什么都不动", (await page.evaluate(() =>
    fetch("/api/v1/classes").then((r) => r.json()))).classes.some((c) => c.name === "自检网页班（可删）"), "班级还在");
  dialogReply = { accept: true, text: "" };
  await (await classDeleteHandle()).click();
  await page.waitForTimeout(1400);
  const afterDrop = (await page.textContent("body")).replace(/\s+/g, " ");
  check("确认删班后回话说清那几个学生去哪了",
    afterDrop.includes("未分班") && afterDrop.includes("时长记录"),
    afterDrop.match(/已删掉「[^」]*」[^｜]{0,40}/)?.[0] ?? afterDrop.slice(-70));
  const stillThere = await page.evaluate(() =>
    fetch("/api/v1/students").then((r) => r.json())
      .then((d) => d.students.filter((s) => /^910\d/.test(s.studentNo))),
  );
  check("班没了、三个人一个没少，班级都变成未分班",
    stillThere.length === 3 && stillThere.every((s) => !s.class),
    stillThere.map((s) => `${s.studentNo}→${s.class?.name ?? "未分班"}`).join("、"));
  await shot("19-学生-删班后落到未分班.png");

  // 「看明细」：先给其中一个学生造一条真用出来的记录，再看网页点开之后画的是不是那一笔
  const usageDevice = await postJson("/api/v1/devices/enroll", {
    serial: "PICO-TEST-USAGE",
    model: "PICO 4",
    launcherVersion: "0.1.0",
  });
  const usageStudent = (await page.evaluate(() => fetch("/api/v1/students").then((r) => r.json())))
    .students.find((item) => item.studentNo === "9103");
  const usageLesson = await postJson("/api/v1/lessons", {
    title: "自检·明细课（可忽略）",
    deviceIds: [usageDevice.deviceId],
    appKeys: [],
  });
  await postJson(`/api/v1/lessons/${usageLesson.id}/assign`, { deviceId: usageDevice.deviceId, studentId: usageStudent.id });
  const seeded = await page.evaluate(([token, startedAt]) =>
    fetch("/api/v1/usage/batch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-token": token },
      body: JSON.stringify({
        batchId: `web-usage-${Date.now()}`,
        events: [{ appKey: "ski", packageName: "com.school.vr.ski", startedAt, endedAt: startedAt + 150_000, seconds: 150 }],
      }),
    }).then((r) => r.json()),
  [usageDevice.token, Date.now() - 200_000]);
  check("给「自检网页丙」造了一条 2 分 30 秒的滑雪记录", seeded?.accepted === 1,
    `入库 ${seeded?.accepted ?? 0} 条｜重复 ${seeded?.duplicates ?? 0} 条`);
  await page.click('#nav button[data-page="students"]');
  await viewHas("整份名单贴进来");
  await page.click('tr[data-search*="9103"] details[data-act="student-usage"] summary');
  await viewHas("近 7 天共");
  const usageBox = (await page.textContent('tr[data-search*="9103"] .usage-body')).replace(/\s+/g, " ");
  check("点「看明细」画出跑了哪个应用、多久、在哪台、算哪节课",
    usageBox.includes("雪山滑雪") && usageBox.includes("2 分 30 秒") && usageBox.includes("自检·明细课"),
    usageBox.slice(0, 120));
  await page.click('tr[data-search*="9101"] details[data-act="student-usage"] summary');
  await viewHas("没跑过应用");
  const emptyBox = (await page.textContent('tr[data-search*="9101"] .usage-body')).replace(/\s+/g, " ");
  check("一条记录都没有的学生，展开后是一句话说清，不摆空表",
    emptyBox.includes("没跑过应用") && emptyBox.includes("一条记录都还没有"), emptyBox.slice(0, 90));
  await shot("20-学生-看明细.png");
  await postJson(`/api/v1/lessons/${usageLesson.id}/end`, {});
  await page.evaluate((id) => fetch(`/api/v1/devices/${id}`, { method: "DELETE" }), usageDevice.deviceId);

  // #view 是 index.html 里的常驻节点：以前每进一次学生页就往它身上多挂一个监听器，
  // 进出三趟之后改一次名字会连发三个 PATCH、弹三条一样的提示。现在绑在每次重绘新建的 tbody 上。
  for (let round = 0; round < 3; round += 1) {
    await page.click('#nav button[data-page="reports"]');
    await page.waitForTimeout(300);
    await page.click('#nav button[data-page="students"]');
    await page.waitForTimeout(500);
  }
  let patchCalls = 0;
  const countPatch = (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/v1/students/")) {
      patchCalls += 1;
    }
  };
  page.on("request", countPatch);
  await setCell('tr[data-search*="9102"] input[data-field="name"]', "自检网页乙改名");
  await page.waitForTimeout(1300);
  page.off("request", countPatch);
  check("进出学生页三趟，改一次名字仍然只发一个 PATCH", patchCalls === 1, `发了 ${patchCalls} 个 PATCH`);

  await page.evaluate(() =>
    fetch("/api/v1/students").then((r) => r.json()).then(async (d) => {
      for (const student of d.students.filter((s) => /^910\d/.test(s.studentNo))) {
        await fetch(`/api/v1/students/${student.id}`, { method: "DELETE" });
      }
    }),
  );
  const rosterClean = (await page.evaluate(() => fetch("/api/v1/students").then((r) => r.json())))
    .students.filter((s) => /^910\d/.test(s.studentNo));
  check("自检建的学生删干净", rosterClean.length === 0, rosterClean.map((s) => s.studentNo).join("、") || "一个不剩");

  step("按 IP 找头显");
  const fakeHeadset = await startFakeIdentity({ serial: "PICO-TEST-WEB", name: "自检网页头显" });
  try {
    await page.click('#nav button[data-page="devices"]');
    await page.waitForSelector("#find-device", { timeout: 8000 });
    check("设备页有「按 IP 找头显」的输入口", (await page.textContent(".view")).includes("按 IP 找头显"));
    check("设备列表有「IP 地址」这一列", (await page.textContent(".view")).includes("IP 地址"));
    // 老师常常从 127.0.0.1 打开后台：这时候地址栏那个地址对头显是没用的（头显照抄就连到自己身上），
    // 面板和「该改成」都要照后台自己报的局域网地址说
    const shownBackend = (await page.textContent("#backend-url")).trim();
    const apiBackend = await page.evaluate(async () => (await (await fetch("/api/v1/devices")).json()).backendUrl);
    check("面板写的后台地址＝后台自己报的那个，不是地址栏", Boolean(shownBackend) && shownBackend === apiBackend,
      `面板 ${shownBackend}｜后台报 ${apiBackend}`);

    await page.fill('#find-device input[name="target"]', "教室第三排");
    await page.click("#find-device button");
    await page.waitForTimeout(700);
    check("填得不像 IP，就地给中文提示不白屏", (await page.textContent("#discovery-result")).includes("不像 IP"),
      (await page.textContent("#discovery-result")).replace(/\s+/g, " ").slice(0, 40));

    // 8790 上没人监听是最常见的一坑（PC 模拟没开播放模式 / 头显装的旧包），提示必须能接着干活
    const silent = await closedPort();
    await page.fill('#find-device input[name="target"]', `127.0.0.1:${silent}`);
    await page.click("#find-device button");
    await page.waitForTimeout(2500);
    const refused = (await page.textContent("#discovery-result")).replace(/\s+/g, " ");
    check("端口没人听时，提示直接给出下一步", refused.includes("拒了连接") && refused.includes("就是跑后台的这台电脑")
      && refused.includes("mock-pico"), refused.slice(0, 70));
    check("面板写清启动器没开时改走「登记头显」", (await page.textContent(".view")).includes("登记头显")
      && (await page.textContent(".view")).includes("头显上启动器正开着"),
      (await page.textContent(".view")).match(/问之前先确认[^。]*。/)?.[0]?.slice(0, 40) ?? "");
    // 老师最容易卡住的是「后台一直离线」：面板得写明头显会自己找后台，不是只能靠这边推地址
    check("面板写明头显会自己扫网段找后台", (await page.textContent(".view")).includes("自动找后台")
      && (await page.textContent(".view")).includes("自己扫本网段找后台"),
      (await page.textContent(".view")).match(/启动器连着几轮[^。]*。/)?.[0]?.slice(0, 40) ?? "");

    await page.fill('#find-device input[name="target"]', fakeHeadset.target);
    await page.click("#find-device button");
    await page.waitForSelector("#discovery-result table", { timeout: 15000 });
    const found = (await page.textContent("#discovery-result")).replace(/\s+/g, " ");
    check("填 IP 就能问到这台没登记的头显", found.includes("PICO-TEST-WEB") && found.includes("还没这台"), found.slice(0, 60));
    check("问到的型号、版本、应用数一并列出来", found.includes("PICO 4 Ultra Enterprise") && found.includes("v0.1.0"),
      found.slice(60, 130));
    check("问到的同时点出这台正在连哪个后台、连上没连上", found.includes("它正在连的后台")
      && found.includes("连不上这个后台") && found.includes("192.168.1.100"), found.slice(130, 230));
    await shot("13-PICO设备-按IP找到头显.png");

    await page.click('#discovery-result [data-act="adopt-device"]');
    await page.waitForSelector("#discovery-result .badge.on", { timeout: 15000 });
    check("点「收编进来」后这台标成已登记", (await page.textContent("#discovery-result")).includes("已登记"));
    await page.waitForTimeout(1500);
    check("收编完设备列表里就有这台", (await page.textContent(".view")).includes("自检网页头显"), "列表里出现「自检网页头显」");
    await shot("14-PICO设备-收编完成.png");

    // 收编只是后台认识了这台，它自己还不知道往哪儿心跳：这里必须写成「为什么离线 + 一键修」，不能光秃秃一个「离线」
    const viewText = (await page.textContent(".view")).replace(/\s+/g, " ");
    const pushButton = await page.$('.view [data-act="push-backend"]');
    check("刚收编的这台写明「从没往后台报到过」，不是光一个离线", viewText.includes("从没往后台报到过")
      && viewText.includes("让它连上后台"), viewText.match(/这台从没[^。]*。/)?.[0]?.slice(0, 40) ?? "没找到原因文案");
    check("离线那行带了「让它连上后台」的按钮", pushButton !== null, pushButton ? "按钮在" : "没按钮");
    // 排查话一写三四行，五台一起离线时表就挤得没法看了：折起来，但按钮不能跟着藏
    const folded = await page.$('.view details.why summary');
    check("离线原因折进「为什么离线？」，不是三行说明把表撑变形",
      folded !== null && (await page.$eval(".view details.why", (node) => node.open)) === false,
      folded ? (await page.textContent(".view details.why summary")).trim() : "没折叠，说明还摊在行里");
    check("折起来了但「让它连上后台」还摆在明面上", await page.isVisible('.view [data-act="push-backend"]'),
      "按钮点得到");
    if (pushButton) {
      await pushButton.click();
      await page.waitForTimeout(1500);
      const pushedText = (await page.textContent("body")).replace(/\s+/g, " ");
      check("点一下就把后台地址推给这台头显", pushedText.includes("已把后台地址推给这台头显"),
        pushedText.match(/已把后台地址推给[^！]{0,60}/)?.[0] ?? pushedText.slice(-80));
      check("推送之后假头显确实改了地址", (await fakeHeadset.state()).serverBaseUrl !== "http://192.168.1.100:8787",
        (await fakeHeadset.state()).serverBaseUrl);
    }

    const cleaned = await page.evaluate(async (serial) => {
      const { devices } = await fetch("/api/v1/devices").then((r) => r.json());
      const device = devices.find((item) => item.serial === serial);
      if (device) {
        await fetch(`/api/v1/devices/${device.id}`, { method: "DELETE" });
      }
      // 收编时顺手收进来的《自检体测教练》也要删：自检不该在老师的应用目录里留个假应用
      const { apps } = await fetch("/api/v1/apps").then((r) => r.json());
      for (const app of apps.filter((item) => String(item.packageName).startsWith("com.selftest."))) {
        await fetch(`/api/v1/apps/${app.id}`, { method: "DELETE" });
      }
      return device?.id ?? null;
    }, "PICO-TEST-WEB");
    check("自检收编的头显用完删掉，不脏下一次的表", cleaned !== null, `id=${cleaned}`);
    const leftovers = await page.evaluate(() =>
      fetch("/api/v1/apps")
        .then((r) => r.json())
        .then((d) => d.apps.filter((item) => String(item.packageName).startsWith("com.selftest.")).map((item) => item.name)),
    );
    check("收编扫进来的自检应用不留在老师的应用目录里", leftovers.length === 0,
      leftovers.length ? `还剩《${leftovers.join("、")}》` : "com.selftest.* 一个不剩");
  } finally {
    await fakeHeadset.stop();
  }
} catch (error) {
  check("跑完整流程没抛异常", false, error.message.split("\n")[0]);
} finally {
  console.log(results.join("\n"));
  console.log(`\n断言 ${results.filter((line) => line.startsWith("✅") || line.startsWith("❌")).length} 条，失败 ${failed} 条`);
  const real = errors.filter((line) => !line.includes("401"));
  console.log(real.length ? `页面报错：\n${real.join("\n")}` : "页面报错：无");
  if (wantShots) {
    console.log(`截图：${OUT}`);
  }
  await browser.close();
  process.exit(failed || real.length ? 1 : 0);
}
