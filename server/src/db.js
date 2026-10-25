// 数据库：建表、迁移、种子数据。用 Node 自带的 node:sqlite，不装任何第三方包。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.join(here, "..", "data");
mkdirSync(dataDir, { recursive: true });
const dbFile = process.env.SUITE_DB || path.join(dataDir, "suite.db");
export const db = new DatabaseSync(dbFile);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY, account TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'teacher', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, grade TEXT,
  teacher_id INTEGER REFERENCES teachers(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY, serial TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  model TEXT, token TEXT, student_id INTEGER REFERENCES students(id),
  class_id INTEGER REFERENCES classes(id), status TEXT NOT NULL DEFAULT 'active',
  launcher_version TEXT, battery INTEGER, foreground_app TEXT,
  last_seen INTEGER, enrolled_at INTEGER
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, student_no TEXT UNIQUE NOT NULL,
  class_id INTEGER REFERENCES classes(id), status TEXT NOT NULL DEFAULT 'active',
  pin_hash TEXT, bound_device_id INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  package_name TEXT UNIQUE NOT NULL, category TEXT, icon TEXT, version TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL REFERENCES apps(id),
  scope TEXT NOT NULL, scope_id INTEGER NOT NULL DEFAULT 0,
  allowed INTEGER, daily_minutes INTEGER, window_start TEXT, window_end TEXT,
  updated_at INTEGER NOT NULL, UNIQUE (app_id, scope, scope_id)
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id),
  app_id INTEGER NOT NULL REFERENCES apps(id), student_id INTEGER,
  started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, seconds INTEGER NOT NULL,
  batch_id TEXT, source TEXT NOT NULL DEFAULT 'pico',
  UNIQUE (device_id, app_id, started_at, batch_id)
);
CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id),
  ts INTEGER NOT NULL, battery INTEGER, foreground_app TEXT, wifi TEXT, version TEXT
);
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id),
  type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL, acked_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY, teacher_id INTEGER, action TEXT NOT NULL,
  target TEXT, detail TEXT, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_apps (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id),
  package_name TEXT NOT NULL, label TEXT, version TEXT, version_code INTEGER,
  is_vr INTEGER NOT NULL DEFAULT 0, is_system INTEGER NOT NULL DEFAULT 0,
  installed INTEGER NOT NULL DEFAULT 1, first_install INTEGER, last_update INTEGER,
  first_seen INTEGER, last_seen INTEGER, launch_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, package_name)
);
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id),
  package_name TEXT NOT NULL, label TEXT, app_id INTEGER, student_id INTEGER,
  action TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_started ON usage_events (started_at);
CREATE INDEX IF NOT EXISTS idx_usage_student ON usage_events (student_id, started_at);
CREATE INDEX IF NOT EXISTS idx_heart_device ON heartbeats (device_id, ts);
CREATE INDEX IF NOT EXISTS idx_device_apps_device ON device_apps (device_id, installed);
CREATE INDEX IF NOT EXISTS idx_violations_ts ON violations (ts, device_id);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, class_id INTEGER REFERENCES classes(id),
  teacher_id INTEGER REFERENCES teachers(id), status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL, ended_at INTEGER, note TEXT, app_keys TEXT
);
CREATE TABLE IF NOT EXISTS lesson_devices (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id),
  device_id INTEGER NOT NULL REFERENCES devices(id),
  student_id INTEGER REFERENCES students(id),
  app_keys TEXT, assigned_at INTEGER, enrolled_at INTEGER NOT NULL,
  UNIQUE (lesson_id, device_id)
);
CREATE TABLE IF NOT EXISTS device_screens (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id),
  ts INTEGER NOT NULL, bytes INTEGER, width INTEGER, height INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lesson_devices_device ON lesson_devices (device_id, lesson_id);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`);
// devices 建表时引用了尚未创建的 students，SQLite 只在启用外键时校验，这里补一次完整检查
db.exec("PRAGMA foreign_key_check");

// 老库升级：补上「应用管控模式」和「应用来源」两列
const deviceColumns = db.prepare("PRAGMA table_info(devices)").all().map((row) => row.name);
if (!deviceColumns.includes("app_mode")) {
  db.exec("ALTER TABLE devices ADD COLUMN app_mode TEXT NOT NULL DEFAULT 'allowlist'");
}
// 老库升级：记下「按 IP 找头显」问到它的地址和时间（问到的地址比头显自己报的准）
if (!deviceColumns.includes("ip")) {
  db.exec("ALTER TABLE devices ADD COLUMN ip TEXT");
}
if (!deviceColumns.includes("last_probe_at")) {
  db.exec("ALTER TABLE devices ADD COLUMN last_probe_at INTEGER");
}
// 老库升级：记下问话口的端口（默认 8790，非默认的只有自检和自己改过端口的机器），
// 不然「让它连上后台」永远只敲 8790，问到过却推不动
if (!deviceColumns.includes("probe_port")) {
  db.exec("ALTER TABLE devices ADD COLUMN probe_port INTEGER");
}
const appColumns = db.prepare("PRAGMA table_info(apps)").all().map((row) => row.name);
if (!appColumns.includes("source")) {
  db.exec("ALTER TABLE apps ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
}
if (!appColumns.includes("managed")) {
  db.exec("ALTER TABLE apps ADD COLUMN managed INTEGER NOT NULL DEFAULT 1");
}
// 老库升级：扫描收录的应用原先记成「设备发现」，和「按 IP 找头显」撞名，统一改成「未分类」
db.exec("UPDATE apps SET category = '未分类' WHERE category = '设备发现'");
// 同理，扫出来的应用图标不再摆 🆕（那是「刚发现」的意思，可扫描天天都在做）
db.exec("UPDATE apps SET icon = '🎮' WHERE icon = '🆕'");

// 老库升级：使用记录改成挂在课堂上（学生来自课堂分配，不再依赖设备绑定）
const usageColumns = db.prepare("PRAGMA table_info(usage_events)").all().map((row) => row.name);
if (!usageColumns.includes("lesson_id")) {
  db.exec("ALTER TABLE usage_events ADD COLUMN lesson_id INTEGER");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_usage_lesson ON usage_events (lesson_id, student_id)");
const violationColumns = db.prepare("PRAGMA table_info(violations)").all().map((row) => row.name);
if (!violationColumns.includes("lesson_id")) {
  db.exec("ALTER TABLE violations ADD COLUMN lesson_id INTEGER");
}

/**
 * 清单版本号：老师在网页上做任何改动（放开应用、点名、下课、锁定…）就 +1。
 * 头显每次心跳顺手看一眼这个数，和上次拿到的清单对不上就立刻重拉清单，
 * 不用干等 45 秒的定时轮询——「老师点了允许，学生那边半天没反应」是机房里最常见的抱怨。
 * 计数只增不减、也不区分改了谁：多拉一次清单很便宜，漏拉一次才是问题。
 */
const REV_KEY = "manifest_rev";
db.prepare("INSERT INTO state (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM state WHERE key = ?)").run(
  REV_KEY,
  "1",
  REV_KEY,
);

export function manifestRev() {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(REV_KEY);
  return Number(row?.value ?? "1") || 1;
}

export function bumpManifestRev() {
  const next = manifestRev() + 1;
  db.prepare("UPDATE state SET value = ? WHERE key = ?").run(String(next), REV_KEY);
  return next;
}

const now = () => Date.now();
const dayStart = (ts = now()) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function seed() {
  const teachers = db.prepare("SELECT COUNT(*) AS n FROM teachers").get().n;
  if (teachers > 0) {
    return false;
  }

  const insertTeacher = db.prepare(
    "INSERT INTO teachers (account, name, pass_hash, role, created_at) VALUES (?,?,?,?,?)",
  );
  const teacherId = Number(
    insertTeacher.run("admin", "王老师", hashPassword("pico123456"), "admin", now()).lastInsertRowid,
  );

  const insertClass = db.prepare("INSERT INTO classes (name, grade, teacher_id, created_at) VALUES (?,?,?,?)");
  const classA = Number(insertClass.run("初三(2)班", "初三", teacherId, now()).lastInsertRowid);
  const classB = Number(insertClass.run("初二(1)班", "初二", teacherId, now()).lastInsertRowid);

  // 设备属于机房，学生属于班级，两边互不绑定；谁用哪台由「上课」页当堂指定
  const insertDevice = db.prepare(
    `INSERT INTO devices (serial, name, model, student_id, class_id, status, battery, last_seen, enrolled_at)
     VALUES (?,?,?,NULL,NULL,?,?,?,?)`,
  );
  const insertStudent = db.prepare(
    "INSERT INTO students (name, student_no, class_id, status, bound_device_id, created_at) VALUES (?,?,?,?,NULL,?)",
  );

  const rack = [
    ["PICO-4U-A1B2C3", "VR 头显 01", "active", 82],
    ["PICO-4U-D4E5F6", "VR 头显 02", "active", 64],
    ["PICO-4U-G7H8I9", "VR 头显 03", "active", 91],
    ["PICO-4U-J1K2L3", "VR 头显 04", "locked", 47],
    ["PICO-4U-M4N5O6", "VR 头显 05", "active", 73],
  ];
  for (const [serial, name, status, battery] of rack) {
    insertDevice.run(
      serial,
      name,
      "PICO 4 Ultra Enterprise",
      status,
      battery,
      now() - Math.floor(Math.random() * 40) * 60_000,
      now() - 6 * 86400_000,
    );
  }

  const roster = [
    ["陈嘉禾", "2026030201", classA],
    ["林思远", "2026030202", classA],
    ["黄梓瑜", "2026030203", classA],
    ["吴俊熹", "2026030204", classA],
    ["郑安琪", "2026010101", classB],
    ["周砚舟", "2026010102", classB],
  ];
  for (const [name, no, classId] of roster) {
    insertStudent.run(name, no, classId, "active", now());
  }

  const insertApp = db.prepare(
    `INSERT INTO apps (key, name, package_name, category, icon, version, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const catalog = [
    ["ski", "雪山滑雪", "com.school.vr.ski", "运动协调", "🎿", "1.0.0", 1],
    ["shooting", "射击打靶", "com.school.vr.shooting", "专注训练", "🎯", "1.0.0", 1],
    ["therapy", "心理拓展·疗法训练", "com.school.vr.therapy", "心理调适", "🌿", "1.0.0", 1],
    ["browser", "PICO 浏览器", "com.pico.vr.browser", "系统工具", "🧭", "1.0.0", 0],
    ["store", "PICO 商店", "com.pico.vr.store", "系统工具", "🛒", "1.0.0", 0],
  ];
  for (const [key, name, pkg, category, icon, version, enabled] of catalog) {
    insertApp.run(key, name, pkg, category, icon, version, enabled, now());
  }

  // 演示策略：雪山滑雪每人每天 40 分钟、射击打靶 30 分钟；浏览器/商店整机禁用。
  // 故意**不铺「允许时段」**：时段一塞进种子，就等于「下午三点之外心理拓展都是灰的」——
  // 老师早上或放学后来演示，看着像坏了；接口自检也会变成看时钟脸色（晚上跑必挂一条）。
  // 时段逻辑由 scripts/api-test.mjs 自己造窗口来验（挑必定含/必定不含当前时刻的两个窗口）。
  const insertPolicy = db.prepare(
    `INSERT INTO policies (app_id, scope, scope_id, allowed, daily_minutes, window_start, window_end, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const appId = (key) => db.prepare("SELECT id FROM apps WHERE key = ?").get(key).id;
  insertPolicy.run(appId("ski"), "global", 0, 1, 40, null, null, now());
  insertPolicy.run(appId("shooting"), "global", 0, 1, 30, null, null, now());
  insertPolicy.run(appId("browser"), "global", 0, 0, null, null, null, now());
  insertPolicy.run(appId("store"), "global", 0, 0, null, null, null, now());

  // 昨天的历史时长，让报表第一屏就有曲线
  const insertUsage = db.prepare(
    `INSERT INTO usage_events (device_id, app_id, student_id, started_at, ended_at, seconds, batch_id, source)
     VALUES (?,?,?,?,?,?,?, 'seed')`,
  );
  const devices = db.prepare("SELECT id, student_id, class_id FROM devices").all();
  const appKeys = ["ski", "shooting", "therapy"];
  for (let back = 6; back >= 1; back -= 1) {
    const base = dayStart(now() - back * 86400_000) + 9 * 3600_000;
    for (const device of devices) {
      for (const key of appKeys.slice(0, 1 + ((back + device.id) % 3))) {
        const seconds = 600 + Math.floor(Math.random() * 1500);
        const started = base + Math.floor(Math.random() * 3 * 3600_000);
        insertUsage.run(
          device.id,
          appId(key),
          device.student_id,
          started,
          started + seconds * 1000,
          seconds,
          `seed-${back}-${device.id}-${key}`,
        );
      }
    }
  }

  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (?,?,?,?,?)").run(
    teacherId,
    "seed",
    "system",
    "初始化演示数据（老师 admin / 密码 pico123456）",
    now(),
  );
  return true;
}

// 演示数据只在第一次建库时铺。之前是「表空了就铺」，跑过 scripts/reset-data.mjs 之后一重启后台
// 演示数据又会自己长回来，看起来像没清干净。
if (seed()) {
  seedDeviceApps();
}

/**
 * 演示用的「设备本机应用」：真实环境由头显扫描后调 POST /devices/apps/sync 写入，
 * 这里按种子应用先铺一遍，老师第一次打开后台就能看到本机应用页（没铺到的应用 = 未安装）。
 */
function seedDeviceApps() {
  if (db.prepare("SELECT COUNT(*) AS n FROM device_apps").get().n > 0) {
    return;
  }
  const devices = db.prepare("SELECT id FROM devices").all();
  const apps = db.prepare("SELECT key, name, package_name, version FROM apps").all();
  if (!devices.length || !apps.length) {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO device_apps
     (device_id, package_name, label, version, is_vr, is_system, installed, first_install, last_update, first_seen, last_seen)
     VALUES (?,?,?,?,?,1,1,?,?,?,?)`,
  );
  const systemKeys = new Set(["browser", "store"]);
  for (const device of devices) {
    for (const app of apps) {
      // 3 号头显故意没装心理拓展，页面上能看到「未安装」的样式
      if (device.id === 3 && app.key === "therapy") {
        continue;
      }
      const isVr = systemKeys.has(app.key) ? 0 : 1;
      insert.run(
        device.id,
        app.package_name,
        app.name,
        app.version,
        isVr,
        now() - 6 * 86400_000,
        now() - 2 * 86400_000,
        now() - 6 * 86400_000,
        now() - Math.floor(Math.random() * 30) * 60_000,
      );
    }
  }
}

export { now, dayStart };
