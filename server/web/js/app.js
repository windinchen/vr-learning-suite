// 老师管理台：单页应用，无框架、无构建，全部走后台 /api/v1。
const state = {
  page: "dashboard",
  teacher: null,
  timer: null,
  tick: null,
  reports: { days: 7, groupBy: "app" },
  lessonId: null,
  lessonStartedAt: null,
  deviceApps: { deviceId: null, filter: "all", keyword: "" },
  apps: { showGone: false },
  discovery: null,
  // 学生页的搜索词 / 班级筛选 / 待导入名单：切到别的页再回来不用重新输一遍
  students: { keyword: "", classId: "", bulk: "" },
  // 后台自己的地址（由 /devices 带回来）。不能用地址栏那个：老师从 127.0.0.1 打开时，
  // 头显照抄就连到自己身上，越改越连不上
  backendUrl: "",
};
const el = (id) => document.getElementById(id);
const backendBase = () => state.backendUrl || location.origin;

const PAGES = [
  { id: "dashboard", icon: "📊", title: "总览", sub: "今天谁在用、用了多久、哪里不对劲" },
  { id: "devices", icon: "🥽", title: "PICO 设备", sub: "按 IP 找到头显收进来、锁定与下发指令（谁用哪台去「上课」页当堂定）" },
  { id: "lesson", icon: "🎥", title: "上课", sub: "看头显画面、当堂指定谁用哪台、这节课跑哪些应用" },
  { id: "device-apps", icon: "📱", title: "头显应用", sub: "扫头显装了哪些应用，逐台配能不能跑、每天跑多久" },
  { id: "students", icon: "🎓", title: "学生", sub: "名单、班级、批量导入与使用情况" },
  { id: "apps", icon: "🕹️", title: "应用与策略", sub: "应用由头显扫出来，配哪个能跑、跑多久、什么时段能跑" },
  { id: "reports", icon: "📈", title: "时长报表", sub: "按应用 / 学生 / 设备 / 日期统计" },
  { id: "audit", icon: "🧾", title: "操作日志", sub: "谁在什么时候改了什么" },
];

// 各处点按钮的回调都是 async，后台一报错原来就没人接：表现为「点了没反应」，只有控制台里有痕迹。
window.addEventListener("unhandledrejection", (event) => {
  const message = String(event.reason?.message ?? event.reason ?? "不知道的原因");
  toast(`没办成：${message}`, true);
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  const json = await response.json().catch(() => ({}));
  // 后台自己的地址随手记下来（/devices 带着它）：「该改成哪个地址」要说头显用得上那个，
  // 不是老师地址栏里的 127.0.0.1
  if (json?.backendUrl) {
    state.backendUrl = json.backendUrl;
  }
  if (response.status === 401) {
    showLogin(json.error);
    throw new Error(json.error ?? "未登录");
  }
  if (!response.ok) {
    toast(json.error ?? `请求失败（${response.status}）`, true);
    throw new Error(json.error ?? String(response.status));
  }
  return json;
}

function toast(message, bad = false) {
  const node = el("toast");
  node.textContent = message;
  node.className = `toast${bad ? " bad" : ""}`;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.add("hidden"), 2600);
}

function showLogin(message) {
  el("app").classList.add("hidden");
  el("login").classList.remove("hidden");
  if (message) {
    el("login-error").textContent = message;
  }
}

function showApp() {
  el("login").classList.add("hidden");
  el("app").classList.remove("hidden");
  el("who").innerHTML = `${esc(state.teacher.name)}<br><span class="muted">${esc(state.teacher.account)}</span>`;
  renderNav();
  load(true);
}

function renderNav() {
  el("nav").innerHTML = PAGES.map(
    (page) =>
      `<button data-page="${page.id}" class="${page.id === state.page ? "active" : ""}" title="${esc(page.title)}">
        <span>${page.icon}</span><span class="t">${esc(page.title)}</span></button>`,
  ).join("");
}

const fmtDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
};
const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }) : "—");
const timeAgo = (ts) => {
  if (!ts) return "从未上线";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
};
/** 学生页「看明细」展开后的那一块：先说这段时间的总数，再列每个应用，最后是能展开的逐条记录。 */
const usageHtml = (data) => {
  const head = `近 ${data.days} 天`;
  if (!data.apps.length) {
    return `<div class="muted">${head}没跑过应用${
      data.sessions.length
        ? `。最近一次是「${esc(data.sessions[0].app)}」，${timeAgo(data.sessions[0].startedAt)}，跑了 ${fmtDuration(
            data.sessions[0].seconds,
          )}`
        : "，一条记录都还没有"
    }。</div>`;
  }
  return `<div>${head}共 ${fmtDuration(data.rangeSeconds)}｜跑了 ${data.apps.length} 个应用</div>
    <table><thead><tr><th>应用</th><th class="num">时长</th><th class="num">次数</th><th>最近一次</th></tr></thead><tbody>
    ${data.apps
      .map(
        (row) =>
          `<tr><td>${esc(row.name)}</td><td class="num">${fmtDuration(row.seconds)}</td><td class="num">${
            row.sessions
          }</td><td class="muted">${timeAgo(row.lastAt)}</td></tr>`,
      )
      .join("")}
    </tbody></table>
    <details class="why"><summary>展开最近 ${data.sessions.length} 条记录</summary><div>${data.sessions
      .map(
        (row) =>
          `<div class="line">${new Date(row.startedAt).toLocaleString("zh-CN", {
            hour12: false,
          })}｜${esc(row.app)}｜${fmtDuration(row.seconds)}｜${esc(row.device)}${
            row.lesson ? `｜《${esc(row.lesson)}》` : ""
          }</div>`,
      )
      .join("")}</div></details>`;
};
const ABNORMAL = {
  offline: { label: "离线", badge: "off" },
  locked: { label: "锁定中", badge: "lock" },
  scan: { label: "应用对不上", badge: "bad" },
  lesson: { label: "课没定头显", badge: "bad" },
};

const installBadge = (item) => {
  if (item.installState === "installed") return '<span class="badge on"><i class="dot"></i>已安装</span>';
  if (item.installState === "missing") return '<span class="badge bad"><i class="dot"></i>未安装</span>';
  return '<span class="badge off">未扫描</span>';
};

const statusBadge = (device) => {
  if (device.status === "locked") return '<span class="badge lock"><i class="dot"></i>已锁定</span>';
  if (device.status === "disabled") return '<span class="badge bad"><i class="dot"></i>已停用</span>';
  return device.online
    ? '<span class="badge on"><i class="dot"></i>在线</span>'
    : '<span class="badge off"><i class="dot"></i>离线</span>';
};

/** 「按 IP 找头显」的结果区。结果存在 state.discovery 里，8 秒一次的自动刷新才不会把它冲掉。 */
function discoveryPanel() {
  const disc = state.discovery;
  return `<div class="panel"><h3>按 IP 找头显<span class="muted">头显开着启动器就会答话，不用先在后台登记</span></h3>
    <p class="hint">这台后台的地址是 <code id="backend-url">${esc(backendBase())}</code>
      <button class="mini" data-act="copy-backend-url">复制</button>
      —— 头显「设置 → 后台地址」要填的就是它。填的还是打包默认的 <code>http://192.168.1.100:8787</code> 之类，
      这台就连不上你，设备页会一直写着「从没往后台报到过」。不过现在不用你去救它：
      启动器连着几轮连不上会自己扫本网段找后台并改过来，也可以戴上头显在「设置」页点「自动找后台」马上扫一次。</p>
    <form id="find-device" class="form-grid">
      <label>头显 IP 或网段前缀<input name="target" type="text" placeholder="192.168.1.20，或整段 192.168.1" value="${esc(
        disc?.target ?? "",
      )}" required /></label>
      <button class="primary" style="margin:0" ${disc?.busy ? "disabled" : ""}>${disc?.busy ? "正在问…" : "开始找"}</button>
    </form>
    <div id="discovery-result">${discoveryResult(disc)}</div>
    <p class="hint">后台反过来敲头显的 8790 问一句「你是谁、装着什么」，问到就能直接收进来，连它装的应用一起报上来。
    头显的 IP 在启动器「设置」页的本机信息卡最后一行。填网段前缀（比如 <code>192.168.1</code>）会把 .1~.254 挨个问一遍，机房里第一次铺机器时用这个。</p>
    <p class="hint">问之前先确认<b>头显上启动器正开着</b>——答话的是启动器，不是系统。
    报「拒了连接」就是那台的 8790 没人听：要么启动器没开（本机模拟就是 Unity 播放模式没开），要么它版本太旧、还没有这个问话口。
    旧启动器那台先走上面「登记头显」手填序列号，进来之后心跳、管控、时长统计全都一样能用。</p>
  </div>`;
}

function discoveryResult(disc) {
  if (!disc) return '<div class="empty">还没找过。填一台头显的 IP，或者填网段前缀整段扫一遍。</div>';
  if (disc.busy) return `<div class="empty">正在问 ${esc(disc.target)}…${disc.target.includes("*") ? "（整段 254 个地址，要几秒）" : ""}</div>`;
  const result = disc.result;
  if (!result) return '<div class="empty">还没找过。</div>';
  if (!result.found.length) {
    return `<div class="empty"><b>一台都没问到</b><br><span class="muted">${esc(
      result.reason ?? `问了 ${result.scanned} 个地址，都没答话（启动器没开、端口不通，或者不在同一个网段）`,
    )}</span></div>`;
  }
  return `<table><thead><tr><th>名称</th><th>序列号</th><th>型号 / 版本</th><th>地址</th><th>它正在连的后台</th><th class="num">应用</th><th class="num">电量</th><th>后台登记</th><th class="num">操作</th></tr></thead><tbody>
    ${result.found
      .map(
        (item) => `<tr>
          <td><b>${esc(item.name)}</b>${item.foregroundApp ? `<br><span class="muted">正在跑 ${esc(item.foregroundApp)}</span>` : ""}</td>
          <td class="mono">${esc(item.serial)}</td>
          <td class="muted">${esc(item.model)} · v${esc(item.launcherVersion)}</td>
          <td class="mono">${esc(item.host)}:${item.port}</td>
          <td>${backendCell(item)}</td>
          <td class="num">${item.appCount}</td>
          <td class="num">${item.battery === null || item.battery === undefined ? "—" : item.battery + "%"}</td>
          <td>${
            item.known
              ? `<span class="badge on"><i class="dot"></i>已登记 #${item.known.id}</span>`
              : '<span class="badge off">还没这台</span>'
          }</td>
          <td class="num"><button class="mini${item.known ? "" : " primary"}" data-act="adopt-device" data-target="${esc(
          `${item.host}:${item.port}`,
        )}" data-name="${esc(item.name)}">${item.known ? "重新收编" : "收编进来"}</button></td>
        </tr>`,
      )
      .join("")}
    </tbody></table>`;
}

/** 这台启动器正在连哪个后台、连上没连上：收编完却一直「离线」的，原因基本都在这栏里。 */
const backendCell = (item) => {
  if (!item.serverBaseUrl) {
    return '<span class="muted">没报（启动器太旧）</span>';
  }
  const want = backendBase();
  const fix = item.serverBaseUrl !== want ? `<br><span class="muted">该改成 <code>${esc(want)}</code></span>` : "";
  return item.backendOnline
    ? `${esc(item.serverBaseUrl)}<br><span class="badge on"><i class="dot"></i>已连上</span>`
    : `<span class="badge bad"><i class="dot"></i>连不上这个后台</span><br><span class="muted mono">${esc(
        item.serverBaseUrl,
      )}</span>${fix}<br><span class="muted">启动器会自己扫网段重找，也可在头显「设置」里点「自动找后台」</span>`;
};

/** 问一轮 IP，结果写进 state 再局部重画，别把老师正在填的别的输入框吞掉。 */
async function runDiscovery(target) {
  state.discovery = { target, busy: true, result: null };
  const slot = el("discovery-result");
  if (slot) {
    slot.innerHTML = discoveryResult(state.discovery);
  }
  const result = await api("/devices/discover", { method: "POST", body: { target } });
  state.discovery = { target, busy: false, result };
  const after = el("discovery-result");
  if (after) {
    after.innerHTML = discoveryResult(state.discovery);
  }
  return result;
}

async function load(silent = false) {
  const page = PAGES.find((item) => item.id === state.page);
  el("page-title").textContent = page.title;
  el("page-sub").textContent = page.sub;
  if (!silent) toast("已刷新");
  try {
    el("view").innerHTML = '<div class="empty">正在读取…</div>';
    await RENDER[state.page]();
  } catch (error) {
    el("view").innerHTML = `<div class="panel"><b>加载失败</b><div class="muted">${esc(error.message)}</div></div>`;
  }
}

const RENDER = {
  // ---------- 总览 ----------
  async dashboard() {
    const data = await api("/dashboard");
    const t = data.totals;
    const maxTrend = Math.max(1, ...data.trend.map((row) => row.seconds));
    const maxApp = Math.max(1, ...data.todayByApp.map((row) => row.seconds));
    el("view").innerHTML = `
      <div class="cards">
        <div class="card accent"><div class="label">在线头显</div><div class="kpi">${t.onlineDevices}<span class="muted" style="font-size:15px"> / ${t.devices}</span></div></div>
        <div class="card"><div class="label">学生数（启用）</div><div class="kpi">${t.activeStudents}<span class="muted" style="font-size:15px"> / ${t.students}</span></div></div>
        <div class="card"><div class="label">今日总时长</div><div class="kpi">${fmtDuration(t.todaySeconds)}</div></div>
        <div class="card"><div class="label">已上架应用</div><div class="kpi">${t.enabledApps}<span class="muted" style="font-size:15px"> / ${t.apps}</span></div></div>
        <div class="card"><div class="label">头显新发现待确认</div><div class="kpi">${t.reviewApps}<span class="muted" style="font-size:15px"> / ${t.discoveredApps}</span></div></div>
        <div class="card"><div class="label">今日越权打开</div><div class="kpi">${t.violationsToday}</div></div>
      </div>
      <div class="grid-2">
        <div class="panel"><h3>近 7 天使用时长</h3>
          <div class="bars">${data.trend
            .map(
              (row) =>
                `<div class="col" title="${esc(row.date)}：${fmtDuration(row.seconds)}"><i style="height:${Math.round(
                  (row.seconds / maxTrend) * 118,
                )}px"></i><small>${esc(row.date.slice(5))}</small></div>`,
            )
            .join("")}</div>
        </div>
        <div class="panel"><h3>今日各应用时长</h3>${
          data.todayByApp.length
            ? data.todayByApp
                .map(
                  (row) =>
                    `<div class="bar-row"><span>${esc(row.app_name)}</span><div class="bar"><i style="width:${Math.round(
                      (row.seconds / maxApp) * 100,
                    )}%"></i></div><span class="num muted">${fmtDuration(row.seconds)}</span></div>`,
                )
                .join("")
            : '<div class="empty">今天还没有使用记录</div>'
        }</div>
      </div>
      ${
        data.lessons.length
          ? `<div class="panel lesson-card"><h3>正在上课<span class="muted">${data.lessons.length} 节</span></h3>
            <div class="stack">${data.lessons
              .map(
                (item) => `<div class="row-controls"><b>${esc(item.icon ?? "🎥")} ${esc(item.title)}</b>
                  <span class="muted">${esc(item.className ?? "不分班")} · ${esc(item.teacher ?? "")} · 已上 ${fmtDuration(
                  Math.round((Date.now() - item.startedAt) / 1000),
                )}</span>
                  <span class="badge on"><i class="dot"></i>${item.assignedCount}/${item.deviceCount} 台已定使用者</span>
                  <button class="mini" data-act="open-lesson">进课堂</button></div>`,
              )
              .join("")}</div></div>`
          : ""
      }
      <div class="grid-2">
        <div class="panel"><h3>学生今日排行</h3>
          <table><thead><tr><th>学生</th><th>班级</th><th>设备</th><th class="num">今日时长</th></tr></thead><tbody>
          ${data.perStudent
            .map(
              (row) =>
                `<tr><td><b>${esc(row.name)}</b> <span class="muted mono">${esc(row.studentNo)}</span></td>
                 <td class="muted">${esc(row.class?.name ?? "未分班")}</td>
                 <td>${row.device ? statusBadge(row.device) : '<span class="badge">未绑定</span>'}</td>
                 <td class="num">${fmtDuration(row.todaySeconds)}</td></tr>`,
            )
            .join("")}
          </tbody></table>
        </div>
        <div class="panel"><h3>需要关注<span class="muted">${data.abnormal.length} 项</span></h3>
          ${
            data.abnormal.length
              ? data.abnormal
                  .map(
                    (row) =>
                      `<div class="stack"><div class="badge ${ABNORMAL[row.type]?.badge ?? "lock"}"><i class="dot"></i>${
                        esc(ABNORMAL[row.type]?.label ?? row.type)
                      }</div><div><b>${esc(row.name)}</b> <span class="muted">${esc(row.detail)}</span></div></div>`,
                  )
                  .join("")
              : '<div class="empty">一切正常 ✅</div>'
          }
        </div>
      </div>
      <div class="panel"><h3>数据维护<span class="muted">清空后头显重新扫描就重新开始统计</span></h3>
        <form id="reset-form" class="form-grid">
          <label>清空范围<select name="scope">
            <option value="run">只清运行数据（保留班级 / 学生 / 头显 / 应用清单）</option>
            <option value="all">全部清空（只剩老师账号）</option>
          </select></label>
          <button class="primary" style="margin:0">清空数据</button>
        </form>
        <p class="hint">清掉时长流水、心跳、越权记录、头显应用扫描结果与策略，并删掉自检专用头显；<b>应用目录原样保留</b>
        （清单一律由头显扫出来，删了就得让头显重扫一遍），要逐台管装了什么去「头显应用」页，要删应用去「应用与策略」页。
        头显端如果还压着没上报的时长，联网后会补回来；要连它一起清就在 Mac 上跑 <code>node scripts/reset-data.mjs</code>。</p>
      </div>`;
    el("reset-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const scope = String(new FormData(event.target).get("scope"));
      const tip =
        scope === "all"
          ? "确定清空全部数据（含班级、学生、头显、应用清单）？只保留老师账号，不能撤销。"
          : "确定清空模拟数据（时长、心跳、越权、扫描清单、策略）？班级 / 学生 / 头显 / 应用清单会保留。";
      if (!window.confirm(tip)) {
        return;
      }
      await api("/admin/reset", { method: "POST", body: { scope } });
      toast(scope === "all" ? "已清空全部数据，只剩老师账号" : "已清空模拟数据");
      load(true);
    });
  },

  // ---------- 设备 ----------
  async devices() {
    const { devices } = await api("/devices");
    el("view").innerHTML = `${discoveryPanel()}
    <div class="panel">
      <h3>已登记头显<span class="muted">${devices.length} 台</span></h3>
      <table><thead><tr><th>名称</th><th>序列号</th><th>IP 地址</th><th>本节课使用者</th><th>状态</th><th>头显应用</th><th class="num">电量</th><th>最后心跳</th><th class="num">操作</th></tr></thead><tbody>
      ${devices
        .map(
          (device) => `<tr>
            <td><b>${esc(device.name)}</b><br><span class="muted">${esc(device.model ?? "")} · v${esc(
              device.launcherVersion ?? "-",
            )}</span></td>
            <td class="mono">${esc(device.serial)}</td>
            <td class="mono">${
              device.ip
                ? `${esc(device.ip)}<br><span class="muted">${
                    device.lastProbeAt ? `${timeAgo(device.lastProbeAt)}问到` : "没按 IP 问过"
                  }</span>`
                : '<span class="muted">没登记地址</span>'
            }</td>
            <td>${
              device.student
                ? `<b>${esc(device.student.name)}</b><br><span class="muted">${esc(device.lesson?.title ?? "")}</span>`
                : `<span class="muted">${device.lesson ? "这节课还没定" : "不在课上"}</span>`
            }</td>
            <td>${statusBadge(device)}${device.pendingCommands ? ` <span class="badge">待下发 ${device.pendingCommands}</span>` : ""}${
              device.online
                ? ""
                : // 排查话一写就是三四行，五台头显一起离线时整张表被它挤得没法看：
                  // 收起来留一句话，「让它连上后台」这颗按钮照常摆在明面上
                  `<br><details class="why"><summary>为什么离线？</summary><div class="muted">${esc(
                    device.offlineReason ?? "离线",
                  )}${device.lastHeartbeatAt ? `（最后心跳 ${timeAgo(device.lastHeartbeatAt)}）` : ""}</div></details>${
                      device.ip
                        ? `<br><button class="mini" data-act="push-backend" data-id="${device.id}">让它连上后台</button>`
                        : ""
                    }`
            }</td>
            <td><button class="mini" data-act="open-apps" data-id="${device.id}">已装 ${device.installedApps} 个</button>
                ${device.violationsToday ? ` <span class="badge bad">越权 ${device.violationsToday}</span>` : ""}
                <br><span class="muted">${device.appMode === "open" ? "自由运行" : "只许清单内应用"}</span></td>
            <td class="num">${device.battery === null ? "—" : device.battery + "%"}</td>
            <td class="muted">${timeAgo(device.lastSeen)}</td>
            <td class="num">
              ${
                device.status === "locked"
                  ? `<button class="mini" data-act="cmd" data-id="${device.id}" data-type="unlock">解锁</button>`
                  : `<button class="mini danger" data-act="cmd" data-id="${device.id}" data-type="lock">锁定</button>`
              }
              <button class="mini" data-act="cmd" data-id="${device.id}" data-type="refresh">刷新策略</button>
              <button class="mini" data-act="cmd" data-id="${device.id}" data-type="scan">重扫应用</button>
              <button class="mini" data-act="say" data-id="${device.id}" data-name="${esc(device.name)}">带句话</button>
              <button class="mini" data-act="cmd" data-id="${device.id}" data-type="restart">重新登记</button>
              <button class="mini" data-act="rename" data-id="${device.id}">改名</button>
              <button class="mini danger" data-act="device-delete" data-id="${device.id}" data-name="${esc(device.name)}">删除</button>
            </td></tr>`,
        )
        .join("")}
      </tbody></table>
      <p class="hint">「让它连上后台」是敲头显的 8790 把本后台的地址推给它——启动器打包时写的默认地址是占位的，
      新收编的头显不推就永远连不上（收编那一步已经推过一次，这里给当时推失败、或后来换了网的补用）。
      头显不绑学生：去「上课」页开一节课，当堂指定谁用哪台、能跑哪些应用，使用记录自动算到那个学生头上。
          锁定后学生端会停在锁定页并提示原因；「刷新策略」让头显立刻重新拉取应用清单；「重扫应用」让头显重新读一遍装了哪些应用。
          「带句话」会把字直接打在这台头显首页的横幅上（停 45 秒，学生不用摘头显就能看到）；「重新登记」让这台重新向后台要一份令牌，
          换后台或登记不上时才用。「头显应用」页可以逐台管控允许运行哪些、每天最多跑多久。</p>
    </div>`;
    el("find-device").addEventListener("submit", async (event) => {
      event.preventDefault();
      const target = String(new FormData(event.target).get("target") ?? "").trim();
      try {
        const result = await runDiscovery(target);
        toast(result.found.length ? `问到 ${result.found.length} 台，点「收编进来」就能用` : "一台都没问到");
      } catch (error) {
        // 后台没问到不给原因时（网络层直接错）也得让老师看见是哪儿断的
        state.discovery = { target, busy: false, result: { scanned: 0, found: [], reason: error.message } };
        const slot = el("discovery-result");
        if (slot) {
          slot.innerHTML = discoveryResult(state.discovery);
        }
      }
    });
  },

  // ---------- 上课 ----------
  async lesson() {
    const [{ devices }, { students }, { apps }, { lesson }, { lessons }] = await Promise.all([
      api("/devices"),
      api("/students"),
      api("/apps"),
      api("/lessons/active"),
      api("/lessons?limit=6"),
    ]);
    const managed = apps.filter((app) => app.managed);

    if (!lesson) {
      el("view").innerHTML = `
      <div class="panel"><h3>开课<span class="muted">开课后头显立刻收到这节课的安排</span></h3>
        <form id="start-lesson">
          <div class="form-grid">
            <label>课程名称<input name="title" type="text" placeholder="如 初三 VR 体育课" required /></label>
            <label>班级<select name="classId"><option value="">不分班</option>${students
              .filter((item, index, all) => item.class && all.findIndex((x) => x.class.id === item.class.id) === index)
              .map((item) => `<option value="${item.class.id}">${esc(item.class.name)}</option>`)
              .join("")}</select></label>
            <label>备注<input name="note" type="text" placeholder="可选，写在课堂记录里" /></label>
          </div>
          <div class="pick-grid">
            <div class="pick-col"><div class="pick-title">参加的头显<span class="muted">${devices.length} 台</span></div>
              ${
                devices.length
                  ? devices
                      .map(
                        (device) => `<label class="pick"><input type="checkbox" name="deviceIds" value="${device.id}" />
                          <span><b>${esc(device.name)}</b> ${statusBadge(device)}
                          <span class="muted mono">${esc(device.serial)}</span></span></label>`,
                      )
                      .join("")
                  : '<div class="empty">先去「PICO 设备」页登记头显</div>'
              }
            </div>
            <div class="pick-col"><div class="pick-title">这节课能跑的应用<span class="muted">全不勾 = 跟后台清单一致</span></div>
              ${managed
                .map(
                  (app) => `<label class="pick"><input type="checkbox" name="appKeys" value="${esc(app.key)}" />
                    <span><b>${esc(app.icon)} ${esc(app.name)}</b> <span class="muted">${esc(app.category ?? "")}</span></span></label>`,
                )
                .join("")}
            </div>
          </div>
          <button class="primary" style="margin-top:12px">开课</button>
        </form>
        <p class="hint">开课后每次把学生派到某台头显，这台头显之后跑出来的时长就记到那个学生头上；换人之后新记录算新学生的，之前的记录不改。</p>
      </div>
      <div class="panel"><h3>最近上的课<span class="muted">记录永久保留</span></h3>${
        lessons.length
          ? `<table><thead><tr><th>课程</th><th>班级</th><th>上课时间</th><th class="num">头显</th><th class="num">学生</th><th class="num">总时长</th><th>状态</th></tr></thead><tbody>
        ${lessons
          .map(
            (item) => `<tr>
              <td><b>${esc(item.title)}</b></td>
              <td class="muted">${esc(item.className ?? "—")}</td>
              <td class="muted">${new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false })}</td>
              <td class="num">${item.deviceCount}</td>
              <td class="num">${item.studentCount}</td>
              <td class="num">${fmtDuration(item.seconds)}</td>
              <td>${
                item.status === "active"
                  ? '<span class="badge on"><i class="dot"></i>上课中</span>'
                  : '<span class="badge off">已下课</span>'
              }</td></tr>`,
          )
          .join("")}
        </tbody></table>`
          : '<div class="empty">还没有上课记录。开课之后这里会留下每节课的头显数、学生数和总时长。</div>'
      }</div>`;
      el("start-lesson").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const result = await api("/lessons", {
          method: "POST",
          body: {
            title: form.get("title"),
            classId: form.get("classId") ? Number(form.get("classId")) : null,
            note: form.get("note"),
            deviceIds: form.getAll("deviceIds").map(Number),
            appKeys: form.getAll("appKeys"),
          },
        });
        state.lessonId = result.id;
        toast(`已开课：${result.title}`);
        load(true);
      });
      return;
    }

    const seatOptions = (device) =>
      `<option value="">还没定</option>` +
      students
        .map(
          (student) =>
            `<option value="${student.id}" ${device.student?.id === student.id ? "selected" : ""}>${esc(
              student.name,
            )}（${esc(student.studentNo)}）${
              student.status !== "active" ? " · 已停用，点了这台会被锁住" : ""
            }${student.device && student.device.id !== device.deviceId ? " · 已在别的头显" : ""}</option>`,
        )
        .join("");
    const allowedKeys = new Set(lesson.appKeys ?? managed.map((app) => app.key));
    // 还没进这节课的头显：开课那天没开机、或者后来才登记的都是这种情况
    const onLesson = new Set(lesson.devices.map((device) => device.deviceId));
    const spare = devices.filter((device) => !onLesson.has(device.id));

    el("view").innerHTML = `
      <div class="panel lesson-top">
        <div>
          <h3 style="margin:0">${esc(lesson.title)}<span class="muted">${esc(lesson.className ?? "不分班")}</span></h3>
          <div class="muted" id="lesson-clock">已上 ${fmtDuration(Math.round((Date.now() - lesson.startedAt) / 1000))}
            · ${lesson.totals.assigned}/${lesson.totals.devices} 台已定使用者 · 在线 ${lesson.totals.online} 台
            · 累计 ${fmtDuration(lesson.totals.seconds)} · ${lesson.totals.students} 个学生有记录</div>
        </div>
        <div class="row-controls">
          <button class="mini" data-act="lesson-refresh">刷新</button>
          <button class="mini danger" data-act="lesson-end" data-id="${lesson.id}">下课</button>
        </div>
      </div>

      <div class="panel"><h3>这节课能跑的应用<span class="muted">${
        lesson.appKeys && lesson.appKeys.length ? `已限定 ${lesson.appKeys.length} 个` : "跟后台清单一致"
      }</span></h3>
        <form id="lesson-apps" class="chips">
          ${managed
            .map(
              (app) => `<label class="chip ${allowedKeys.has(app.key) ? "on" : ""}">
                <input type="checkbox" name="appKeys" value="${esc(app.key)}" ${allowedKeys.has(app.key) ? "checked" : ""} />
                ${esc(app.icon)} ${esc(app.name)}</label>`,
            )
            .join("")}
          <button class="mini" style="margin:0">应用到这节课</button>
        </form>
      </div>

      <div class="panel"><h3>参加的头显<span class="muted">${lesson.totals.devices} 台在课上${
        spare.length ? `｜还有 ${spare.length} 台没加进来` : "｜所有头显都在这节课里了"
      }</span></h3>${
        spare.length
          ? `<div class="pick-grid"><div class="pick-col">${spare
              .map(
                (device) => `<div class="pick"><span><b>${esc(device.name)}</b> ${statusBadge(device)}
                  <span class="muted mono">${esc(device.serial)}</span></span>
                  <button class="mini" data-act="lesson-add-device" data-id="${lesson.id}" data-device="${device.id}">加进这节课</button></div>`,
              )
              .join("")}</div></div>`
          : '<div class="empty">没有可加的头显了。新登记的头显会出现在这里。</div>'
      }
        <p class="hint">开课之后新到的头显、或者开课那天没电没开机的，都在这里补加进去；加进来之后它按这节课的应用清单走（10 秒内生效）。</p>
      </div>

      <div class="lesson-wall">
        ${lesson.devices.length === 0
          ? '<div class="empty panel" style="grid-column:1/-1"><b>这节课还没定头显</b>：头显那边完全不受这节课管，时长也不会记到学生头上。用上面「参加的头显」把头显加进来。</div>'
          : lesson.devices
          .map(
            (device) => `<div class="seat">
              <div class="screen">
                <img data-screen="${device.deviceId}" alt="${esc(device.name)}的实时画面"
                  src="/api/v1/devices/${device.deviceId}/screen${device.screen ? `?ts=${device.screen.ts}` : ""}" />
                <div class="no-frame ${device.screen ? "hidden" : ""}">${device.online ? "等头显传画面…" : "这台离线了，没画面"}</div>
                <div class="screen-tag">${statusBadge(device)}${device.battery !== null && device.battery >= 0 ? ` <span class="badge">${device.battery}%</span>` : ""}</div>
              </div>
              <div class="seat-body">
                <div class="seat-head"><b>${esc(device.name)}</b><span class="muted mono">${esc(device.serial)}</span></div>
                <label class="seat-who">使用者
                  <select data-act="lesson-assign" data-device="${device.deviceId}">${seatOptions(device)}</select>
                </label>
                <div class="seat-apps">${
                  device.appKeys
                    ? `本机限定 ${device.appKeys.length} 个：${device.appKeys
                        .map((key) => {
                          const app = managed.find((item) => item.key === key);
                          return app ? `${esc(app.icon)} ${esc(app.name)}` : esc(key);
                        })
                        .join("、")}`
                    : "本机跟随整节课的应用清单"
                }</div>
                <div class="seat-meta">
                  <span>本机时长 <b>${fmtDuration(device.usedSeconds)}</b> · 打开 ${device.sessions} 次</span>
                  <span class="muted">画面 ${device.screen ? timeAgo(device.screen.ts) : "从未"} · 心跳 ${timeAgo(device.lastSeen)}</span>
                </div>
              </div>
            </div>`,
          )
          .join("")}
      </div>

      <div class="panel"><h3>这节课的记录<span class="muted">时长已按当堂分配算到学生头上</span></h3>${
        lesson.summary.length
          ? `<table><thead><tr><th>学生</th><th>头显</th><th>应用</th><th class="num">打开次数</th><th class="num">时长</th><th>最近</th></tr></thead><tbody>
        ${lesson.summary
          .map(
            (row) => `<tr>
              <td><b>${esc(row.student?.name ?? "没定使用者")}</b> <span class="muted mono">${esc(row.student?.studentNo ?? "")}</span></td>
              <td class="muted">${esc(row.device ?? "—")}</td>
              <td>${esc(row.icon ?? "")} ${esc(row.app)}</td>
              <td class="num">${row.sessions}</td>
              <td class="num">${fmtDuration(row.seconds)}</td>
              <td class="muted">${fmtClock(row.lastEnd)}</td></tr>`,
          )
          .join("")}
        </tbody></table>`
          : '<div class="empty">这节课还没有使用记录。把头显分给学生，学生在头显里打开应用就会出现。</div>'
      }</div>`;

    el("lesson-apps").addEventListener("submit", async (event) => {
      event.preventDefault();
      const keys = new FormData(event.target).getAll("appKeys");
      await api(`/lessons/${lesson.id}/apps`, { method: "POST", body: { appKeys: keys } });
      toast(keys.length ? `这节课只许跑 ${keys.length} 个应用` : "已恢复成跟后台清单一致");
      load(true);
    });
    el("lesson-apps").addEventListener("change", (event) => {
      const chip = event.target.closest(".chip");
      if (chip) {
        chip.classList.toggle("on", event.target.checked);
      }
    });
    state.lessonId = lesson.id;
    state.lessonStartedAt = lesson.startedAt;
  },

  // ---------- 头显应用：逐台扫描、逐台配应用策略 ----------
  async "device-apps"() {
    const { devices } = await api("/devices");
    if (!devices.length) {
      el("view").innerHTML = '<div class="panel"><div class="empty">还没有登记头显，先去「PICO 设备」页登记一台。</div></div>';
      return;
    }
    const picked = devices.some((item) => item.id === state.deviceApps.deviceId)
      ? state.deviceApps.deviceId
      : devices[0].id;
    state.deviceApps.deviceId = picked;
    const data = await api(`/devices/${picked}/apps`);
    const d = data.device;
    const live = devices.find((item) => item.id === picked) ?? {};
    const appNamed = (pkg) =>
      [...data.items, ...data.unmanaged].find((item) => item.packageName === pkg)?.name ?? pkg ?? "—";
    const count = (fn) => data.items.filter(fn).length;
    const installedCount = count((item) => item.installState === "installed");
    const missingCount = count((item) => item.installState === "missing");
    const unknownCount = count((item) => item.installState === "unknown");
    const blockedCount = count((item) => item.allowed === false);
    const pending = Number(live.pendingCommands ?? 0);

    const allowedSelect = (item) =>
      `<select data-act="dev-allow" data-app="${item.id}">
        <option value="" ${item.deviceAllowed === null ? "selected" : ""}>跟随默认</option>
        <option value="1" ${item.deviceAllowed === true ? "selected" : ""}>允许</option>
        <option value="0" ${item.deviceAllowed === false ? "selected" : ""}>禁止</option>
      </select>`;
    const limitSelect = (item) =>
      `<select data-act="dev-limit" data-app="${item.id}">
        <option value="" ${item.deviceDailyMinutes === null ? "selected" : ""}>不限</option>
        ${[10, 15, 20, 30, 45, 60, 90]
          .map((m) => `<option value="${m}" ${item.deviceDailyMinutes === m ? "selected" : ""}>${m} 分钟</option>`)
          .join("")}
      </select>`;
    // 没有「系统应用」这一列筛选：系统应用（桌面、商店）按规矩不进管理清单，它们列在下面的「清单外的应用」面板里
    const row = (item) => `<tr data-app="${item.id}" data-state="${item.installState}" data-allow="${
      item.allowed ? "yes" : "no"
    }" data-installed="${item.installState === "installed" ? 1 : 0}" data-text="${esc(
      `${item.name} ${item.packageName}`.toLowerCase(),
    )}">
      <td><b>${esc(item.icon ?? "📦")} ${esc(item.name)}</b><br><span class="muted mono">${esc(
      item.packageName,
    )}</span></td>
      <td>${esc(item.deviceVersion || item.installedVersion || item.version || "—")}<br><span class="muted">${
        item.lastScanAt ? `${timeAgo(item.lastScanAt)}扫到` : "这台头显没扫到"
      }</span></td>
      <td>${installBadge(item)}${item.reason ? `<br><span class="muted">${esc(item.reason)}</span>` : ""}</td>
      <td>${allowedSelect(item)}</td>
      <td>${limitSelect(item)}</td>
      <td class="num">${item.usedMinutes} 分${
        item.remainingMinutes !== null && item.remainingMinutes !== undefined
          ? `<br><span class="muted">还剩 ${item.remainingMinutes} 分</span>`
          : ""
      }</td>
      <td class="num">${item.launchCount ?? 0}</td>
      <td class="num">${
        item.installState === "installed"
          ? `<button class="mini danger" data-act="local-app-delete" data-id="${d.id}" data-pkg="${esc(
              item.packageName,
            )}" data-name="${esc(item.name)}" title="只删这台头显的扫描记录，头显重新扫描后它会再出现">删扫描记录</button>`
          : `<button class="mini danger" data-act="app-delete" data-id="${item.id}" data-name="${esc(
              item.name,
            )}" title="这台头显上没装着它，没有扫描记录可删；把它从管理清单里删掉，策略和各台的扫描记录一起清">从清单删除</button>`
      }</td></tr>`;

    const chip = (key, label, n) =>
      `<button class="chip ${state.deviceApps.filter === key ? "on" : ""}" data-filter="${key}">${label}<b>${n}</b></button>`;

    el("view").innerHTML = `
      <div class="panel"><h3>选一台头显<span class="muted">共 ${devices.length} 台 · 每台各扫各的、各配各的策略</span></h3>
        <div class="dev-strip">${devices
          .map(
            (item) => `<button class="dev-tab ${item.id === d.id ? "on" : ""}" data-device="${item.id}">
              <b>${esc(item.name)}</b>
              <small>${item.online ? "🟢 在线" : "⚪ 离线"} · 已装 ${item.installedApps} 个${
              item.violationsToday ? ` · 越权 ${item.violationsToday}` : ""
            }</small>
              <small>${item.scannedAt === undefined ? "" : ""}${
              item.lastScanAt ? `最近扫描 ${timeAgo(item.lastScanAt)}` : "还没扫描过"
            }${item.student ? ` · ${esc(item.student.name)}在用` : ""}</small>
            </button>`,
          )
          .join("")}</div>${
      d.online
        ? ""
        : `<p class="hint"><b>这台现在离线</b>：${esc(
            d.offlineReason ?? "联系不上",
          )}。${d.ip ? `<button class="mini" data-act="push-backend" data-id="${d.id}">让它连上后台</button>` : ""}</p>`
    }
      </div>

      <div class="panel"><h3>${esc(d.name)} 装了哪些应用<span class="muted mono">${esc(d.serial)}</span></h3>
        <div class="cards">
          <div class="card"><div class="kpi">${data.items.length}</div><div class="label">管理清单里的应用</div></div>
          <div class="card accent"><div class="kpi">${installedCount}</div><div class="label">这台已装</div></div>
          <div class="card"><div class="kpi">${missingCount}</div><div class="label">清单里但没装</div></div>
          <div class="card"><div class="kpi">${blockedCount}</div><div class="label">现在不许运行</div></div>
          <div class="card"><div class="kpi">${live.violationsToday ?? 0}</div><div class="label">今日越权被拦</div></div>
        </div>
        <div class="row-controls dev-meta">
          <label class="muted">这台的控制方式
            <select data-act="device-mode">
              <option value="allowlist" ${d.appMode === "allowlist" ? "selected" : ""}>白名单：只许跑清单里的应用</option>
              <option value="open" ${d.appMode === "open" ? "selected" : ""}>自由运行：装了就能跑</option>
            </select>
          </label>
          <button class="mini dev-scan" id="devapp-scan">🔄 扫描这台头显</button>
          <button class="mini" data-act="cmd" data-id="${d.id}" data-type="refresh">刷新策略</button>
          <span class="badge ${d.online ? "on" : "off"}"><i class="dot"></i>${d.online ? "在线" : "离线"}</span>
          <span class="muted">电量 ${live.battery === null || live.battery === undefined ? "—" : live.battery + "%"} · 最后心跳 ${
            live.lastSeen ? timeAgo(live.lastSeen) : "没上线过"
          } · 正在跑 ${esc(live.foregroundApp ? appNamed(live.foregroundApp) : "没在跑应用")} · ${
            live.student ? `这节课使用者 ${esc(live.student.name)}（${esc(live.student.studentNo)}）` : "这节课还没定使用者"
          }</span>
        </div>
        <p class="hint">${
          d.scanned
            ? `最近扫描 ${d.lastScanAt ? timeAgo(d.lastScanAt) : "?"}：清单里 ${data.items.length} 个应用，这台装了 ${installedCount} 个${
                missingCount ? `，${missingCount} 个没装（学生点了打不开）` : "，全都装上了"
              }。`
            : "这台头显还没扫描过应用，点上面「扫描这台头显」让它读一遍本机装了什么。"
        }${pending ? ` 还有 ${pending} 条指令等头显联网执行。` : ""}
          改「是否允许 / 每日上限」写的是<b>这台头显的专属策略</b>，比「应用与策略」页的全局默认优先，头显下次心跳（约 10 秒）就生效。</p>
      </div>

      <div class="panel"><h3>应用策略<span class="muted" id="devapp-shown"></span></h3>
        <div class="row-controls" style="margin-bottom:12px">
          <div class="chips" id="devapp-filters">
            ${chip("all", "全部", data.items.length)}${chip("installed", "已装", installedCount)}${chip(
      "missing",
      "没装",
      missingCount,
    )}${chip("blocked", "被禁止", blockedCount)}
          </div>
          <input class="dev-search" id="devapp-search" type="search" placeholder="搜应用名或包名" value="${esc(
            state.deviceApps.keyword,
          )}" />
          <button class="mini" id="devapp-allow-all">筛选出的已装应用全部允许</button>
          <button class="mini danger" id="devapp-deny-all">筛选出的已装应用全部禁止</button>
        </div>
        <table><thead><tr><th>应用</th><th>头显上的版本</th><th>安装状态</th><th>这台是否允许</th><th>这台每日上限</th><th class="num">今日已用</th><th class="num">打开次数</th><th class="num">操作</th></tr></thead><tbody id="devapp-rows">
        ${data.items
          .slice()
          .sort((a, b) => Number(b.installState === "installed") - Number(a.installState === "installed"))
          .map(row)
          .join("")}
        </tbody></table>
        <div class="empty hidden" id="devapp-empty">这个筛选条件下没有应用，换个条件或清空搜索框。</div>
        ${
          unknownCount
            ? `<p class="hint">还有 ${unknownCount} 个应用的状态是「没扫过」——扫描完才会准。</p>`
            : ""
        }
      </div>

      ${
        data.unmanaged.length
          ? `<div class="panel"><h3>清单外的应用<span class="muted">${data.unmanaged.length} 个（多为系统应用或学生自己装的）</span></h3>
              <table><thead><tr><th>应用</th><th>包名</th><th>版本</th><th class="num">打开次数</th><th class="num">操作</th></tr></thead><tbody>
              ${data.unmanaged
                .map(
                  (item) => `<tr><td><b>${esc(item.icon)} ${esc(item.name)}</b>${
                    item.isVr ? "" : ' <span class="muted">系统应用</span>'
                  }</td><td class="mono muted">${esc(item.packageName)}</td><td class="muted">${esc(
                    item.version || "—",
                  )}</td><td class="num">${item.launchCount ?? 0}</td><td class="num"><button class="mini" data-act="manage-app" data-id="${
                    d.id
                  }" data-app="${item.appId ?? ""}" data-pkg="${esc(item.packageName)}" data-name="${esc(
                    item.name,
                  )}">${item.appId ? "重新纳入管理" : "纳入管理"}</button>
                  <button class="mini danger" data-act="local-app-delete" data-id="${d.id}" data-pkg="${esc(
                    item.packageName,
                  )}" data-name="${esc(item.name)}">删除</button></td></tr>`,
                )
                .join("")}
              </tbody></table>
              <p class="hint">头显扫到但没进管理清单的应用：白名单模式下会被拦回桌面并记一次越权；「纳入管理」后就能单独给它设允许与时长。</p>
            </div>`
          : ""
      }

      <div class="panel"><h3>越权打开记录<span class="muted">白名单模式下被拦回桌面的回执</span></h3>
        ${
          data.violations.length
            ? `<table><thead><tr><th>时间</th><th>应用</th><th>包名</th><th>学生</th><th>处理</th></tr></thead><tbody>
               ${data.violations
                 .map(
                   (item) => `<tr><td class="muted mono">${new Date(item.ts).toLocaleString("zh-CN", {
                     hour12: false,
                   })}</td><td><b>${esc(item.label)}</b></td><td class="mono muted">${esc(
                     item.packageName,
                   )}</td><td>${esc(item.student ?? "—")}</td><td><span class="badge bad">已送回桌面</span></td></tr>`,
                 )
                 .join("")}</tbody></table>`
          : '<div class="empty">这台头显没有越权记录 ✅</div>'
        }
      </div>

      <div class="panel"><h3>这台的应用清单从哪来<span class="muted">只认头显自己扫的</span></h3>
        <p class="hint">后台不手工往这台头显上编应用：清单一律来自头显启动器扫描本机应用后报上来的结果。
        上面「扫描这台头显」是让它立刻重扫一遍再报一次；没扫过的应用一律按「没扫过」处理，扫完才准。
        行末的「删除」只删这条扫描记录，头显下次重扫还会照实报上来。</p>
      </div>`;

    const rowsBox = el("devapp-rows");
    const applyFilter = () => {
      const keyword = String(state.deviceApps.keyword ?? "").trim().toLowerCase();
      const filter = state.deviceApps.filter;
      let shown = 0;
      rowsBox.querySelectorAll("tr").forEach((tr) => {
        const ok =
          (!keyword || tr.dataset.text.includes(keyword)) &&
          (filter === "all" ||
            (filter === "installed" && tr.dataset.state === "installed") ||
            (filter === "missing" && tr.dataset.state === "missing") ||
            (filter === "blocked" && tr.dataset.allow === "no"));
        tr.classList.toggle("hidden", !ok);
        if (ok) {
          shown += 1;
        }
      });
      el("devapp-shown").textContent = `显示 ${shown} / ${data.items.length} 个`;
      el("devapp-empty").classList.toggle("hidden", shown !== 0);
      el("devapp-filters")
        .querySelectorAll(".chip")
        .forEach((node) => node.classList.toggle("on", node.dataset.filter === filter));
    };

    el("devapp-filters").addEventListener("click", (event) => {
      const node = event.target.closest(".chip");
      if (node) {
        state.deviceApps.filter = node.dataset.filter;
        applyFilter();
      }
    });
    el("devapp-search").addEventListener("input", (event) => {
      state.deviceApps.keyword = event.target.value;
      applyFilter();
    });
    el("devapp-scan").addEventListener("click", async () => {
      await api(`/devices/${d.id}/command`, { method: "POST", body: { type: "scan" } });
      toast(d.online ? "已让这台头显重新扫描，约 10 秒后回传结果" : "扫描指令已排队，头显联网后会自动执行");
      load(true);
    });
    const bulk = async (allowed) => {
      const targets = [...rowsBox.querySelectorAll("tr")].filter(
        (tr) => !tr.classList.contains("hidden") && tr.dataset.installed === "1",
      );
      if (!targets.length) {
        toast("当前筛选里没有已装的应用", true);
        return;
      }
      let notice = null;
      for (const tr of targets) {
        const limit = document.querySelector(`select[data-act="dev-limit"][data-app="${tr.dataset.app}"]`);
        const saved = await api("/policies", {
          method: "PUT",
          body: {
            appId: Number(tr.dataset.app),
            scope: "device",
            scopeId: d.id,
            allowed,
            dailyMinutes: limit && limit.value ? Number(limit.value) : null,
          },
        });
        if (saved?.notice) {
          notice = saved.notice;
        }
      }
      toast(notice ?? `已把这台头显的 ${targets.length} 个应用设为「${allowed ? "允许" : "禁止"}」`, Boolean(notice));
      load(true);
    };
    el("devapp-allow-all").addEventListener("click", () => bulk(true));
    el("devapp-deny-all").addEventListener("click", () => bulk(false));
    el("view")
      .querySelectorAll(".dev-tab")
      .forEach((tab) =>
        tab.addEventListener("click", () => {
          state.deviceApps.deviceId = Number(tab.dataset.device);
          load();
        }),
      );
    applyFilter();

  },
  // ---------- 学生 ----------
  async students() {
    const [{ students }, { classes }] = await Promise.all([api("/students"), api("/classes")]);
    const unassigned = students.filter((student) => !student.class).length;
    const keyword = state.students.keyword.trim().toLowerCase();
    const picked = state.students.classId;
    const filtered = students
      .filter((student) =>
        !picked ? true : picked === "none" ? !student.class : String(student.class?.id) === picked,
      )
      .filter(
        (student) =>
          !keyword ||
          student.name.toLowerCase().includes(keyword) ||
          student.studentNo.toLowerCase().includes(keyword),
      );
    const classChips = () =>
      [{ id: "", name: `全部 ${students.length} 人` }, ...(unassigned ? [{ id: "none", name: `未分班 ${unassigned} 人` }] : [])]
        .concat(classes.map((c) => ({ id: String(c.id), name: `${c.name} ${c.studentCount} 人` })))
        .map(
          (item) =>
            `<button class="chip ${picked === item.id ? "on" : ""}" data-act="class-filter" data-id="${item.id}">${esc(
              item.name,
            )}</button>`,
        )
        .join("");
    el("view").innerHTML = `
      <div class="panel"><h3>班级<span class="muted">${
        classes.length ? `${classes.length} 个班｜未分班 ${unassigned} 人` : "还没建班：学生先记在未分班里也行，回头再分"
      }</span></h3>
        ${
          classes.length
            ? `<div class="cards">${classes
                .map(
                  (item) => `<div class="card"><div class="label">${esc(item.name)}${
                    item.grade ? ` · ${esc(item.grade)}` : ""
                  }</div><div class="kpi">${item.studentCount}<span class="muted" style="font-size:13px"> 人</span></div>
                  <div class="muted" style="font-size:12px">${
                    item.activeLessons ? "这节课正开着" : "现在没开这个班的课"
                  }</div>
                  <div class="row-controls" style="margin-top:8px">
                    <button class="mini" data-act="class-rename" data-id="${item.id}" data-name="${esc(item.name)}">改名</button>
                    <button class="mini danger" data-act="class-delete" data-id="${item.id}" data-name="${esc(
                      item.name,
                    )}" data-count="${item.studentCount}">删班</button>
                  </div></div>`,
                )
                .join("")}</div>`
            : '<div class="empty">一个班都还没有。班级只是用来分组的：不建班也能开课、也能配策略。</div>'
        }
        <form id="add-class" class="form-grid" style="margin-top:12px">
          <label>班级名<input name="name" type="text" placeholder="如 初三(3)班" required /></label>
          <label>年级（可不填）<input name="grade" type="text" placeholder="如 初三" /></label>
          <button class="ghost" style="margin:0">新增班级</button>
        </form>
      </div>
      <div class="grid-2">
        <div class="panel"><h3>加一个学生</h3>
          <form id="add-student" class="form-grid">
            <label>姓名<input name="name" type="text" placeholder="如 陈嘉禾" required /></label>
            <label>学号<input name="studentNo" type="text" placeholder="如 2026030205" required /></label>
            <label>班级<select name="classId"><option value="">未分班</option>${classes
              .map((c) => `<option value="${c.id}">${esc(c.name)}（${c.studentCount} 人）</option>`)
              .join("")}</select></label>
            <button class="primary" style="margin:0">添加</button>
          </form>
          <p class="hint">学号是全园唯一的：同一台头显换了人、或者学生重名，都靠学号分得开。
            名字和学号录错了，直接在下面的名单里改就行，不用删了重录。</p>
        </div>
        <div class="panel"><h3>整份名单贴进来<span class="muted">一行一个</span></h3>
          <textarea id="bulk-students" class="bulk" placeholder="2026030201 陈嘉禾 初三(2)班&#10;2026030202 林知远 初三(2)班&#10;李小明 2026030299　←　姓名在前也认">${esc(
            state.students.bulk,
          )}</textarea>
          <div class="row-controls" style="margin-top:8px">
            <button class="mini" id="bulk-import">导入这些学生</button>
            <span class="muted">第三段写班级名，没有的班当场建；学号已经有的那行会跳过</span>
          </div>
        </div>
      </div>
      <div class="panel"><h3>名单<span class="muted" id="roster-shown">${
        filtered.length === students.length ? `${students.length} 人` : `筛出 ${filtered.length} 人／共 ${students.length} 人`
      }</span>
        <input class="dev-search" id="student-search" type="search" placeholder="搜姓名或学号" value="${esc(
          state.students.keyword,
        )}" /></h3>
        <div class="chips" id="student-filters" style="margin-bottom:10px">${classChips()}</div>
        <table><thead><tr><th>学生（点开就能改）</th><th>班级</th><th>状态</th><th>这节课在用</th><th>最近一节课</th><th class="num">今日时长</th><th class="num">累计时长</th><th class="num">操作</th></tr></thead><tbody id="roster-body">
        ${filtered
          .map(
            (student) => `<tr data-search="${esc(`${student.name} ${student.studentNo}`.toLowerCase())}">
              <td><input class="cell" data-act="student-field" data-field="name" data-id="${student.id}" value="${esc(
              student.name,
            )}" />
                <input class="cell mono" data-act="student-field" data-field="studentNo" data-id="${student.id}" value="${esc(
              student.studentNo,
            )}" />
                <details class="usage" data-act="student-usage" data-id="${student.id}" data-name="${esc(
              student.name,
            )}"><summary>看明细</summary><div class="usage-body muted">点开才去后台拉：跑了哪些应用、各多久、在哪台上。</div></details></td>
              <td><select data-act="student-class" data-id="${student.id}" data-current="${
                student.class?.id ?? ""
              }"><option value="">未分班</option>${classes
                .map(
                  (c) =>
                    `<option value="${c.id}" ${student.class?.id === c.id ? "selected" : ""}>${esc(c.name)}</option>`,
                )
                .join("")}</select></td>
              <td>${student.status === "active" ? '<span class="badge on">正常</span>' : '<span class="badge bad">已停用</span>'}</td>
              <td>${
                student.device
                  ? `${esc(student.device.name)} ${statusBadge(student.device)}`
                  : '<span class="muted">没在课上</span>'
              }</td>
              <td class="muted">${
                student.lastLesson ? `${esc(student.lastLesson.title)}<br>${timeAgo(student.lastLesson.lastUsedAt)}` : "还没上过课"
              }</td>
              <td class="num">${fmtDuration(student.todaySeconds)}</td>
              <td class="num muted">${fmtDuration(student.totalSeconds)}</td>
              <td class="num"><button class="mini ${student.status === "active" ? "danger" : ""}" data-act="student-status" data-id="${student.id}" data-status="${
              student.status === "active" ? "suspended" : "active"
            }">${student.status === "active" ? "停用" : "恢复"}</button>
              <button class="mini danger" data-act="student-delete" data-id="${student.id}" data-name="${esc(
                student.name,
              )}">删除</button></td></tr>`,
          )
          .join("")}
        </tbody></table>
        ${
          filtered.length
            ? ""
            : `<div class="empty">${
                keyword
                  ? `名单里没有对得上「${esc(state.students.keyword)}」的：姓名和学号都能搜，清空搜索框就看全表。`
                  : students.length
                    ? "这个班里还没人：把上面的班级换成别的班，或者用右边「整份名单贴进来」批量导入。"
                    : "名单还是空的：右边「整份名单贴进来」可以一次贴几十个，也可以上面一个一个加。"
              }</div>`
        }
        <p class="hint">学生和头显不绑死：谁用哪台是上课时当堂定的，「这节课在用」那一列就是现在的安排。
          停用的学生头显会锁住不让用，但时长记录照旧留着。</p>
      </div>`;
    el("add-student").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      await api("/students", {
        method: "POST",
        body: {
          name: form.get("name"),
          studentNo: form.get("studentNo"),
          classId: form.get("classId") ? Number(form.get("classId")) : null,
        },
      });
      toast("已添加学生");
      load(true);
    });
    el("add-class").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      await api("/classes", {
        method: "POST",
        body: { name: form.get("name"), grade: form.get("grade") || null },
      });
      toast("已新增班级");
      load(true);
    });
    el("student-search").addEventListener("input", (event) => {
      state.students.keyword = event.target.value;
      const keyword = event.target.value.trim().toLowerCase();
      let shown = 0;
      el("view")
        .querySelectorAll("tbody tr")
        .forEach((tr) => {
          const hit = !keyword || (tr.dataset.search ?? "").includes(keyword);
          tr.classList.toggle("hidden", !hit);
          if (hit) {
            shown += 1;
          }
        });
      el("roster-shown").textContent =
        shown === students.length ? `${students.length} 人` : `筛出 ${shown} 人／共 ${students.length} 人`;
    });
    el("student-filters").addEventListener("click", async (event) => {
      const chip = event.target.closest('[data-act="class-filter"]');
      if (!chip) {
        return;
      }
      state.students.classId = chip.dataset.id;
      load(true);
    });
    // 行内改姓名/学号：只有真改了才发请求，改完保留搜索与班级筛选，不会因为刷新丢掉老师正在看的那一段。
    // 监听器绑在 tbody 上而不是 #view 上：#view 是 index.html 里的常驻节点，每进一次学生页就往它身上
    // 加一个监听器，进出三趟之后改一次名字会连发三个 PATCH、弹三条一样的提示（请求也是三份）。
    el("roster-body").addEventListener("change", async (event) => {
      const input = event.target.closest('[data-act="student-field"]');
      if (input) {
        if (input.value.trim() === input.defaultValue) {
          return;
        }
        try {
          const result = await api(`/students/${input.dataset.id}`, {
            method: "PATCH",
            body: { [input.dataset.field]: input.value },
          });
          toast(result.changes?.length ? `已改成 ${result.changes.join("；")}` : "已改好");
        } catch {
          // 失败原因 api() 已经原样弹给老师了；这里只负责把输入框恢复成后台里那个值，
          // 不再让它冒成未处理的 rejection（否则同一句话会被「没办成：」再弹一遍）
        } finally {
          load(true);
        }
        return;
      }
      const picker = event.target.closest('[data-act="student-class"]');
      if (picker) {
        if (picker.value === (picker.dataset.current ?? "")) {
          return;
        }
        try {
          const result = await api(`/students/${picker.dataset.id}`, {
            method: "PATCH",
            body: { classId: picker.value ? Number(picker.value) : null },
          });
          toast(result.changes?.length ? result.changes.join("；") : "班级没变");
        } catch {
          // 同上：后台的中文理由已经弹过了，这里只把下拉恢复原状
        } finally {
          load(true);
        }
        return;
      }
    });
    // 「看明细」：点开哪个人才去后台拉那一份，不给整份名单每个人都先拉一遍。
    // toggle 事件不冒泡，绑在 tbody 上必须走捕获阶段（第三个参数 true）才收得到——
    // 少了它，点开永远是那句占位话，也不会有任何报错。
    el("roster-body").addEventListener("toggle", async (event) => {
      const box = event.target;
      if (box?.dataset?.act !== "student-usage" || !box.open || box.dataset.loaded) {
        return;
      }
      box.dataset.loaded = "1";
      const body = box.querySelector(".usage-body");
      body.textContent = "正在拉明细…";
      try {
        body.innerHTML = usageHtml(await api(`/students/${box.dataset.id}/usage?days=7`));
        body.classList.remove("muted");
      } catch {
        // 拉失败的中文原因 api() 弹过了；这里留着框让老师再点一次
        box.dataset.loaded = "";
        body.textContent = "明细没拉到，再点开一次试试。";
      }
    }, true);
    el("bulk-students").addEventListener("input", (event) => {
      state.students.bulk = event.target.value;
    });
    el("bulk-import").addEventListener("click", async () => {
      const text = state.students.bulk;
      if (!text.trim()) {
        toast("先把名单粘进上面的框里", true);
        return;
      }
      let result;
      try {
        result = await api("/students/bulk", { method: "POST", body: { text } });
      } catch {
        // 后台的中文原因已经弹过了（比如「一次最多 300 行」），粘的名单留着让老师自己改
        return null;
      }
      state.students.bulk = "";
      const skipped = result.skipped.length
        ? `｜跳过 ${result.skipped.length} 行（${result.skipped[0].reason}）`
        : "";
      toast(
        `导入了 ${result.created.length} 个学生${skipped}${
          result.newClasses.length ? `｜顺手建了 ${result.newClasses.join("、")}` : ""
        }`,
        !result.created.length,
      );
      load(true);
      return result;
    });
  },

  // ---------- 应用与策略 ----------
  async apps() {
    const [{ apps }, { classes }, { devices }, { students }] = await Promise.all([
      api("/apps"),
      api("/classes"),
      api("/devices"),
      api("/students"),
    ]);
    const scopeOptions = (app) =>
      `<option value="global">全校</option>` +
      classes.map((c) => `<option value="class:${c.id}">班级 · ${esc(c.name)}</option>`).join("") +
      students.map((s) => `<option value="student:${s.id}">学生 · ${esc(s.name)}</option>`).join("") +
      devices.map((d) => `<option value="device:${d.id}">头显 · ${esc(d.name)}</option>`).join("");
    // 清单不是手工建的，是头显扫出来的：这张表只按「哪几台头显现在装着」说话，
    // 那一列由头显报上来的扫描结果现算（`GET /apps` 的 installedOn），PC 这边不另存一份口径；
    // 默认只列头显上真有的，头显已经没有了的收进开关里，免得老师对着不存在的配策略。
    const onDevices = apps.filter((app) => app.installedDevices > 0);
    const goneApps = apps.filter((app) => app.installedDevices === 0);
    const shown = state.apps.showGone ? apps : onDevices;
    const installedCell = (app) =>
      app.installedOn.length
        ? app.installedOn
            .map(
              (d) =>
                `<span class="badge on"><i class="dot"></i>${esc(d.name)}</span>${
                  d.version ? ` <span class="muted mono">${esc(d.version)}</span>` : ""
                }<br>`,
            )
            .join("") + `<span class="muted">最近扫到 ${app.lastScanAt ? timeAgo(app.lastScanAt) : "?"}</span>`
        : '<span class="badge">头显上没有了</span><br><span class="muted">可能已卸载，或这台还没扫描过</span>';
    const onlineCount = devices.filter((d) => d.online).length;

    el("view").innerHTML = `
      <div class="panel"><h3>应用清单<span class="muted">${onDevices.length} 个是从 ${devices.length} 台头显上读出来的 · 开关即时生效，头显下一次心跳就会执行</span>
        <button class="mini" style="margin-left:12px" data-act="rescan-all-devices" ${onlineCount ? "" : "disabled"}>
          ${onlineCount ? `让 ${onlineCount} 台在线头显重新扫描` : "没有在线头显可扫"}
        </button>
        <button class="mini" data-act="apps-toggle-gone" ${goneApps.length ? "" : "disabled"}>${
          state.apps.showGone ? "只看头显上装着的" : `也显示头显上已经没有的 ${goneApps.length} 个`
        }</button></h3>
        ${
          shown.length
            ? `<table><thead><tr><th>应用</th><th>包名</th><th>哪几台头显装着</th><th class="num">今日时长</th><th>上架</th><th>已配置策略</th></tr></thead><tbody>`
            : `<div class="empty">${
                devices.length
                  ? "头显还没把应用扫上来：点上面「让 N 台在线头显重新扫描」，或者去「PICO 设备」页按 IP 找到它。"
                  : "还没登记头显：去「PICO 设备」页按 IP 找一台头显收进来，它的真实应用清单会自己出现在这张表里。"
              }</div><table class="hidden"><tbody></tbody></table>`
        }
        ${shown
          .map(
            (app) => `<tr>
              <td><b>${esc(app.icon)} ${esc(app.name)}</b></td>
              <td class="mono muted">${esc(app.packageName)}</td>
              <td>${installedCell(app)}</td>
              <td class="num">${fmtDuration(app.todaySeconds)}</td>
              <td><button class="mini ${app.enabled ? "" : "danger"}" data-act="app-toggle" data-id="${app.id}" data-enabled="${app.enabled ? 0 : 1}">${
              app.enabled ? "已上架" : "已下架"
            }</button>
            ${
              app.managed
                ? ` <button class="mini danger" data-act="app-manage" data-id="${app.id}" data-managed="0">移出清单</button>`
                : ` <button class="mini" data-act="app-manage" data-id="${app.id}" data-managed="1">重新纳入</button>`
            }
            <button class="mini danger" data-act="app-delete" data-id="${app.id}" data-name="${esc(app.name)}">删除</button></td>
              <td class="muted">${
                app.policies.length
                  ? app.policies
                      .map(
                        (p) =>
                          `<span class="badge">${esc(p.scopeName)}｜${p.allowed === null ? "跟随默认" : p.allowed ? "允许" : "禁止"}${
                            p.dailyMinutes ? `｜${p.dailyMinutes}分钟/天` : ""
                          }${p.window ? `｜${esc(p.window)}` : ""}</span> `,
                      )
                      .join("")
                  : "无"
              }</td></tr>`,
          )
          .join("")}
        </tbody></table></div>
      <div class="panel"><h3>新增 / 登记策略</h3>
        <form id="policy-form" class="form-grid">
          <label>应用<select name="appId">${shown
            .map((app) => `<option value="${app.id}">${esc(app.name)}</option>`)
            .join("")}</select></label>
          <label>范围<select name="scope">${scopeOptions()}</select></label>
          <label>是否允许<select name="allowed"><option value="1">允许</option><option value="0">禁止</option><option value="">跟随应用默认</option></select></label>
          <label>每日上限（分钟）<input name="dailyMinutes" type="number" min="1" placeholder="留空不限" /></label>
          <label>允许开始时间<input name="windowStart" type="time" placeholder="如 14:00" /></label>
          <label>允许结束时间<input name="windowEnd" type="time" placeholder="如 16:00" /></label>
          <button class="primary" style="margin:0">保存策略</button>
        </form>
        <p class="hint">优先级：头显 › 学生 › 班级 › 全校。留空表示不覆盖上一层。</p>
      </div>
      <div class="panel"><h3>这张表是从哪来的<span class="muted">头显实际装着什么，这里就列什么</span></h3>
        <p class="hint">头显启动器定期读一遍本机装了哪些应用报给后台：新装的应用自己就进清单，默认先不上架，
        等你在这页点「已上架」才允许学生跑；头显上已经没有的（还没上架过的）会自己从这张表里退场，
        上过架的会留着并标「头显上没有了」，方便你看出是哪台没装上。
        后台不提供手工加应用：手编的包名跟头显实际装的东西对不上，白名单就会拿一份假清单去拦真应用。
        要逐台管谁能跑、每天跑多久，去「头显应用」页；那里同样是先扫描再配策略。</p>
      </div>`;
    el("policy-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      const scope = String(form.get("scope"));
      const [scopeKind, scopeId] = scope.includes(":") ? scope.split(":") : ["global", 0];
      const saved = await api("/policies", {
        method: "PUT",
        body: {
          appId: Number(form.get("appId")),
          scope: scopeKind,
          scopeId: Number(scopeId),
          allowed: form.get("allowed") === "" ? null : form.get("allowed") === "1",
          dailyMinutes: form.get("dailyMinutes") === "" ? null : Number(form.get("dailyMinutes")),
          windowStart: form.get("windowStart") || null,
          windowEnd: form.get("windowEnd") || null,
        },
      });
      toast(saved.notice ?? "策略已保存", Boolean(saved.notice));
      load(true);
    });
  },

  // ---------- 报表 ----------
  async reports() {
    const data = await api(`/reports/usage?days=${state.reports.days}&groupBy=${state.reports.groupBy}`);
    const max = Math.max(1, ...data.rows.map((row) => row.seconds));
    const labels = { app: "应用", student: "学生", device: "头显", day: "日期" };
    el("view").innerHTML = `<div class="panel">
      <h3>时长统计<span class="muted">近 ${data.days} 天 · 按${labels[data.groupBy]}</span></h3>
      <div class="row-controls" style="margin-bottom:12px">
        <select id="group-by">${["app", "student", "device", "day"]
          .map(
            (key) =>
              `<option value="${key}" ${state.reports.groupBy === key ? "selected" : ""}>按${labels[key]}</option>`,
          )
          .join("")}</select>
        <select id="days">${[1, 3, 7, 14, 30]
          .map((d) => `<option value="${d}" ${state.reports.days === d ? "selected" : ""}>近 ${d} 天</option>`)
          .join("")}</select>
      </div>
      ${
        data.rows.length
          ? data.rows
              .map(
                (row) =>
                  `<div class="bar-row"><span title="${esc(row.label)}">${esc(row.label)}</span>
                   <div class="bar"><i style="width:${Math.round((row.seconds / max) * 100)}%"></i></div>
                   <span class="num muted">${fmtDuration(row.seconds)}</span></div>`,
              )
              .join("")
          : '<div class="empty">这段时间还没有数据</div>'
      }
      <table style="margin-top:14px"><thead><tr><th>${labels[data.groupBy]}</th><th class="num">总时长</th><th class="num">次数</th><th class="num">附加</th></tr></thead><tbody>
      ${data.rows
        .map(
          (row) =>
            `<tr><td>${esc(row.label)}</td><td class="num">${fmtDuration(row.seconds)}</td><td class="num">${
              row.sessions ?? "—"
            }</td><td class="num muted">${
              row.devices ? `${row.devices} 台设备` : row.apps ? `${row.apps} 个应用` : row.activeDays ? `${row.activeDays} 天在用` : "—"
            }</td></tr>`,
        )
        .join("")}
      </tbody></table></div>`;
    el("group-by").addEventListener("change", (event) => {
      state.reports.groupBy = event.target.value;
      load(true);
    });
    el("days").addEventListener("change", (event) => {
      state.reports.days = Number(event.target.value);
      load(true);
    });
  },

  // ---------- 日志 ----------
  async audit() {
    const { logs } = await api("/audit?limit=120");
    el("view").innerHTML = `<div class="panel"><h3>操作日志<span class="muted">最近 ${logs.length} 条</span></h3>
      <table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>说明</th></tr></thead><tbody>
      ${logs
        .map(
          (row) =>
            `<tr><td class="muted mono">${new Date(row.ts).toLocaleString("zh-CN", { hour12: false })}</td>
             <td>${esc(row.teacher_name ?? "系统")}</td><td class="mono">${esc(row.action)}</td>
             <td class="muted mono">${esc(row.target ?? "")}</td><td>${esc(row.detail ?? "")}</td></tr>`,
        )
        .join("")}
      </tbody></table></div>`;
  },
};

// 事件委派：设备绑定 / 指令 / 改名 / 应用开关
el("view").addEventListener("change", async (event) => {
  const { act } = event.target.dataset;
  if (act === "lesson-assign") {
    const deviceId = event.target.dataset.device;
    const studentId = event.target.value ? Number(event.target.value) : null;
    const result = await api(`/lessons/${state.lessonId}/assign`, {
      method: "POST",
      body: { deviceId: Number(deviceId), studentId },
    });
    // 停用状态的学生照样能点，但后台会立刻把这台锁住——这句话由后台判定，网页只负责说给老师听
    toast(result.warning || (studentId ? "已把这台头显分给该学生，之后的时长算他头上" : "这台头显的使用者已清空"), Boolean(result.warning));
    load(true);
    return;
  }
  if (act === "device-pick") {
    state.deviceApps.deviceId = Number(event.target.value);
    load(true);
    return;
  }
  if (act === "device-mode") {
    await api(`/devices/${state.deviceApps.deviceId}`, { method: "PATCH", body: { appMode: event.target.value } });
    toast(event.target.value === "allowlist" ? "已切到白名单：清单外的应用会被拦回桌面" : "已切到自由运行");
    load(true);
    return;
  }
  if (act === "dev-allow" || act === "dev-limit") {
    const appId = event.target.dataset.app;
    const allowSel = document.querySelector(`select[data-act="dev-allow"][data-app="${appId}"]`);
    const limitSel = document.querySelector(`select[data-act="dev-limit"][data-app="${appId}"]`);
    const saved = await api("/policies", {
      method: "PUT",
      body: {
        appId: Number(appId),
        scope: "device",
        scopeId: state.deviceApps.deviceId,
        allowed: allowSel.value === "" ? null : allowSel.value === "1",
        dailyMinutes: limitSel.value === "" ? null : Number(limitSel.value),
      },
    });
    toast(saved.notice ?? "策略已保存，头显下次心跳生效", Boolean(saved.notice));
    load(true);
  }
});
el("view").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) {
    return;
  }
  const { act, id, type, status, enabled, pkg, name, device } = button.dataset;
  if (act === "open-apps") {
    state.deviceApps.deviceId = Number(id);
    state.page = "device-apps";
    renderNav();
    load();
    return;
  }
  if (act === "rescan-all-devices") {
    // 清单不是手工建的：想让后台跟头显对齐，就让在线的头显各自重扫一遍再报上来
    const { devices } = await api("/devices");
    const online = devices.filter((item) => item.online);
    if (!online.length) {
      toast("现在没有在线头显，扫不了", true);
      return;
    }
    for (const device of online) {
      await api(`/devices/${device.id}/command`, { method: "POST", body: { type: "scan" } });
    }
    toast(`已让 ${online.length} 台在线头显重新扫描，十几秒后回来看清单`);
    load(true);
    return;
  }
  if (act === "apps-toggle-gone") {
    // 「头显上已经没有的」不是常态数据，默认藏起来，只有要对账时才展开
    state.apps.showGone = !state.apps.showGone;
    load(true);
    return;
  }
  if (act === "copy-backend-url") {
    const url = backendBase();
    let copied = false;
    try {
      // http://局域网IP 不算安全上下文，navigator.clipboard 常常压根没有，得留一条老路子
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const box = document.createElement("textarea");
      box.value = url;
      box.setAttribute("readonly", "readonly");
      document.body.appendChild(box);
      box.select();
      copied = document.execCommand("copy");
      box.remove();
    }
    toast(copied ? `已复制后台地址：${url}` : `复制没成，请手动抄：${url}`, !copied);
    return;
  }
  if (act === "adopt-device") {
    const target = button.dataset.target;
    const result = await api("/devices/discover/adopt", { method: "POST", body: { target } });
    toast(
      result.created
        ? `已收编「${result.name}」，配对码 ${result.pairingCode}${result.apps ? `｜顺带报上来 ${result.apps.scanned} 个应用` : ""}`
        : `已更新「${name}」的型号、版本和地址${result.apps ? `（重新报了 ${result.apps.scanned} 个应用）` : ""}`,
    );
    // 收编只是后台认识了这台；它还得知道往哪儿心跳。这一步没成必须让老师看见，否则下一步就是「怎么显示离线」
    if (result.backend && !result.backend.ok) {
      toast(`后台地址没推过去：${result.backend.reason}`, true);
    }
    await runDiscovery(target);
    load(true);
    return;
  }
  if (act === "push-backend") {
    const result = await api(`/devices/${id}/backend`, { method: "POST", body: {} });
    toast(
      result.ok ? `已把后台地址推给这台头显：${result.serverBaseUrl}，十几秒内就该上线了` : `没推过去：${result.reason}`,
      !result.ok,
    );
    load(true);
    return;
  }
  if (act === "say") {
    const text = window.prompt(`给「${name}」带一句话（打在这台头显首页的横幅上，停 45 秒）`, "");
    if (!text || !text.trim()) {
      return;
    }
    await api(`/devices/${id}/command`, { method: "POST", body: { type: "message", text: text.trim() } });
    toast("话已下发：这台头显下一次心跳（几秒内）就显示出来");
    return;
  }
  if (act === "app-manage") {
    await api(`/apps/${id}`, { method: "PATCH", body: { managed: button.dataset.managed === "1" } });
    toast(button.dataset.managed === "1" ? "已重新纳入管理清单" : "已移出清单：白名单模式下这台头显打开它会被送回桌面");
    load(true);
    return;
  }
  if (act === "manage-app") {
    if (button.dataset.app) {
      await api(`/apps/${button.dataset.app}`, { method: "PATCH", body: { managed: true } });
      toast("已重新纳入管理清单");
      load(true);
      return;
    }
    const key = String(pkg)
      .split(".")
      .filter((part) => part && !["com", "vr", "app"].includes(part))
      .pop();
    await api("/apps", {
      method: "POST",
      body: { key: `${String(key).toLowerCase()}-${id}`, name, packageName: pkg, category: "系统工具", icon: "⚙️" },
    });
    toast("已纳入管理清单，稍后就能在这台头显上单独设允许与时长");
    load(true);
    return;
  }
  if (act === "open-lesson") {
    state.page = "lesson";
    renderNav();
    load();
    return;
  }
  if (act === "lesson-end") {
    if (!window.confirm("下课？这节课的安排立刻从头显上撤掉，使用记录会保留在报表里。")) {
      return;
    }
    await api(`/lessons/${id}/end`, { method: "POST", body: {} });
    toast("已下课");
    load(true);
    return;
  }
  if (act === "lesson-refresh") {
    load(true);
    return;
  }
  if (act === "lesson-add-device") {
    await api(`/lessons/${id}/devices`, { method: "POST", body: { deviceId: Number(device) } });
    toast("已把这台头显加进这节课，它 10 秒内就会按这节课的安排走");
    load(true);
    return;
  }
  if (act === "cmd") {
    await api(`/devices/${id}/command`, { method: "POST", body: { type } });
    toast(
      {
        lock: "已下发锁定",
        unlock: "已解锁",
        refresh: "已让头显重新拉取策略",
        scan: "已让头显重新扫描，装了什么应用一会儿就报上来",
        restart: "已下发重启",
      }[type] ?? "指令已下发",
    );
    load(true);
  } else if (act === "rename") {
    const name = window.prompt("给这台头显起个名字", "");
    if (name) {
      await api(`/devices/${id}`, { method: "PATCH", body: { name } });
      toast("已改名");
      load(true);
    }
  } else if (act === "student-status") {
    await api(`/students/${id}`, { method: "PATCH", body: { status } });
    toast(status === "active" ? "已恢复使用" : "已停用：他下次拿到头显会被锁住，时长记录照旧留着");
    load(true);
  } else if (act === "class-rename") {
    const newName = window.prompt("班级改名（按这个班配的策略不用重配）", name);
    if (newName && newName.trim() && newName.trim() !== name) {
      await api(`/classes/${id}`, { method: "PATCH", body: { name: newName.trim() } });
      toast(`已改名为「${newName.trim()}」`);
      load(true);
    }
  } else if (act === "class-delete") {
    const count = Number(button.dataset.count ?? 0);
    const tip = count
      ? `删除班级「${name}」？里面 ${count} 个学生不会被删，他们会变成未分班，时长记录一条不少。`
      : `删除班级「${name}」？这个班里已经没人了。`;
    if (!window.confirm(tip)) {
      return;
    }
    const result = await api(`/classes/${id}`, { method: "DELETE", body: { moveStudents: true } });
    toast(result?.notice ?? "已删除班级", Boolean(result?.notice));
    load(true);
  } else if (act === "app-toggle") {
    await api(`/apps/${id}`, { method: "PATCH", body: { enabled: enabled === "1" } });
    toast(enabled === "1" ? "已上架" : "已下架");
    load(true);
  } else if (act === "device-delete") {
    if (!window.confirm(`删除「${name}」？这台头显的时长、心跳、越权、扫描记录、课堂分配和应用策略会一起删掉。`)) {
      return;
    }
    const result = await api(`/devices/${id}`, { method: "DELETE" });
    toast(result?.notice ? `已删除头显｜${result.notice}` : "已删除头显", Boolean(result?.notice));
    load(true);
  } else if (act === "student-delete") {
    if (!window.confirm(`删除学生「${name}」？历史时长记录会留在报表里（改成不记名），这节课的当堂安排会一起空出来。`)) {
      return;
    }
    await api(`/students/${id}`, { method: "DELETE" });
    toast("已删除学生");
    load(true);
  } else if (act === "app-delete") {
    if (!window.confirm(`从管理清单里删除应用《${name}》？各台头显上对它的扫描记录、策略和它的时长记录会一起删掉，报表里也就没有它了。`)) {
      return;
    }
    await api(`/apps/${id}`, { method: "DELETE" });
    toast("已删除应用");
    load(true);
  } else if (act === "local-app-delete") {
    await api(`/devices/${id}/apps/${encodeURIComponent(pkg)}`, { method: "DELETE" });
    toast(`已移除《${name}》的扫描记录，头显重新扫描后会再出现`);
    load(true);
  }
});

el("nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button) {
    return;
  }
  state.page = button.dataset.page;
  renderNav();
  load();
});
el("refresh").addEventListener("click", () => load());
el("logout").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST", body: {} });
  showLogin("已退出登录");
});
el("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  el("login-error").textContent = "";
  const form = new FormData(event.target);
  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: { account: form.get("account"), password: form.get("password") },
    });
    state.teacher = result.teacher;
    showApp();
  } catch (error) {
    el("login-error").textContent = error.message;
  }
});

setInterval(() => {
  el("clock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}, 1000);
// 总览 / 设备 / 上课页每 8 秒自动刷新，老师不用手动点；正在输入时不打断
setInterval(() => {
  if (el("app").classList.contains("hidden")) {
    return;
  }
  const focused = document.activeElement;
  const typing = focused && el("view").contains(focused) && ["INPUT", "SELECT", "TEXTAREA"].includes(focused.tagName);
  if (typing) {
    return;
  }
  if (["dashboard", "devices", "lesson"].includes(state.page)) {
    load(true);
  }
}, 8000);

// 上课页的画面每 2 秒换一帧，并同步「已上多久」
setInterval(() => {
  if (state.page !== "lesson" || el("app").classList.contains("hidden")) {
    return;
  }
  document.querySelectorAll("img[data-screen]").forEach((img) => {
    img.src = `/api/v1/devices/${img.dataset.screen}/screen?t=${Date.now()}`;
  });
  const clock = el("lesson-clock");
  if (clock && state.lessonStartedAt) {
    const seconds = Math.round((Date.now() - state.lessonStartedAt) / 1000);
    clock.innerHTML = clock.innerHTML.replace(/已上 [^·]+·/, `已上 ${fmtDuration(seconds)} · `);
  }
}, 2000);

// 画面取不到（还没传 / 头显离线）就显示占位文案，别留一个破图
el("view").addEventListener("error", (event) => {
  const img = event.target;
  if (img.tagName === "IMG" && img.dataset.screen) {
    img.closest(".screen")?.querySelector(".no-frame")?.classList.remove("hidden");
  }
}, true);

try {
  const me = await api("/me");
  state.teacher = me.teacher;
  showApp();
} catch {
  showLogin();
}
