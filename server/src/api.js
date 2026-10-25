// 所有 API 处理函数。约定：抛 HttpError 会转成 {error:"..."} 和对应状态码。
import { db, manifestRev, now, dayStart } from "./db.js";
import { HttpError } from "./http-error.js";

export { HttpError };
import { hashPassword, verifyPassword, newToken } from "./auth.js";
import { buildManifest, deviceOnline, ONLINE_WINDOW_MS, scopeLabel } from "./policy.js";
import { clearRunData, clearAllData } from "./reset.js";
import {
  activeLessonForDevice,
  studentForDevice,
  lessonForManifest,
  startLesson,
  endLesson,
  getLesson,
  listLessons,
  currentLesson,
  assignStudent,
  setLessonApps,
  addLessonDevice,
  saveScreenFrame,
  readScreenFrame,
} from "./lesson.js";
import { DEFAULT_PORT, configureDeviceHost, parseTarget, probeDeviceHost, scanSegment } from "./discovery.js";

export { startLesson, endLesson, getLesson, listLessons, currentLesson, assignStudent, setLessonApps, addLessonDevice, saveScreenFrame, readScreenFrame };

const SESSION_TTL_MS = 12 * 3600_000;
// 上课时头显往后台推画面的间隔，真机上太快会烫、太慢老师跟不上
const SCREEN_INTERVAL_MS = Math.max(400, Number(process.env.SCREEN_INTERVAL_MS || 1500));

/** 按本地时区输出 YYYY-MM-DD，避免 toISOString 把当天算到前一天 */
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function audit(teacherId, action, target, detail) {
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (?,?,?,?,?)").run(
    teacherId ?? null,
    action,
    target ?? null,
    detail ?? null,
    now(),
  );
}

export function requireTeacher(token) {
  if (!token) {
    throw new HttpError(401, "请先登录");
  }
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, t.id, t.account, t.name, t.role
       FROM sessions s JOIN teachers t ON t.id = s.teacher_id WHERE s.token = ?`,
    )
    .get(token);
  if (!row) {
    throw new HttpError(401, "登录已失效，请重新登录");
  }
  if (row.expires_at < now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    throw new HttpError(401, "登录已过期，请重新登录");
  }
  return { id: row.id, account: row.account, name: row.name, role: row.role, token: row.token };
}

function requireDevice(token) {
  if (!token) {
    throw new HttpError(401, "缺少设备令牌 X-Device-Token");
  }
  const device = db.prepare("SELECT * FROM devices WHERE token = ?").get(token);
  if (!device) {
    throw new HttpError(403, "设备令牌无效，需要重新登记");
  }
  return device;
}

// ---------- 头显端：后台自报家门 ----------
/**
 * 头显自己扫网段找后台时敲的口（免登录）。返回里的 product 是暗号：
 * 8787 上万一跑着别的服务，头显认不出它就不会把地址改到一个不相干的服务上去。
 * baseUrl 是这台后台对外报的地址，头显照着用它，比自己拼 IP 更不容易拼错。
 */
export const BACKEND_PRODUCT = "vr-suite";

export function hello(ctx) {
  return {
    product: BACKEND_PRODUCT,
    name: "VR 学习套件后台",
    version: "0.1.0",
    serverTime: now(),
    baseUrl: ctx?.publicBase ?? "",
  };
}

// ---------- 老师端：登录 ----------
export function login(body) {
  const account = String(body.account ?? "").trim();
  const password = String(body.password ?? "");
  const teacher = db.prepare("SELECT * FROM teachers WHERE account = ?").get(account);
  if (!teacher || !verifyPassword(password, teacher.pass_hash)) {
    throw new HttpError(401, "账号或密码不对");
  }
  const token = newToken("sess");
  db.prepare("INSERT INTO sessions (token, teacher_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    token,
    teacher.id,
    now(),
    now() + SESSION_TTL_MS,
  );
  audit(teacher.id, "login", "teacher:" + teacher.id, `${teacher.name} 登录后台`);
  return {
    token,
    teacher: { id: teacher.id, account: teacher.account, name: teacher.name, role: teacher.role },
    expiresIn: SESSION_TTL_MS,
  };
}

export function logout(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  return { ok: true };
}

// ---------- 老师端：总览 ----------
export function dashboard() {
  const devices = db.prepare("SELECT * FROM devices").all();
  const students = db.prepare("SELECT * FROM students").all();
  const classNames = new Map(db.prepare("SELECT id, name FROM classes").all().map((row) => [row.id, row.name]));
  const activeLessons = db
    .prepare(
      `SELECT l.id, l.title, l.started_at, l.class_id, c.name AS class_name, t.name AS teacher_name,
              (SELECT COUNT(*) FROM lesson_devices ld WHERE ld.lesson_id = l.id) AS device_count,
              (SELECT COUNT(*) FROM lesson_devices ld WHERE ld.lesson_id = l.id AND ld.student_id IS NOT NULL) AS assigned_count
       FROM lessons l LEFT JOIN classes c ON c.id = l.class_id LEFT JOIN teachers t ON t.id = l.teacher_id
       WHERE l.status = 'active' ORDER BY l.id DESC`,
    )
    .all();
  const todayStart = dayStart();
  const todayUsage = db
    .prepare(
      `SELECT u.app_id, a.name AS app_name, SUM(u.seconds) AS seconds, COUNT(DISTINCT u.device_id) AS devices
       FROM usage_events u JOIN apps a ON a.id = u.app_id
       WHERE u.started_at >= ? GROUP BY u.app_id ORDER BY seconds DESC`,
    )
    .all(todayStart);
  const todaySeconds = todayUsage.reduce((sum, row) => sum + Number(row.seconds), 0);

  const perStudent = students
    .map((student) => {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(seconds),0) AS seconds, COUNT(*) AS entries FROM usage_events
           WHERE student_id = ? AND started_at >= ?`,
        )
        .get(student.id, todayStart);
      const seat = db
        .prepare(
          `SELECT d.*, l.title AS lesson_title FROM lessons l
           JOIN lesson_devices ld ON ld.lesson_id = l.id JOIN devices d ON d.id = ld.device_id
           WHERE l.status = 'active' AND ld.student_id = ? ORDER BY l.id DESC LIMIT 1`,
        )
        .get(student.id);
      return {
        id: student.id,
        name: student.name,
        studentNo: student.student_no,
        classId: student.class_id,
        class: student.class_id ? { id: student.class_id, name: classNames.get(student.class_id) ?? null } : null,
        status: student.status,
        todaySeconds: Number(row.seconds),
        device: seat
          ? {
              id: seat.id,
              name: seat.name,
              status: seat.status,
              online: deviceOnline(seat),
              battery: seat.battery,
              lessonTitle: seat.lesson_title,
            }
          : null,
      };
    })
    .sort((a, b) => b.todaySeconds - a.todaySeconds);

  const offline = devices.filter((d) => !deviceOnline(d) && d.status !== "disabled");
  const abnormal = [];
  for (const device of devices) {
    if (!deviceOnline(device)) {
      abnormal.push({
        deviceId: device.id,
        name: device.name,
        type: "offline",
        detail: `超过 ${Math.round(ONLINE_WINDOW_MS / 1000)} 秒没有心跳`,
      });
    }
    if (device.status === "locked") {
      abnormal.push({ deviceId: device.id, name: device.name, type: "locked", detail: "已被老师锁定，学生端只能停在锁定页" });
    }
    const installed = db
      .prepare("SELECT COUNT(*) AS n FROM device_apps WHERE device_id = ? AND installed = 1")
      .get(device.id).n;
    if (installed === 0) {
      abnormal.push({ deviceId: device.id, name: device.name, type: "scan", detail: "还没扫描过头显里的应用，去「头显应用」页点「扫描这台头显」" });
    } else {
      const missing = buildManifest(device).missingCount;
      if (missing > 0) {
        abnormal.push({ deviceId: device.id, name: device.name, type: "scan", detail: `有 ${missing} 个已上架应用这台头显没装，学生点了打不开` });
      }
    }
  }

  // 课开了但一台头显都没分：这节课其实谁都没管着，老师却以为已经在上课了。
  // 头显那边完全按后台默认清单跑，「怎么点了没反应」八成就是这个。
  for (const row of activeLessons) {
    if (Number(row.device_count) === 0) {
      abnormal.push({
        deviceId: null,
        name: `《${row.title}》`,
        type: "lesson",
        detail: "这节课开着但一台头显都没指定，头显那边不受它管。去「上课」页把头显加进来",
      });
    }
  }

  const trend = [];
  for (let back = 6; back >= 0; back -= 1) {
    const from = dayStart(now() - back * 86400_000);
    const to = from + 86400_000;
    const row = db
      .prepare("SELECT COALESCE(SUM(seconds),0) AS seconds FROM usage_events WHERE started_at >= ? AND started_at < ?")
      .get(from, to);
    trend.push({ date: localDate(from), seconds: Number(row.seconds) });
  }

  return {
    serverTime: now(),
    totals: {
      devices: devices.length,
      onlineDevices: devices.filter(deviceOnline).length,
      students: students.length,
      activeStudents: students.filter((s) => s.status === "active").length,
      apps: db.prepare("SELECT COUNT(*) AS n FROM apps").get().n,
      enabledApps: db.prepare("SELECT COUNT(*) AS n FROM apps WHERE enabled = 1").get().n,
      discoveredApps: db.prepare("SELECT COUNT(*) AS n FROM apps WHERE source = 'device'").get().n,
      reviewApps: db.prepare("SELECT COUNT(*) AS n FROM apps WHERE source = 'device' AND enabled = 0").get().n,
      violationsToday: db
        .prepare("SELECT COUNT(*) AS n FROM violations WHERE ts >= ?")
        .get(todayStart).n,
      todaySeconds,
    },
    todayByApp: todayUsage.map((row) => ({ ...row, seconds: Number(row.seconds) })),
    perStudent,
    trend,
    abnormal,
    lessons: activeLessons.map((row) => ({
      id: row.id,
      title: row.title,
      className: row.class_name ?? null,
      teacher: row.teacher_name ?? null,
      startedAt: row.started_at,
      deviceCount: row.device_count,
      assignedCount: row.assigned_count,
    })),
  };
}

// ---------- 老师端：设备 ----------
export function listDevices() {
  const rows = db
    .prepare(
      `SELECT d.*, c.name AS class_name,
              (SELECT COUNT(*) FROM device_apps da WHERE da.device_id = d.id AND da.installed = 1) AS installed_apps,
              (SELECT COUNT(*) FROM device_apps da WHERE da.device_id = d.id AND da.installed = 0) AS uninstalled_apps,
              (SELECT MAX(da.last_seen) FROM device_apps da WHERE da.device_id = d.id) AS last_scan_at,
              (SELECT COUNT(*) FROM violations v WHERE v.device_id = d.id AND v.ts >= ?) AS violations_today,
              (SELECT MAX(ts) FROM heartbeats hb WHERE hb.device_id = d.id) AS last_heartbeat_at,
              seat.lesson_id, seat.lesson_title, seat.student_id AS lesson_student_id,
              seat.student_name AS lesson_student_name, seat.student_no AS lesson_student_no, ds.ts AS screen_ts
       FROM devices d
       LEFT JOIN classes c ON c.id = d.class_id
       LEFT JOIN device_screens ds ON ds.device_id = d.id
       LEFT JOIN (
         SELECT ld.device_id, l.id AS lesson_id, l.title AS lesson_title, ld.student_id, s.name AS student_name, s.student_no
         FROM lessons l JOIN lesson_devices ld ON ld.lesson_id = l.id LEFT JOIN students s ON s.id = ld.student_id
         WHERE l.status = 'active' GROUP BY ld.device_id
       ) seat ON seat.device_id = d.id
       ORDER BY d.id`,
    )
    .all(dayStart());
  return rows.map((row) => ({
    id: row.id,
    serial: row.serial,
    name: row.name,
    model: row.model,
    status: row.status,
    battery: row.battery,
    foregroundApp: row.foreground_app,
    launcherVersion: row.launcher_version,
    appMode: row.app_mode ?? "allowlist",
    ip: row.ip ?? null,
    probePort: row.probe_port ?? null,
    lastProbeAt: row.last_probe_at ?? null,
    installedApps: Number(row.installed_apps),
    uninstalledApps: Number(row.uninstalled_apps),
    lastScanAt: row.last_scan_at ?? null,
    violationsToday: Number(row.violations_today),
    lastSeen: row.last_seen,
    online: deviceOnline(row),
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    offlineReason: offlineReason(row),
    // 谁在用这台：只看正在上的课的当堂分配，设备本身不再绑学生
    student: row.lesson_student_id
      ? { id: row.lesson_student_id, name: row.lesson_student_name, studentNo: row.lesson_student_no }
      : null,
    lesson: row.lesson_id ? { id: row.lesson_id, title: row.lesson_title } : null,
    screenTs: row.screen_ts ?? null,
    class: row.class_id ? { id: row.class_id, name: row.class_name } : null,
    pendingCommands: db.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND acked_at IS NULL").get(row.id).n,
  }));
}

/**
 * 离线到底是为什么：从没连过（后台地址没配对，得把地址推过去）和连过之后不吭声
 * （多半是头显睡了）处置完全不一样，都写成「离线」就只能靠老师猜。
 */
function offlineReason(device) {
  if (deviceOnline(device)) {
    return "";
  }
  if (!device.last_heartbeat_at) {
    return "这台从没往后台报到过：它还不知道后台地址。戴上头显把启动器停在主界面，"
      + "它自己会扫本网段找后台（几秒，地址错了当场改掉）；也可以点「让它连上后台」直接推过去，"
      + "或在头显「设置 → 后台地址」里手填";
  }
  return "连上过，后来不吭声了：多半是头显睡了、或启动器被切到后台。戴上头显或在头显里打开一次启动器，"
    + "十几秒内就会重新心跳；启动器停在主界面期间不会再入睡（已关掉休眠），醒来后它也会自己重新找后台";
}

export function patchDevice(id, body, teacher) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  const changes = [];
  if (typeof body.name === "string" && body.name.trim()) {
    db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(body.name.trim(), device.id);
    changes.push(`改名→${body.name.trim()}`);
  }
  if ("studentId" in body) {
    // 老接口留下的字段：设备和学生不再永久绑定，谁用哪台去「上课」页当堂指定
    throw new HttpError(400, "设备不再绑定学生，请到「上课」页当堂指定谁用哪台");
  }
  if (typeof body.status === "string") {
    if (!["active", "locked", "disabled"].includes(body.status)) {
      throw new HttpError(400, "状态只能是 active / locked / disabled");
    }
    db.prepare("UPDATE devices SET status = ? WHERE id = ?").run(body.status, device.id);
    changes.push(`状态→${body.status}`);
  }
  if (typeof body.appMode === "string") {
    if (!["allowlist", "open"].includes(body.appMode)) {
      throw new HttpError(400, "管控模式只能是 allowlist（只许清单内应用）/ open（自由运行）");
    }
    db.prepare("UPDATE devices SET app_mode = ? WHERE id = ?").run(body.appMode, device.id);
    changes.push(`应用管控→${body.appMode === "allowlist" ? "只许清单内应用" : "自由运行"}`);
  }
  audit(teacher.id, "device.patch", `device:${device.id}`, changes.join("；") || "无改动");
  return { ok: true, changes };
}

export function queueCommand(id, body, teacher) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  const type = String(body.type ?? "");
  if (!["lock", "unlock", "restart", "refresh", "scan", "message"].includes(type)) {
    throw new HttpError(400, "指令不支持");
  }
  if (type === "lock") {
    db.prepare("UPDATE devices SET status = 'locked' WHERE id = ?").run(device.id);
  } else if (type === "unlock") {
    db.prepare("UPDATE devices SET status = 'active' WHERE id = ?").run(device.id);
  }
  const text = typeof body.text === "string" ? body.text : null;
  db.prepare("INSERT INTO commands (device_id, type, payload, created_at) VALUES (?,?,?,?)").run(
    device.id,
    type,
    text ? JSON.stringify({ text }) : null,
    now(),
  );
  audit(teacher.id, "device.command", `device:${device.id}`, `${type}${text ? `：${text}` : ""}`);
  return { ok: true, queued: true };
}

// ---------- 老师端：按 IP 找头显 ----------
/** 探到的身份收成给网页看的形状：应用只报个数，清单本身留到「收编」那一步重新问。 */
function publicIdentity(info, existing) {
  return {
    host: info.host,
    port: info.port,
    serial: info.serial,
    name: info.name,
    model: info.model,
    launcherVersion: info.launcherVersion,
    battery: info.battery,
    foregroundApp: info.foregroundApp,
    ip: info.ip ?? info.host,
    port: info.port,
    appCount: Array.isArray(info.apps) ? info.apps.length : 0,
    // 这台启动器当前连的是哪个后台、连上了没有：收进后台却不上线的，原因基本都在这三个字段里
    serverBaseUrl: info.serverBaseUrl ?? null,
    backendOnline: Boolean(info.backendOnline),
    backendError: info.backendError ?? null,
    known: existing ? { id: existing.id, name: existing.name, status: existing.status } : null,
  };
}

const bySerial = db.prepare("SELECT id, name, status FROM devices WHERE serial = ?");

/**
 * 老师填一个 IP（或 192.168.1 这样的网段前缀），后台反过来去敲它的问话口，
 * 把教室里开着的头显找出来。头显不必先连上后台，新机器第一次开机也能直接认进来。
 */
export async function discoverDevices(body, teacher) {
  const target = parseTarget(body?.target);
  if (target.prefix) {
    const result = await scanSegment(target.host, { port: target.port });
    audit(teacher.id, "device.discover", target.host, `扫网段 ${target.host}.1~254，问到 ${result.found.length} 台`);
    return {
      ok: true,
      mode: "segment",
      target: `${target.host}.*:${target.port}`,
      scanned: result.scanned,
      found: result.found.map((info) => publicIdentity(info, bySerial.get(info.serial))),
      unreachable: result.misses.length,
    };
  }

  const info = await probeDeviceHost(target.host, { port: target.port });
  if (!info.ok) {
    audit(teacher.id, "device.discover", target.host, `问 ${target.host}:${target.port} 没问到：${info.reason}`);
    return { ok: false, mode: "single", target: `${target.host}:${target.port}`, scanned: 1, found: [], reason: info.reason };
  }
  audit(teacher.id, "device.discover", info.serial, `问到 ${target.host}:${target.port} 是「${info.name}」（${info.serial}）`);
  return { ok: true, mode: "single", target: `${target.host}:${target.port}`, scanned: 1, found: [publicIdentity(info, bySerial.get(info.serial))] };
}

/**
 * 把问到的这台收进后台：按序列号有就补信息、没有就登记，顺手把它报的应用清单落库。
 * 收编前重新问一次——网页上那份快照可能已经不新鲜了，入库要以眼前问到的为准。
 */
export async function adoptDevice(body, teacher, publicBase) {
  const target = parseTarget(body?.target);
  if (target.prefix) {
    throw new HttpError(400, `收编要填一台的完整 IP，比如 192.168.1.20（「${target.host}」是一整段网段）`);
  }
  const info = await probeDeviceHost(target.host, { port: target.port });
  if (!info.ok) {
    throw new HttpError(400, `还是问不到 ${target.host}：${info.reason}`);
  }

  const existing = db.prepare("SELECT * FROM devices WHERE serial = ?").get(info.serial);
  let deviceId;
  let created = false;
  if (existing) {
    // 名字是老师起的，不动它；只补这台自己报的型号、版本和现在的地址
    db.prepare(
      "UPDATE devices SET model = ?, launcher_version = ?, ip = ?, probe_port = ?, last_probe_at = ? WHERE id = ?",
    ).run(info.model, info.launcherVersion, info.host, target.port, now(), existing.id);
    deviceId = existing.id;
  } else {
    const inserted = db
      .prepare(
        `INSERT INTO devices (serial, name, model, status, token, app_mode, launcher_version, ip, probe_port, last_probe_at, enrolled_at)
         VALUES (?,?,?,'active',?,'allowlist',?,?,?,?,?)`,
      )
      // last_seen 留给真正的心跳写：收编是后台单方面去敲它，这时就标「在线」会骗人——
      // 老师会看见一台刚收进来就在线、三分钟后突然离线的头显，猜不到是后台地址还没推过去
      .run(info.serial, info.name, info.model, newToken("dev"), info.launcherVersion, info.host, target.port, now(), now());
    deviceId = Number(inserted.lastInsertRowid);
    created = true;
  }

  // 老启动器可能不报应用清单（apps 为 null），这种情况别把之前扫出来的清单冲成空
  const scannedApps = Array.isArray(info.apps) && info.apps.length ? applyDeviceApps(db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId), info.apps) : null;
  audit(
    teacher.id,
    created ? "device.adopt" : "device.adopt.refresh",
    `device:${deviceId}`,
    `按 IP 收编「${info.name}」（${info.serial}）来自 ${target.host}:${target.port}`
      + (scannedApps ? `｜应用 ${scannedApps.scanned} 个，新发现 ${scannedApps.discovered} 个` : "｜这台没报应用清单"),
  );
  // 顺手把后台地址推给它：不推的话老师得戴着头显在「设置」里敲 IP，
  // 而启动器的默认地址是打包时写死的占位，不改就永远显示离线
  const backend = await configureDeviceHost(target.host, { port: target.port, serverBaseUrl: publicBase });
  audit(
    teacher.id,
    backend.ok ? "device.backend" : "device.backend.fail",
    `device:${deviceId}`,
    backend.ok
      ? `已把后台地址推给这台头显：${backend.serverBaseUrl}`
      : `推后台地址没成功：${backend.reason}`,
  );
  return {
    ok: true,
    created,
    id: deviceId,
    serial: info.serial,
    backend: {
      ok: backend.ok,
      serverBaseUrl: backend.serverBaseUrl ?? null,
      reason: backend.reason ?? null,
      applied: Boolean(backend.applied),
    },
    name: existing ? db.prepare("SELECT name FROM devices WHERE id = ?").get(deviceId).name : info.name,
    host: target.host,
    pairingCode: String(deviceId).padStart(4, "0"),
    apps: scannedApps
      ? {
          scanned: scannedApps.scanned,
          discovered: scannedApps.discovered,
          installedCount: scannedApps.installedCount,
          missingCount: scannedApps.missingCount,
        }
      : null,
  };
}

/**
 * 老师点「让它连上后台」：拿这台登记过的 IP 再敲一次问话口，把后台地址推过去。
 * 收编之后换了 IP、或者当初推失败（启动器当时没开），都靠这个补。
 */
export async function pushDeviceBackend(id, body, teacher, publicBase) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  const host = String(body?.host ?? device.ip ?? "").trim();
  if (!host) {
    throw new HttpError(400, `「${device.name}」没留下 IP，后台敲不动它：先按 IP 找一次头显把它收编进来`);
  }
  // 优先按老师这次填的端口，其次照上次问到它的端口问；都没问过才退回默认的 8790
  const port = Number(body?.port ?? device.probe_port ?? DEFAULT_PORT) || DEFAULT_PORT;
  const backend = await configureDeviceHost(host, { port, serverBaseUrl: publicBase });
  audit(
    teacher.id,
    backend.ok ? "device.backend" : "device.backend.fail",
    `device:${device.id}`,
    backend.ok
      ? `已把后台地址推给「${device.name}」（${host}:${port}）：${backend.serverBaseUrl}`
      : `给「${device.name}」推后台地址没成功：${backend.reason}`,
  );
  return {
    ok: backend.ok,
    host,
    port,
    serverBaseUrl: backend.serverBaseUrl ?? null,
    reason: backend.reason ?? null,
    applied: Boolean(backend.applied),
  };
}

// ---------- 老师端：学生 / 班级 ----------
export function listStudents() {
  return db
    .prepare(
      `SELECT s.*, c.name AS class_name,
              ld.device_id AS lesson_device_id, d.name AS lesson_device_name, d.status AS device_status, d.last_seen,
              (SELECT l.title FROM lessons l JOIN lesson_devices ld2 ON ld2.lesson_id = l.id
                WHERE ld2.student_id = s.id AND l.status = 'active' ORDER BY l.id DESC LIMIT 1) AS lesson_title,
              (SELECT u2.lesson_id FROM usage_events u2 WHERE u2.student_id = s.id AND u2.lesson_id IS NOT NULL
                ORDER BY u2.started_at DESC LIMIT 1) AS last_lesson_id,
              (SELECT l2.title FROM lessons l2 WHERE l2.id = (
                 SELECT u3.lesson_id FROM usage_events u3 WHERE u3.student_id = s.id AND u3.lesson_id IS NOT NULL
                 ORDER BY u3.started_at DESC LIMIT 1)) AS last_lesson_title,
              (SELECT MAX(u4.started_at) FROM usage_events u4 WHERE u4.student_id = s.id) AS last_used_at,
              COALESCE((SELECT SUM(seconds) FROM usage_events u WHERE u.student_id = s.id AND u.started_at >= ?),0) AS today_seconds,
              COALESCE((SELECT SUM(seconds) FROM usage_events u WHERE u.student_id = s.id),0) AS total_seconds
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN lesson_devices ld ON ld.student_id = s.id
         AND ld.lesson_id = (SELECT l3.id FROM lessons l3 JOIN lesson_devices ld3 ON ld3.lesson_id = l3.id
                             WHERE ld3.student_id = s.id AND l3.status = 'active' ORDER BY l3.id DESC LIMIT 1)
       LEFT JOIN devices d ON d.id = ld.device_id
       ORDER BY s.class_id, s.student_no`,
    )
    .all(dayStart())
    .map((row) => ({
      id: row.id,
      name: row.name,
      studentNo: row.student_no,
      status: row.status,
      class: row.class_id ? { id: row.class_id, name: row.class_name } : null,
      // 显示「这节课在用哪台」，而不是永久绑定
      device: row.lesson_device_id
        ? {
            id: row.lesson_device_id,
            name: row.lesson_device_name,
            status: row.device_status,
            online: deviceOnline({ last_seen: row.last_seen }),
            lessonTitle: row.lesson_title ?? null,
          }
        : null,
      lastLesson:
        row.last_lesson_id && row.last_lesson_title
          ? { id: row.last_lesson_id, title: row.last_lesson_title, lastUsedAt: row.last_used_at ?? null }
          : null,
      todaySeconds: Number(row.today_seconds),
      totalSeconds: Number(row.total_seconds),
    }));
}

/**
 * 单个学生的使用明细：名单页只有「今日／累计」两个总数，老师真想知道的是
 * 「这孩子到底跑了哪几个应用、各多久、在哪台上、算哪节课」，那就得看这一份。
 */
export function studentUsage(id, query) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(Number(id));
  if (!student) {
    throw new HttpError(404, "学生不存在");
  }
  const days = Math.min(30, Math.max(1, Number(query.get("days") ?? 7)));
  const from = dayStart(now() - (days - 1) * 86400_000);
  const apps = db
    .prepare(
      `SELECT a.name, a.category, SUM(u.seconds) AS seconds, COUNT(*) AS sessions,
              COUNT(DISTINCT u.device_id) AS devices, MAX(u.started_at) AS last_at
       FROM usage_events u JOIN apps a ON a.id = u.app_id
       WHERE u.student_id = ? AND u.started_at >= ?
       GROUP BY a.id ORDER BY seconds DESC`,
    )
    .all(student.id, from)
    .map((row) => ({
      name: row.name,
      category: row.category,
      seconds: Number(row.seconds),
      sessions: row.sessions,
      devices: row.devices,
      lastAt: row.last_at ?? null,
    }));
  const sessions = db
    .prepare(
      `SELECT u.started_at, u.seconds, a.name AS app_name, d.name AS device_name, l.title AS lesson_title
       FROM usage_events u JOIN apps a ON a.id = u.app_id
       LEFT JOIN devices d ON d.id = u.device_id LEFT JOIN lessons l ON l.id = u.lesson_id
       WHERE u.student_id = ? ORDER BY u.started_at DESC LIMIT 20`,
    )
    .all(student.id)
    .map((row) => ({
      startedAt: row.started_at,
      seconds: Number(row.seconds),
      app: row.app_name,
      device: row.device_name ?? "已移出的头显",
      lesson: row.lesson_title ?? null,
    }));
  return {
    student: { id: student.id, name: student.name, studentNo: student.student_no, status: student.status },
    days,
    from,
    rangeSeconds: apps.reduce((sum, row) => sum + row.seconds, 0),
    apps,
    sessions,
  };
}

export function createStudent(body, teacher) {
  const name = String(body.name ?? "").trim();
  const studentNo = String(body.studentNo ?? "").trim();
  if (!name || !studentNo) {
    throw new HttpError(400, "姓名和学号都要填");
  }
  const exists = db.prepare("SELECT id FROM students WHERE student_no = ?").get(studentNo);
  if (exists) {
    throw new HttpError(400, `学号 ${studentNo} 已存在`);
  }
  const info = db
    .prepare("INSERT INTO students (name, student_no, class_id, status, created_at) VALUES (?,?,?,?,?)")
    .run(name, studentNo, body.classId ? Number(body.classId) : null, "active", now());
  audit(teacher.id, "student.create", `student:${info.lastInsertRowid}`, `新增学生 ${name}（${studentNo}）`);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function patchStudent(id, body, teacher) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(Number(id));
  if (!student) {
    throw new HttpError(404, "学生不存在");
  }
  const changes = [];
  if (typeof body.status === "string") {
    if (!["active", "suspended"].includes(body.status)) {
      throw new HttpError(400, "状态只能是 active / suspended");
    }
    db.prepare("UPDATE students SET status = ? WHERE id = ?").run(body.status, student.id);
    changes.push(`状态→${body.status === "active" ? "正常" : "暂停使用"}`);
  }
  // 姓名 / 学号 / 班级都能改了：名字录错、学号写错、学期中途转班，
  // 原来只能删了重录，而一删就把这个学生的时长记录断成两段
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name && name !== student.name) {
    db.prepare("UPDATE students SET name = ? WHERE id = ?").run(name, student.id);
    changes.push(`姓名 ${student.name}→${name}`);
  }
  const studentNo = typeof body.studentNo === "string" ? body.studentNo.trim() : "";
  if (studentNo && studentNo !== student.student_no) {
    const taken = db.prepare("SELECT name FROM students WHERE student_no = ? AND id <> ?").get(studentNo, student.id);
    if (taken) {
      throw new HttpError(400, `学号 ${studentNo} 已经是 ${taken.name} 的了，换个学号再存`);
    }
    db.prepare("UPDATE students SET student_no = ? WHERE id = ?").run(studentNo, student.id);
    changes.push(`学号 ${student.student_no}→${studentNo}`);
  }
  if ("classId" in body) {
    const raw = body.classId;
    const classId = raw === null || raw === "" || raw === undefined ? null : Number(raw);
    if ((student.class_id ?? null) !== classId) {
      let label = "未分班";
      if (classId !== null) {
        const cls = db.prepare("SELECT name FROM classes WHERE id = ?").get(classId);
        if (!cls) {
          throw new HttpError(400, "这个班级不存在，刷新一下页面再重新选");
        }
        label = cls.name;
      }
      db.prepare("UPDATE students SET class_id = ? WHERE id = ?").run(classId, student.id);
      changes.push(classId === null ? "移出班级，改成未分班" : `转到${label}`);
    }
  }
  if (changes.length) {
    audit(teacher.id, "student.update", `student:${student.id}`, `${student.name}：${changes.join("；")}`);
  }
  return { ok: true, changes };
}

export function listClasses() {
  return db
    .prepare(
      `SELECT c.*, COUNT(s.id) AS student_count FROM classes c
       LEFT JOIN students s ON s.class_id = c.id GROUP BY c.id ORDER BY c.id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      grade: row.grade,
      studentCount: row.student_count,
      // 这个班有没有正在上的课：删班之前得让老师看见，课上的班级引用会被清掉
      activeLessons: db
        .prepare("SELECT COUNT(*) AS n FROM lessons WHERE class_id = ? AND status = 'active'")
        .get(row.id).n,
    }));
}

export function createClass(body, teacher) {
  const name = String(body.name ?? "").trim();
  if (!name) {
    throw new HttpError(400, "班级名不能为空");
  }
  // 两个同名班，导入名单和按班配策略就说不清指的是哪一个
  const dup = db.prepare("SELECT id FROM classes WHERE name = ?").get(name);
  if (dup) {
    throw new HttpError(400, `已经有叫「${name}」的班了，换个名字或者直接用它`);
  }
  const info = db
    .prepare("INSERT INTO classes (name, grade, teacher_id, created_at) VALUES (?,?,?,?)")
    .run(name, body.grade ?? null, teacher.id, now());
  audit(teacher.id, "class.create", `class:${info.lastInsertRowid}`, `新增班级 ${name}`);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** 改班级名 / 年级：按班配的策略跟的是班级 id，改名不用重配。 */
export function patchClass(id, body, teacher) {
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(Number(id));
  if (!cls) {
    throw new HttpError(404, "班级不存在");
  }
  const changes = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name && name !== cls.name) {
    const dup = db.prepare("SELECT id FROM classes WHERE name = ? AND id <> ?").get(name, cls.id);
    if (dup) {
      throw new HttpError(400, `已经有另一个叫「${name}」的班了，班级名得各不相同`);
    }
    db.prepare("UPDATE classes SET name = ? WHERE id = ?").run(name, cls.id);
    changes.push(`班级 ${cls.name}→${name}`);
  }
  if ("grade" in body) {
    const grade = body.grade === null || body.grade === "" ? null : String(body.grade).trim();
    if ((cls.grade ?? null) !== grade) {
      db.prepare("UPDATE classes SET grade = ? WHERE id = ?").run(grade, cls.id);
      changes.push(`年级→${grade ?? "清空"}`);
    }
  }
  if (changes.length) {
    audit(teacher.id, "class.update", `class:${cls.id}`, changes.join("；"));
  }
  return { ok: true, changes };
}

/**
 * 删班级：班里的学生不跟着删。第一次点先拦一下报人数，
 * 老师确认后（moveStudents）学生落到「未分班」，时长记录一条不少。
 */
export function deleteClass(id, body, teacher) {
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(Number(id));
  if (!cls) {
    throw new HttpError(404, "班级不存在");
  }
  const students = db.prepare("SELECT COUNT(*) AS n FROM students WHERE class_id = ?").get(cls.id).n;
  if (students > 0 && !body.moveStudents) {
    throw new HttpError(
      400,
      `「${cls.name}」里还有 ${students} 个学生：删掉的话他们会变成未分班（时长记录不丢），再点一次删除确认`,
    );
  }
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE students SET class_id = NULL WHERE class_id = ?").run(cls.id);
    db.prepare("UPDATE devices SET class_id = NULL WHERE class_id = ?").run(cls.id);
    db.prepare("UPDATE lessons SET class_id = NULL WHERE class_id = ?").run(cls.id);
    db.prepare("DELETE FROM policies WHERE scope = 'class' AND scope_id = ?").run(cls.id);
    db.prepare("DELETE FROM classes WHERE id = ?").run(cls.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit(teacher.id, "class.delete", `class:${cls.id}`, `删除班级 ${cls.name}（${students} 个学生改为未分班）`);
  return {
    ok: true,
    notice: students ? `已删掉「${cls.name}」，那 ${students} 个学生现在是未分班，时长记录都还在` : `已删掉「${cls.name}」`,
  };
}

/**
 * 批量导入名单：机房一节课几十个学生，一个个点不现实。
 * 一行一个，写成「学号 姓名」或「姓名 学号」都认（看第一段像不像数字），
 * 想顺带分班再加第三段班级名，班级不存在就当场建一个。
 * 学号已存在的行跳过不算错——老师常是改了名单再整贴一次。
 */
export function bulkCreateStudents(body, teacher) {
  const lines = String(body.text ?? "")
    .split(/[\r\n；;|]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    throw new HttpError(400, "先粘名单再导入：一行一个，写成「学号 姓名」，想顺带分班就再加一段班级名");
  }
  if (lines.length > 300) {
    throw new HttpError(400, `一次最多导入 300 行，现在 ${lines.length} 行，分两次贴`);
  }
  const classIds = new Map(db.prepare("SELECT id, name FROM classes").all().map((row) => [row.name, row.id]));
  const known = new Set(db.prepare("SELECT student_no FROM students").all().map((row) => row.student_no));
  const created = [];
  const skipped = [];
  const newClasses = [];
  db.exec("BEGIN");
  try {
    lines.forEach((line, index) => {
      const parts = line.split(/[\s,，、\t]+/).filter(Boolean);
      const numeric = /^\d[\d.-]*$/.test(parts[0] ?? "");
      const studentNo = String(numeric ? parts[0] : parts[1] ?? "").trim();
      const name = String(numeric ? parts[1] ?? "" : parts[0] ?? "").trim();
      const className = (parts.length > 2 ? parts.slice(2).join("") : "").trim();
      if (!studentNo || !name) {
        skipped.push({ line: index + 1, text: line, reason: "没认出学号和姓名，写成「学号 姓名」两段" });
        return;
      }
      if (known.has(studentNo)) {
        skipped.push({ line: index + 1, text: line, reason: `学号 ${studentNo} 已经在名单里，跳过` });
        return;
      }
      let classId = null;
      if (className) {
        classId = classIds.get(className) ?? null;
        if (classId === null) {
          classId = Number(
            db
              .prepare("INSERT INTO classes (name, grade, teacher_id, created_at) VALUES (?,?,?,?)")
              .run(className, null, teacher.id, now()).lastInsertRowid,
          );
          classIds.set(className, classId);
          newClasses.push(className);
        }
      }
      const info = db
        .prepare("INSERT INTO students (name, student_no, class_id, status, created_at) VALUES (?,?,?,?,?)")
        .run(name, studentNo, classId, "active", now());
      known.add(studentNo);
      created.push({ id: Number(info.lastInsertRowid), name, studentNo, classId });
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit(
    teacher.id,
    "student.bulk",
    "students",
    `批量导入 ${created.length} 个学生${skipped.length ? `，跳过 ${skipped.length} 行` : ""}${
      newClasses.length ? `，顺带新建班级 ${newClasses.join("、")}` : ""
    }`,
  );
  return { ok: true, created, skipped, newClasses };
}

// ---------- 老师端：应用与策略 ----------
export function listApps() {
  const apps = db.prepare("SELECT * FROM apps ORDER BY id").all();
  return apps.map((app) => ({
    id: app.id,
    key: app.key,
    name: app.name,
    packageName: app.package_name,
    category: app.category,
    icon: app.icon,
    version: app.version,
    enabled: Boolean(app.enabled),
    managed: (app.managed ?? 1) === 1,
    source: app.source ?? "manual",
    needsReview: (app.source ?? "manual") === "device" && !app.enabled,
    // 「哪几台装着」直接由头显报上来的扫描结果算，PC 这边不另存一份口径
    installedOn: db
      .prepare(
        `SELECT da.device_id AS id, d.name, da.version, da.last_seen AS lastScanAt
         FROM device_apps da JOIN devices d ON d.id = da.device_id
         WHERE da.package_name = ? AND da.installed = 1
         ORDER BY d.name, d.id`,
      )
      .all(app.package_name)
      .map((row) => ({ id: row.id, name: row.name, version: row.version ?? "", lastScanAt: row.lastScanAt })),
    lastScanAt:
      db
        .prepare("SELECT MAX(last_seen) AS t FROM device_apps WHERE package_name = ? AND installed = 1")
        .get(app.package_name).t ?? null,
    installedDevices: Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM device_apps WHERE package_name = ? AND installed = 1")
        .get(app.package_name).n,
    ),
    todaySeconds: Number(
      db
        .prepare("SELECT COALESCE(SUM(seconds),0) AS s FROM usage_events WHERE app_id = ? AND started_at >= ?")
        .get(app.id, dayStart()).s,
    ),
    deviceCount: Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM policies WHERE app_id = ? AND scope = 'device' AND COALESCE(allowed,1) = 1`,
        )
        .get(app.id).n,
    ),
    policies: db
      .prepare("SELECT scope, scope_id, allowed, daily_minutes, window_start, window_end FROM policies WHERE app_id = ? ORDER BY scope")
      .all(app.id)
      .map((p) => ({
        scope: p.scope,
        scopeId: p.scope_id,
        scopeName: scopeLabel(p.scope) + (p.scope === "global" ? "" : `#${p.scope_id}`),
        allowed: p.allowed,
        dailyMinutes: p.daily_minutes,
        window: p.window_start && p.window_end ? `${p.window_start}-${p.window_end}` : null,
      })),
  }));
}

export function patchApp(id, body, teacher) {
  const app = db.prepare("SELECT * FROM apps WHERE id = ?").get(Number(id));
  if (!app) {
    throw new HttpError(404, "应用不存在");
  }
  if (typeof body.enabled === "boolean") {
    db.prepare("UPDATE apps SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, app.id);
    audit(teacher.id, "app.enabled", `app:${app.id}`, `${app.name} ${body.enabled ? "上架" : "下架"}`);
  }
  if (typeof body.managed === "boolean") {
    db.prepare("UPDATE apps SET managed = ? WHERE id = ?").run(body.managed ? 1 : 0, app.id);
    audit(
      teacher.id,
      "app.managed",
      `app:${app.id}`,
      `${app.name}${body.managed ? "重新纳入管理清单" : "移出管理清单（头显白名单模式会拦下来）"}`,
    );
  }
  return { ok: true };
}

export function registerApp(body, teacher) {
  const key = String(body.key ?? "").trim();
  const name = String(body.name ?? "").trim();
  const pkg = String(body.packageName ?? "").trim();
  if (!key || !name || !pkg) {
    throw new HttpError(400, "key、名称、包名都要填");
  }
  try {
    const info = db
      .prepare(
        "INSERT INTO apps (key, name, package_name, category, icon, version, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(key, name, pkg, body.category ?? "自定义", body.icon ?? "📦", body.version ?? "1.0.0", 1, now());
    audit(teacher.id, "app.create", `app:${info.lastInsertRowid}`, `登记应用 ${name}（${pkg}）`);
    return { ok: true, id: Number(info.lastInsertRowid) };
  } catch (error) {
    throw new HttpError(400, `登记失败：${error.message}`);
  }
}

export function listPolicies() {
  return db
    .prepare(
      `SELECT p.*, a.name AS app_name, a.key AS app_key FROM policies p JOIN apps a ON a.id = p.app_id
       ORDER BY a.id, p.scope`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      appId: row.app_id,
      app: row.app_name,
      appKey: row.app_key,
      scope: row.scope,
      scopeId: row.scope_id,
      scopeName: scopeLabel(row.scope),
      allowed: row.allowed,
      dailyMinutes: row.daily_minutes,
      window: row.window_start && row.window_end ? `${row.window_start}-${row.window_end}` : null,
    }));
}

export function putPolicy(body, teacher) {
  const appId = Number(body.appId);
  const app = db.prepare("SELECT * FROM apps WHERE id = ?").get(appId);
  if (!app) {
    throw new HttpError(404, "应用不存在");
  }
  const scope = String(body.scope ?? "global");
  if (!["global", "class", "student", "device"].includes(scope)) {
    throw new HttpError(400, "范围不对");
  }
  const scopeId = scope === "global" ? 0 : Number(body.scopeId);
  if (scope !== "global" && !scopeId) {
    throw new HttpError(400, "非全校范围必须指定对象");
  }
  const allowed = body.allowed === null || body.allowed === undefined ? null : body.allowed ? 1 : 0;
  const daily = body.dailyMinutes === null || body.dailyMinutes === undefined || body.dailyMinutes === ""
    ? null
    : Number(body.dailyMinutes);
  const windowStart = body.windowStart || null;
  const windowEnd = body.windowEnd || null;
  // 「跟随默认 + 不限时长 + 不限时段」= 这台/这个人没有专属策略，直接删掉行，别在策略列表里留一条全空的记录
  if (allowed === null && daily === null && !windowStart && !windowEnd) {
    db.prepare("DELETE FROM policies WHERE app_id = ? AND scope = ? AND scope_id = ?").run(appId, scope, scopeId);
  } else {
    db.prepare(
      `INSERT INTO policies (app_id, scope, scope_id, allowed, daily_minutes, window_start, window_end, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (app_id, scope, scope_id) DO UPDATE SET
         allowed = excluded.allowed, daily_minutes = excluded.daily_minutes,
         window_start = excluded.window_start, window_end = excluded.window_end, updated_at = excluded.updated_at`,
    ).run(appId, scope, scopeId, allowed, daily, windowStart, windowEnd, now());
  }
  const notice = allowed ? lessonBlockNotice(app, scope, scopeId) : null;
  audit(
    teacher.id,
    "policy.put",
    `app:${appId}/${scope}#${scopeId}`,
    `${app.name}｜${scopeLabel(scope)}｜允许=${allowed === null ? "跟随默认" : allowed ? "是" : "否"}｜每日=${daily ?? "不限"}分钟｜时段=${windowStart ?? "-"}~${windowEnd ?? "-"}`,
  );
  return { ok: true, notice };
}

/**
 * 应用刚允许、学生点开却被拦回桌面，八成是因为正在上的那节课把应用清单限死了。
 * 存策略时顺手看一眼，别让老师自己去猜——判定跟 buildManifest 用的是同一份清单。
 */
function lessonBlockNotice(app, scope, scopeId) {
  const rows = db
    .prepare(
      `SELECT l.title, l.app_keys AS lesson_keys, ld.app_keys AS device_keys,
              d.name AS device_name, s.name AS student_name
       FROM lessons l
       JOIN lesson_devices ld ON ld.lesson_id = l.id
       LEFT JOIN devices d ON d.id = ld.device_id
       LEFT JOIN students s ON s.id = ld.student_id
       WHERE l.status = 'active'
         AND (? = 'global'
           OR (? = 'device' AND ld.device_id = ?)
           OR (? = 'student' AND ld.student_id = ?))`,
    )
    .all(scope, scope, Number(scopeId) || 0, scope, Number(scopeId) || 0);
  const blocked = [];
  for (const row of rows) {
    const keys = jsonKeys(row.device_keys) ?? jsonKeys(row.lesson_keys);
    if (Array.isArray(keys) && !keys.includes(app.key)) {
      const where = [row.device_name, row.student_name].filter(Boolean).join("·");
      blocked.push(`《${row.title}》${where ? `（${where}）` : ""}`);
    }
  }
  if (!blocked.length) {
    return null;
  }
  return `已允许，但 ${blocked.join("、")} 没安排这个应用，现在点开仍会被拦回桌面——去「上课」页把它勾进这节课`;
}

function jsonKeys(text) {
  try {
    const value = JSON.parse(String(text ?? ""));
    return Array.isArray(value) ? value.map(String) : null;
  } catch {
    return null;
  }
}

// ---------- 老师端：报表 ----------
export function reportUsage(query) {
  const days = Math.min(30, Math.max(1, Number(query.get("days") ?? 7)));
  const groupBy = query.get("groupBy") ?? "app";
  if (!["app", "student", "device", "day"].includes(groupBy)) {
    throw new HttpError(400, "groupBy 只支持 app / student / device / day");
  }
  const from = dayStart(now() - (days - 1) * 86400_000);
  let rows;
  if (groupBy === "app") {
    rows = db
      .prepare(
        `SELECT a.name AS label, SUM(u.seconds) AS seconds, COUNT(*) AS sessions, COUNT(DISTINCT u.device_id) AS devices
         FROM usage_events u JOIN apps a ON a.id = u.app_id WHERE u.started_at >= ? GROUP BY a.id ORDER BY seconds DESC`,
      )
      .all(from);
  } else if (groupBy === "student") {
    rows = db
      .prepare(
        `SELECT s.name || '（' || s.student_no || '）' AS label, SUM(u.seconds) AS seconds, COUNT(*) AS sessions,
                COUNT(DISTINCT date(u.started_at / 1000, 'unixepoch')) AS activeDays
         FROM usage_events u JOIN students s ON s.id = u.student_id WHERE u.started_at >= ?
         GROUP BY s.id ORDER BY seconds DESC`,
      )
      .all(from);
  } else if (groupBy === "device") {
    rows = db
      .prepare(
        `SELECT d.name AS label, SUM(u.seconds) AS seconds, COUNT(*) AS sessions, COUNT(DISTINCT u.app_id) AS apps
         FROM usage_events u JOIN devices d ON d.id = u.device_id WHERE u.started_at >= ?
         GROUP BY d.id ORDER BY seconds DESC`,
      )
      .all(from);
  } else {
    rows = db
      .prepare(
        `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS label, SUM(seconds) AS seconds,
                COUNT(DISTINCT device_id) AS devices
         FROM usage_events WHERE started_at >= ? GROUP BY label ORDER BY label`,
      )
      .all(from);
  }
  return {
    days,
    groupBy,
    from,
    rows: rows.map((row) => ({ ...row, seconds: Number(row.seconds) })),
  };
}

export function listAudit(limit = 80) {
  return db
    .prepare(
      `SELECT l.*, t.name AS teacher_name FROM audit_logs l LEFT JOIN teachers t ON t.id = l.teacher_id
       ORDER BY l.id DESC LIMIT ?`,
    )
    .all(Number(limit));
}

// ---------- PICO 学生端 ----------
export function enrollDevice(body) {
  const serial = String(body.serial ?? "").trim();
  if (!serial) {
    throw new HttpError(400, "缺少设备序列号");
  }
  let device = db.prepare("SELECT * FROM devices WHERE serial = ?").get(serial);
  if (!device) {
    const info = db
      .prepare(
        `INSERT INTO devices (serial, name, model, status, launcher_version, enrolled_at, last_seen)
         VALUES (?,?,?,'active',?,?,?)`,
      )
      .run(
        serial,
        String(body.name ?? `${serial} 的头显`),
        String(body.model ?? "PICO 4 Ultra"),
        String(body.launcherVersion ?? "0.1.0"),
        now(),
        now(),
      );
    device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(info.lastInsertRowid));
  }
  if (!device.token) {
    db.prepare("UPDATE devices SET token = ? WHERE id = ?").run(newToken("dev"), device.id);
    device = db.prepare("SELECT * FROM devices WHERE id = ?").get(device.id);
  }
  const manifest = buildManifest(device);
  return {
    deviceId: device.id,
    token: device.token,
    pairingCode: String(device.id).padStart(4, "0"),
    lesson: manifest.lesson?.active ? { id: manifest.lesson.id, title: manifest.lesson.title } : null,
    status: device.status,
  };
}

export function deviceManifest(token) {
  const device = requireDevice(token);
  const manifest = buildManifest(device, { screenIntervalMs: SCREEN_INTERVAL_MS });
  const commands = db
    .prepare("SELECT id, type, payload, created_at FROM commands WHERE device_id = ? AND acked_at IS NULL ORDER BY id")
    .all(device.id);
  return {
    device: {
      id: device.id,
      serial: device.serial,
      name: device.name,
      status: device.status,
      online: true,
    },
    student: manifest.student
      ? { id: manifest.student.id, name: manifest.student.name, studentNo: manifest.student.studentNo }
      : null,
    lesson: manifest.lesson,
    locked: device_requires_lock(db.prepare("SELECT * FROM devices WHERE id = ?").get(device.id), manifest),
    apps: manifest.items,
    mode: manifest.mode,
    local: {
      mode: manifest.mode,
      scanned: manifest.scanned,
      installedCount: manifest.installedCount,
      missingCount: manifest.missingCount,
      lastScanAt: db.prepare("SELECT MAX(last_seen) AS ts FROM device_apps WHERE device_id = ?").get(device.id).ts,
    },
    serverTime: now(),
    pendingCommands: commandsPayload(device.id),
    // 清单版本号：头显心跳时比对它，变了就立刻重拉（见 db.js 的 manifestRev）
    rev: manifestRev(),
  };
}

function device_requires_lock(device, manifest) {
  if (device.status === "locked" || device.status === "disabled") {
    return { locked: true, reason: device.status === "locked" ? "老师已锁定这台头显" : "这台头显已被停用" };
  }
  const student = manifest.student;
  if (student && student.status !== "active") {
    return { locked: true, reason: `${student.name} 已被暂停使用` };
  }
  return { locked: false, reason: "" };
}

export function deviceHeartbeat(token, body) {
  const device = requireDevice(token);
  const battery = body.battery === undefined || body.battery === null ? null : Number(body.battery);
  const foreground = String(body.foregroundApp ?? "") || null;
  if (foreground && foreground !== device.foreground_app) {
    db.prepare("UPDATE device_apps SET launch_count = launch_count + 1 WHERE device_id = ? AND package_name = ?").run(
      device.id,
      foreground,
    );
  }
  db.prepare(
    `UPDATE devices SET last_seen = ?, battery = COALESCE(?, battery), foreground_app = ?, launcher_version = COALESCE(?, launcher_version)
     WHERE id = ?`,
  ).run(now(), battery, foreground, body.launcherVersion ?? null, device.id);
  db.prepare("INSERT INTO heartbeats (device_id, ts, battery, foreground_app, wifi, version) VALUES (?,?,?,?,?,?)").run(
    device.id,
    now(),
    battery,
    String(body.foregroundApp ?? "") || null,
    String(body.wifi ?? "") || null,
    String(body.launcherVersion ?? "") || null,
  );
  // rev 让头显在 10 秒内知道「老师刚改过东西」，不用等下一次 45 秒的清单轮询
  return { ok: true, serverTime: now(), commands: commandsPayload(device.id), status: device.status, rev: manifestRev() };
}

function commandsPayload(deviceId) {
  return db
    .prepare("SELECT id, type, payload, created_at FROM commands WHERE device_id = ? AND acked_at IS NULL ORDER BY id")
    .all(deviceId)
    .map((row) => ({ id: row.id, type: row.type, payload: row.payload ? JSON.parse(row.payload) : null }));
}

export function ackCommands(token, ids) {
  const device = requireDevice(token);
  const list = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
  for (const id of list) {
    db.prepare("UPDATE commands SET acked_at = ? WHERE id = ? AND device_id = ?").run(now(), id, device.id);
  }
  return { ok: true, acked: list.length };
}

export function reportUsageBatch(token, body) {
  const device = requireDevice(token);
  const batchId = String(body.batchId ?? "").trim() || `b${Date.now()}`;
  // 记录算在谁头上、算哪节课：看这节课当堂把这台分给了谁
  const { student, lesson } = studentForDevice(device);
  const studentId = student?.id ?? null;
  const lessonId = lesson?.id ?? null;
  const insert = db.prepare(
    `INSERT INTO usage_events (device_id, app_id, student_id, lesson_id, started_at, ended_at, seconds, batch_id, source)
     VALUES (?,?,?,?,?,?,?,?, 'pico') ON CONFLICT (device_id, app_id, started_at, batch_id) DO NOTHING`,
  );
  let accepted = 0;
  let duplicates = 0;
  for (const event of Array.isArray(body.events) ? body.events : []) {
    const app = event.appKey
      ? db.prepare("SELECT * FROM apps WHERE key = ?").get(String(event.appKey))
      : db.prepare("SELECT * FROM apps WHERE package_name = ?").get(String(event.packageName ?? ""));
    if (!app) {
      duplicates += 1;
      continue;
    }
    const started = Number(event.startedAt);
    const ended = Number(event.endedAt ?? started + Number(event.seconds ?? 0) * 1000);
    const seconds = Math.max(0, Math.round(Number(event.seconds ?? (ended - started) / 1000)));
    if (!started || seconds <= 0) {
      duplicates += 1;
      continue;
    }
    const info = insert.run(device.id, app.id, studentId, lessonId, started, ended, seconds, batchId);
    if (Number(info.changes) > 0) {
      accepted += 1;
    } else {
      duplicates += 1;
    }
  }
  return { ok: true, batchId, accepted, duplicates };
}

// ---------- 设备本机应用：客户端扫描结果同步 + 越权记录 ----------
const SYSTEM_PKG_PREFIXES = [
  "com.android.",
  "android.",
  "com.qualcomm.",
  "com.google.android",
  "com.pico.",
  "com.htc.",
  "com.oplus.",
  "com.unity.",
  "com.unity3d.",
  "org.khronos",
  "com.vive.",
];

function looksSystem(pkg) {
  return SYSTEM_PKG_PREFIXES.some((prefix) => pkg.startsWith(prefix));
}

/** 从包名生成不冲突的应用 key：com.school.vr.ski → ski，重复就加序号 */
function appKeyFromPackage(pkg) {
  const base =
    String(pkg)
      .split(".")
      .filter((part) => part && !["com", "vr", "app", "unity", "renderer"].includes(part))
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9_]/g, "") || "app";
  const named = db.prepare("SELECT key FROM apps").all().map((row) => row.key);
  if (!named.includes(base)) {
    return base;
  }
  let index = 2;
  while (named.includes(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

/**
 * 头显扫描完本机应用后调这个接口：
 * 1）把扫到的应用写进 device_apps（这次没报上来的标记为已卸载）；
 * 2）老师没登记过的第三方应用自动进清单，来源记「头显扫描」、类别先挂「未分类」、默认先不上架，等老师确认。
 */
export function syncDeviceApps(token, body) {
  const device = requireDevice(token);
  const list = Array.isArray(body.apps) ? body.apps : [];
  if (!list.length) {
    throw new HttpError(400, "应用清单是空的，先把启动器连上后台");
  }
  return { ...applyDeviceApps(device, list), serverTime: now() };
}

/**
 * 把「这台装了什么」整份落库：刷新 device_apps，没登记过的第三方应用挂到「待确认」，
 * 这次没报上来的标成已卸载。头显自己上报和老师按 IP 认领都走这里，两条路的账必须一模一样。
 */
function applyDeviceApps(device, list) {
  const known = new Map(db.prepare("SELECT package_name FROM apps").all().map((row) => [row.package_name, row]));
  const seen = new Set();
  let discovered = 0;

  const upsert = db.prepare(
    `INSERT INTO device_apps
       (device_id, package_name, label, version, version_code, is_vr, is_system, installed, first_install, last_update, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?)
     ON CONFLICT (device_id, package_name) DO UPDATE SET
       label = excluded.label, version = excluded.version, version_code = excluded.version_code,
       is_vr = excluded.is_vr, is_system = excluded.is_system, installed = 1,
       first_install = COALESCE(excluded.first_install, device_apps.first_install),
       last_update = COALESCE(excluded.last_update, device_apps.last_update),
       last_seen = excluded.last_seen`,
  );

  for (const raw of list) {
    const pkg = String(raw.packageName ?? "").trim();
    if (!pkg) {
      continue;
    }
    seen.add(pkg);
    const label = String(raw.label ?? pkg).trim() || pkg;
    const version = String(raw.version ?? "").trim();
    const isSystem = raw.isSystem ? 1 : looksSystem(pkg) ? 1 : 0;
    const isVr = raw.isVr ? 1 : 0;
    upsert.run(
      device.id,
      pkg,
      label,
      version,
      Number(raw.versionCode ?? 0) || null,
      isVr,
      isSystem,
      Number(raw.firstInstall ?? 0) || null,
      Number(raw.lastUpdate ?? 0) || null,
      now(),
      now(),
    );

    if (!known.has(pkg) && !isSystem) {
      db.prepare(
        `INSERT INTO apps (key, name, package_name, category, icon, version, enabled, created_at, source)
         VALUES (?,?,?,?,?,?,0,?,'device')
         ON CONFLICT (package_name) DO UPDATE SET version = excluded.version`,
      // 图标先给个中性的：扫描是常态不是「新鲜事」，摆个 🆕 会让学生以为这应用刚装上来
      ).run(appKeyFromPackage(pkg), label, pkg, isVr ? "未分类" : "其他", isVr ? "🎮" : "📦", version || "1.0.0", now());
      discovered += 1;
    }
  }

  // 之前记着装着、这次没报上来 → 已经卸载了
  const previously = db
    .prepare("SELECT package_name FROM device_apps WHERE device_id = ? AND installed = 1")
    .all(device.id)
    .filter((row) => !seen.has(row.package_name));
  for (const row of previously) {
    db.prepare("UPDATE device_apps SET installed = 0, last_seen = ? WHERE device_id = ? AND package_name = ?").run(
      now(),
      device.id,
      row.package_name,
    );
  }

  // 头显上一个都没有了 → 从应用目录退场：这张清单是头显给的，不是后台自己攒的。
  // 只退「老师还没上架过的」（那种是扫描顺手收进来待确认的，头显不报了就没必要留着）；
  // 上过架的留着继续显示「这台没装」，有过时长流水或配过策略的更留着 —— 报表要能对上账。
  // 退场要有「确实卸载了」的凭据：得有一台还在册的头显留下一条 installed=0 的记录。
  // 光看「没有 installed=1」不够 —— 清空数据会抹掉全部扫描记录、删头显也会带走它的记录，
  // 那时候证据是「不知道」不是「卸载了」，一律退场会把老师的应用目录一次清空。
  let retired = 0;
  const gone = db
    .prepare(
      `SELECT a.id, a.name, a.package_name FROM apps a
       WHERE COALESCE(a.source, 'manual') = 'device' AND a.enabled = 0
         AND NOT EXISTS (
           SELECT 1 FROM device_apps da JOIN devices d ON d.id = da.device_id
           WHERE da.package_name = a.package_name AND da.installed = 1
         )
         AND EXISTS (
           SELECT 1 FROM device_apps da JOIN devices d ON d.id = da.device_id
           WHERE da.package_name = a.package_name AND da.installed = 0
         )`,
    )
    .all();
  for (const row of gone) {
    if (
      db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE app_id = ?").get(row.id).n > 0 ||
      db.prepare("SELECT COUNT(*) AS n FROM policies WHERE app_id = ?").get(row.id).n > 0
    ) {
      continue;
    }
    db.prepare("DELETE FROM device_apps WHERE package_name = ?").run(row.package_name);
    db.prepare("UPDATE violations SET app_id = NULL WHERE app_id = ?").run(row.id);
    db.prepare("DELETE FROM apps WHERE id = ?").run(row.id);
    retired += 1;
  }

  const manifest = buildManifest(db.prepare("SELECT * FROM devices WHERE id = ?").get(device.id));
  return {
    ok: true,
    scanned: seen.size,
    discovered,
    retired,
    uninstalled: previously.length,
    installedCount: manifest.installedCount,
    missingCount: manifest.missingCount,
    mode: manifest.mode,
  };
}

/** 白名单模式下学生打开了不在清单里的应用：记一笔，老师在后台看得见。 */
export function reportViolation(token, body) {
  const device = requireDevice(token);
  const pkg = String(body.packageName ?? "").trim();
  if (!pkg) {
    throw new HttpError(400, "缺少包名");
  }
  const app = db.prepare("SELECT id, name FROM apps WHERE package_name = ?").get(pkg);
  const label = String(body.label ?? app?.name ?? pkg);
  const action = String(body.action ?? "blocked");
  const { student, lesson } = studentForDevice(device);
  db.prepare(
    "INSERT INTO violations (device_id, package_name, label, app_id, student_id, lesson_id, action, ts) VALUES (?,?,?,?,?,?,?,?)"
  ).run(device.id, pkg, label, app?.id ?? null, student?.id ?? null, lesson?.id ?? null, action, now());
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (NULL,?,?,?,?)").run(
    "app.violation",
    `device:${device.id}`,
    `${label}（${pkg}）不在允许清单里，已送回桌面`,
    now(),
  );
  return { ok: true };
}

/** 老师看某台头显的本机应用：清单内的逐个带上允许状态，清单外带不上的单独列出来。 */
export function deviceAppInventory(id) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  const manifest = buildManifest(device);
  const rows = db
    .prepare("SELECT * FROM device_apps WHERE device_id = ? ORDER BY installed DESC, is_vr DESC, label")
    .all(device.id);
  const byPackage = new Map(rows.map((row) => [row.package_name, row]));

  const devicePolicies = new Map(
    db
      .prepare("SELECT * FROM policies WHERE scope = 'device' AND scope_id = ?")
      .all(device.id)
      .map((row) => [row.app_id, row]),
  );
  const items = manifest.items.map((item) => {
    const row = byPackage.get(item.packageName);
    byPackage.delete(item.packageName);
    const policy = devicePolicies.get(item.id);
    return {
      ...item,
      deviceAllowed: policy && policy.allowed !== null ? Boolean(policy.allowed) : null,
      deviceDailyMinutes: policy?.daily_minutes ?? null,
      label: row?.label ?? item.name,
      launchCount: row?.launch_count ?? 0,
      firstInstall: row?.first_install ?? null,
      lastScanAt: row?.last_seen ?? null,
      deviceVersion: row?.version ?? "",
    };
  });

  const unmanaged = [...byPackage.values()].map((row) => ({
    appId: db.prepare("SELECT id FROM apps WHERE package_name = ?").get(row.package_name)?.id ?? null,
    key: null,
    name: row.label ?? row.package_name,
    packageName: row.package_name,
    category: row.is_vr ? "未分类" : "系统应用",
    icon: row.is_vr ? "🆕" : "⚙️",
    version: row.version ?? "",
    installedVersion: row.version ?? "",
    installState: row.installed ? "installed" : "missing",
    allowed: false,
    reason: "还没登记进管理清单",
    dailyMinutes: null,
    usedMinutes: 0,
    remainingMinutes: null,
    launchCount: row.launch_count ?? 0,
    firstInstall: row.first_install ?? null,
    lastScanAt: row.last_seen ?? null,
    isVr: Boolean(row.is_vr),
    isSystem: Boolean(row.is_system),
  }));

  return {
    device: {
      id: device.id,
      serial: device.serial,
      name: device.name,
      status: device.status,
      appMode: device.app_mode ?? "allowlist",
      online: deviceOnline(device),
      lastSeen: device.last_seen,
      scanned: manifest.scanned,
      lastScanAt: db.prepare("SELECT MAX(last_seen) AS ts FROM device_apps WHERE device_id = ?").get(device.id).ts,
    },
    installedCount: manifest.installedCount,
    missingCount: manifest.missingCount,
    items,
    unmanaged,
    violations: listViolations(20, device.id),
  };
}

export function listViolations(limit = 60, deviceId = null) {
  const rows = deviceId
    ? db
        .prepare(
          `SELECT v.*, d.name AS device_name, s.name AS student_name FROM violations v
           JOIN devices d ON d.id = v.device_id LEFT JOIN students s ON s.id = v.student_id
           WHERE v.device_id = ? ORDER BY v.ts DESC LIMIT ?`,
        )
        .all(deviceId, Number(limit))
    : db
        .prepare(
          `SELECT v.*, d.name AS device_name, s.name AS student_name FROM violations v
           JOIN devices d ON d.id = v.device_id LEFT JOIN students s ON s.id = v.student_id
           ORDER BY v.ts DESC LIMIT ?`,
        )
        .all(Number(limit));
  return rows.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    device: row.device_name,
    student: row.student_name ?? null,
    packageName: row.package_name,
    label: row.label,
    action: row.action,
    ts: row.ts,
  }));
}

// ---------- 上课：画面转发 ----------
/** 按文件头认图片类型：Unity 传 JPEG，模拟脚本传 PNG，浏览器认内容不认扩展名。 */
function imageMime(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}
/** 头显推上来的一帧 JPEG：落盘 + 当成一次心跳，网页用 <img> 轮询就能看到。 */
export function uploadScreen(ctx) {
  const device = requireDevice(ctx.deviceToken);
  const result = saveScreenFrame(device, ctx.raw, {
    width: ctx.headers?.["x-frame-width"],
    height: ctx.headers?.["x-frame-height"],
    foreground: ctx.headers?.["x-frame-app"],
  });
  db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), device.id);
  return { ...result, intervalMs: SCREEN_INTERVAL_MS };
}

/** 老师在网页上看某台头显的最新一帧。 */
export function screenFrame(id) {
  const deviceId = Number(id);
  if (!db.prepare("SELECT id FROM devices WHERE id = ?").get(deviceId)) {
    throw new HttpError(404, "设备不存在");
  }
  const frame = readScreenFrame(deviceId);
  if (!frame?.data) {
    throw new HttpError(404, "这台头显还没传过画面");
  }
  return { ...frame, contentType: imageMime(frame.data) };
}

export { requireDevice };

// ---------- 老师端：手动增删（设备 / 学生 / 应用 / 本机应用）----------
/** 老师在网页上手工登记一台还没开机配对过的头显，省得先拿到设备再回后台绑学生。 */
export function createDevice(body, teacher) {
  const serial = String(body.serial ?? "").trim();
  if (!serial) {
    throw new HttpError(400, "序列号不能为空（头显「设置」页上能看到）");
  }
  if (db.prepare("SELECT id FROM devices WHERE serial = ?").get(serial)) {
    throw new HttpError(400, `序列号 ${serial} 已经登记过了`);
  }
  const info = db
    .prepare(
      `INSERT INTO devices (serial, name, model, status, token, app_mode, enrolled_at)
       VALUES (?,?,?,'active',?,'allowlist',?)`,
    )
    .run(
      serial,
      String(body.name ?? "").trim() || `头显 ${serial}`,
      String(body.model ?? "").trim() || "PICO 4 Ultra Enterprise",
      newToken("dev"),
      now(),
    );
  const id = Number(info.lastInsertRowid);
  audit(teacher.id, "device.create", `device:${id}`, `登记头显 ${serial}（配对码 ${String(id).padStart(4, "0")}）`);
  return { ok: true, id, pairingCode: String(id).padStart(4, "0") };
}

/** 删除头显：连带它扫到的本机应用、时长、心跳、越权、专属策略一起删，学生解绑后回到「未绑定」。 */
export function deleteDevice(id, body, teacher) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  let inLesson = null;
  db.exec("BEGIN");
  try {
    // 这台要是在某节正在上的课里，删掉它等于悄悄把课上的人抽走：
    // 删完那节课就剩个「上课中」的空壳，老师第二天完全想不起来自己干了什么。
    inLesson = db
      .prepare(
        `SELECT l.title FROM lessons l JOIN lesson_devices ld ON ld.lesson_id = l.id
         WHERE ld.device_id = ? AND l.status = 'active' ORDER BY l.id DESC LIMIT 1`,
      )
      .get(device.id);
    db.prepare("DELETE FROM device_apps WHERE device_id = ?").run(device.id);
    db.prepare("DELETE FROM usage_events WHERE device_id = ?").run(device.id);
    db.prepare("DELETE FROM heartbeats WHERE device_id = ?").run(device.id);
    db.prepare("DELETE FROM commands WHERE device_id = ?").run(device.id);
    db.prepare("DELETE FROM violations WHERE device_id = ?").run(device.id);
    db.prepare("DELETE FROM policies WHERE scope = 'device' AND scope_id = ?").run(device.id);
    db.prepare("DELETE FROM lesson_devices WHERE device_id = ?").run(device.id);
    db.prepare("DELETE FROM device_screens WHERE device_id = ?").run(device.id);
    db.prepare("UPDATE students SET bound_device_id = NULL WHERE bound_device_id = ?").run(device.id);
    db.prepare("DELETE FROM devices WHERE id = ?").run(device.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit(teacher.id, "device.delete", `device:${device.id}`, `删除头显 ${device.name}（${device.serial}）`);
  return {
    ok: true,
    notice: inLesson
      ? `这台正在《${inLesson.title}》这节课里，已一并从课上移出；那节课现在需要重新指定头显`
      : null,
  };
}

/** 删除学生：时长记录留着但把学生置空（报表还能对上账），头显解绑。 */
export function deleteStudent(id, body, teacher) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(Number(id));
  if (!student) {
    throw new HttpError(404, "学生不存在");
  }
  const inLesson = db
    .prepare(
      `SELECT l.title FROM lessons l JOIN lesson_devices ld ON ld.lesson_id = l.id
       WHERE l.status = 'active' AND ld.student_id = ? LIMIT 1`,
    )
    .get(student.id);
  if (inLesson) {
    throw new HttpError(400, `${student.name} 正在「${inLesson.title}」这节课上，先把他从课堂里换下来再删`);
  }
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE devices SET student_id = NULL WHERE student_id = ?").run(student.id);
    db.prepare("UPDATE lesson_devices SET student_id = NULL WHERE student_id = ?").run(student.id);
    db.prepare("UPDATE usage_events SET student_id = NULL WHERE student_id = ?").run(student.id);
    db.prepare("UPDATE violations SET student_id = NULL WHERE student_id = ?").run(student.id);
    db.prepare("DELETE FROM policies WHERE scope = 'student' AND scope_id = ?").run(student.id);
    db.prepare("DELETE FROM students WHERE id = ?").run(student.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit(teacher.id, "student.delete", `student:${student.id}`, `删除学生 ${student.name}（${student.student_no}）`);
  return { ok: true };
}

/** 从管理目录里删掉一个应用，连带它的策略和各台头显上的扫描记录。 */
export function deleteApp(id, body, teacher) {
  const app = db.prepare("SELECT * FROM apps WHERE id = ?").get(Number(id));
  if (!app) {
    throw new HttpError(404, "应用不存在");
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM policies WHERE app_id = ?").run(app.id);
    db.prepare("DELETE FROM device_apps WHERE package_name = ?").run(app.package_name);
    db.prepare("UPDATE violations SET app_id = NULL WHERE app_id = ?").run(app.id);
    db.prepare("DELETE FROM usage_events WHERE app_id = ?").run(app.id);
    db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit(teacher.id, "app.delete", `app:${app.id}`, `删除应用 ${app.name}（${app.package_name}）`);
  return { ok: true };
}

/** 手工往某台头显的本机应用清单里加一条：头显还没扫、或者扫漏了时用。 */
export function addDeviceApp(id, body, teacher) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  const pkg = String(body.packageName ?? "").trim();
  if (!pkg || !pkg.includes(".")) {
    throw new HttpError(400, "包名要写成 com.xxx.yyy 这样");
  }
  const label = String(body.label ?? "").trim() || pkg;
  const isVr = body.isVr === undefined ? true : Boolean(body.isVr);
  db.prepare(
    `INSERT INTO device_apps
       (device_id, package_name, label, version, is_vr, is_system, installed, first_install, last_update, first_seen, last_seen)
     VALUES (?,?,?,?,?,0,1,?,?,?,?)
     ON CONFLICT (device_id, package_name) DO UPDATE SET
       label = excluded.label, version = excluded.version, is_vr = excluded.is_vr,
       installed = 1, last_seen = excluded.last_seen`,
  ).run(
    device.id,
    pkg,
    label,
    String(body.version ?? "").trim() || "1.0.0",
    isVr ? 1 : 0,
    now(),
    now(),
    now(),
    now(),
  );
  audit(teacher.id, "device.app.add", `device:${device.id}`, `${device.name} 手工登记本机应用 ${label}（${pkg}）`);
  return { ok: true };
}

/** 删掉某台头显上的一条本机应用记录（这台不装了 / 扫错了）。 */
export function deleteDeviceApp(id, pkg, teacher) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(Number(id));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  const packageName = decodeURIComponent(String(pkg ?? ""));
  const row = db.prepare("SELECT * FROM device_apps WHERE device_id = ? AND package_name = ?").get(device.id, packageName);
  if (!row) {
    throw new HttpError(
      404,
      `这台头显的本机清单里没有 ${packageName}，没有可删的扫描记录：`
        + "它只是待在管理清单里（这台没装），要把它从这张表里去掉请用「从清单删除」",
    );
  }
  db.prepare("DELETE FROM device_apps WHERE id = ?").run(row.id);
  audit(teacher.id, "device.app.delete", `device:${device.id}`, `${device.name} 移除本机应用 ${row.label ?? packageName}（${packageName}）`);
  return { ok: true };
}

/** 网页上的「清空数据」：和 scripts/reset-data.mjs 同一套实现。 */
export function resetData(body, teacher) {
  const scope = String(body?.scope ?? "run");
  if (!["run", "all"].includes(scope)) {
    throw new HttpError(400, "清空范围只能是 run / all");
  }
  const result = scope === "all" ? clearAllData(db, now) : clearRunData(db, now);
  // 清空时把 sessions 整表删了，这里把当前这次登录补回去，否则点完按钮立刻掉登录
  const keep = teacher.token;
  if (keep && !db.prepare("SELECT token FROM sessions WHERE token = ?").get(keep)) {
    db.prepare("INSERT INTO sessions (token, teacher_id, created_at, expires_at) VALUES (?,?,?,?)").run(
      keep,
      teacher.id,
      now(),
      now() + SESSION_TTL_MS,
    );
  }
  audit(teacher.id, "data.reset", "system", scope === "all" ? "网页端清空全部数据" : "网页端清空模拟数据");
  return { ok: true, scope, ...result };
}
