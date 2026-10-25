// 策略计算：服务端和 PICO 端用同一套判断，端上离线时按最后一次结果执行。
import { db, now, dayStart } from "./db.js";
import { studentForDevice, lessonForManifest } from "./lesson.js";

/**
 * 多久没心跳就算离线。头显每 10 秒心跳一次，留 4 次余量＝45 秒。
 * 原先是 3 分钟：头显睡了、被学生划掉了，网页上还挂着「在线」将近三分钟，
 * 老师照着「在线」的数目点「让 N 台头显重新扫描」，点完一台都没动，只能怀疑网页坏了。
 */
const ONLINE_WINDOW_MS = 45_000;

export function resolvePolicy(app, scopes) {
  for (const scope of ["device", "student", "class", "global"]) {
    const hit = scopes.find((item) => item.scope === scope);
    if (hit) {
      return { scope, policy: hit };
    }
  }
  return { scope: "app", policy: { allowed: app.enabled ? 1 : 0 } };
}

export function inWindow(windowStart, windowEnd, at = now()) {
  if (!windowStart || !windowEnd) {
    return { ok: true };
  }
  const date = new Date(at);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const ok = hhmm >= windowStart && hhmm <= windowEnd;
  return { ok, current: hhmm };
}

export function usedSecondsToday({ deviceId, studentId, appId }) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(seconds), 0) AS seconds FROM usage_events
       WHERE app_id = ? AND started_at >= ? AND (device_id = ? OR student_id = ?)`,
    )
    .get(appId, dayStart(), deviceId ?? -1, studentId ?? -1);
  return Number(row.seconds);
}

/** 组装下发给某台设备的完整清单：每个应用能不能跑、为什么不能跑、今天还剩多少分钟。 */
export function buildManifest(device, options = {}) {
  // 谁在用这台：以正在上的课的当堂分配为准，没上课时才退回设备上遗留的绑定
  const { student, lesson } = studentForDevice(device);
  const lessonKeys = lesson?.appKeys?.length ? new Set(lesson.appKeys) : null;
  const appRows = db.prepare("SELECT * FROM apps WHERE managed = 1 ORDER BY category, id").all();
  // 头显扫描上来的本机应用：没扫过的设备不谎报「未安装」
  const installedRows = db
    .prepare("SELECT package_name, version FROM device_apps WHERE device_id = ? AND installed = 1")
    .all(device.id);
  const installedVersion = new Map(installedRows.map((row) => [row.package_name, row.version ?? ""]));
  const scanned = installedRows.length > 0;
  const policies = db
    .prepare(
      `SELECT * FROM policies WHERE (scope = 'global')
       OR (scope = 'class' AND scope_id = ?)
       OR (scope = 'student' AND scope_id = ?)
       OR (scope = 'device' AND scope_id = ?)`,
    )
    .all(device.class_id ?? -1, student?.id ?? -1, device.id);

  const items = appRows.map((app) => {
    const mine = policies.filter((p) => p.app_id === app.id);
    const scoped = [
      ...mine.filter((p) => p.scope === "device" && p.scope_id === device.id),
      ...mine.filter((p) => p.scope === "student" && student && p.scope_id === student.id),
      ...mine.filter((p) => p.scope === "class" && device.class_id && p.scope_id === device.class_id),
      ...mine.filter((p) => p.scope === "global"),
    ];
    const { scope, policy } = resolvePolicy(app, scoped);

    let allowed = policy.allowed === null || policy.allowed === undefined ? Boolean(app.enabled) : Boolean(policy.allowed);
    const reasons = [];
    if (!allowed) {
      reasons.push(scope === "global" ? "老师已全局停用" : `老师已为${scopeLabel(scope)}停用`);
    }

    const inLesson = !lessonKeys || lessonKeys.has(app.key);
    if (allowed && !inLesson) {
      allowed = false;
      reasons.push(`《${lesson.title}》这节课没安排这个应用`);
    }

    const windowCheck = inWindow(policy.window_start, policy.window_end);
    if (allowed && !windowCheck.ok) {
      allowed = false;
      reasons.push(`不在允许时段 ${policy.window_start}-${policy.window_end}（现在 ${windowCheck.current}）`);
    }

    const usedSeconds = usedSecondsToday({ deviceId: device.id, studentId: student?.id, appId: app.id });
    const limit = policy.daily_minutes ?? null;
    let remaining = null;
    if (limit !== null && limit !== undefined) {
      remaining = Math.max(0, limit - Math.floor(usedSeconds / 60));
      if (allowed && remaining <= 0) {
        allowed = false;
        reasons.push(`今日 ${limit} 分钟已用完`);
      }
    }

    return {
      id: app.id,
      key: app.key,
      name: app.name,
      packageName: app.package_name,
      category: app.category,
      icon: app.icon,
      version: app.version,
      allowed,
      reason: reasons.join("；"),
      inLesson: lesson ? inLesson : null,
      scope,
      dailyMinutes: limit,
      usedMinutes: Math.floor(usedSeconds / 60),
      remainingMinutes: remaining,
      window: policy.window_start && policy.window_end ? `${policy.window_start}-${policy.window_end}` : null,
      installState: !scanned ? "unknown" : installedVersion.has(app.package_name) ? "installed" : "missing",
      installedVersion: installedVersion.get(app.package_name) ?? "",
    };
  });

  const installedCount = items.filter((item) => item.installState === "installed").length;
  const missingCount = items.filter((item) => item.installState === "missing").length;
  return {
    items,
    student,
    lesson: options.screenIntervalMs
      ? lessonForManifest(device.id, options.screenIntervalMs)
      : lesson
        ? { active: true, id: lesson.id, title: lesson.title, className: lesson.className, appKeys: lesson.appKeys ?? [] }
        : { active: false },
    mode: device.app_mode ?? "allowlist",
    scanned,
    installedCount,
    missingCount,
  };
}

export function scopeLabel(scope) {
  return { global: "全校", class: "该班级", student: "该学生", device: "该头显", app: "应用默认" }[scope] ?? scope;
}

export function deviceOnline(device) {
  return Boolean(device.last_seen) && now() - device.last_seen < ONLINE_WINDOW_MS;
}

export { ONLINE_WINDOW_MS };
