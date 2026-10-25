// 上课（课堂）：老师开一节课，把「哪个学生用哪台头显、这节课能跑哪些应用」临时定下来。
// 设备和学生之间不再有永久绑定，所有使用记录都挂在课堂上，记录里的学生来自课上的分配。
import { db, now, dayStart, dataDir } from "./db.js";
import { HttpError } from "./http-error.js";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

export const screenDir = path.join(dataDir, "screens");
mkdirSync(screenDir, { recursive: true });

const ONLINE_WINDOW_MS = 3 * 60_000;
const online = (device) => Boolean(device?.last_seen) && now() - device.last_seen < ONLINE_WINDOW_MS;
const parseKeys = (raw) => {
  try {
    const list = JSON.parse(raw ?? "null");
    return Array.isArray(list) ? list.map(String) : null;
  } catch {
    return null;
  }
};

/** 这台头显当前在不在一节正在上的课里；在的话返回课堂 + 分配记录。 */
export function activeLessonForDevice(deviceId) {
  const row = db
    .prepare(
      `SELECT l.id, l.title, l.class_id, l.started_at, l.note, l.app_keys AS lesson_app_keys,
              c.name AS class_name, t.name AS teacher_name,
              ld.student_id, ld.app_keys, ld.assigned_at, s.name AS student_name, s.student_no, s.class_id AS student_class_id
       FROM lessons l
       JOIN lesson_devices ld ON ld.lesson_id = l.id AND ld.device_id = ?
       LEFT JOIN classes c ON c.id = l.class_id
       LEFT JOIN teachers t ON t.id = l.teacher_id
       LEFT JOIN students s ON s.id = ld.student_id
       WHERE l.status = 'active'
       ORDER BY l.started_at DESC LIMIT 1`,
    )
    .get(deviceId);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    title: row.title,
    classId: row.class_id,
    className: row.class_name ?? null,
    teacher: row.teacher_name ?? null,
    startedAt: row.started_at,
    note: row.note ?? null,
    // 这台单独定过就用这台的；没定过就跟随整节课的清单（中途加进来的头显也一样受限）
    appKeys: parseKeys(row.app_keys) ?? parseKeys(row.lesson_app_keys),
    student: row.student_id
      ? {
          id: row.student_id,
          name: row.student_name,
          studentNo: row.student_no,
          status: db.prepare("SELECT status FROM students WHERE id = ?").get(row.student_id)?.status ?? "active",
          classId: row.student_class_id,
        }
      : null,
  };
}

/** 这节课的使用者：以课上分配为准，没有课堂时才退回设备上遗留的绑定。 */
export function studentForDevice(device) {
  const lesson = activeLessonForDevice(device.id);
  if (lesson?.student) {
    return { student: lesson.student, lesson };
  }
  const legacy = device.student_id ? db.prepare("SELECT * FROM students WHERE id = ?").get(device.student_id) : null;
  return {
    student: legacy ? { id: legacy.id, name: legacy.name, studentNo: legacy.student_no, status: legacy.status, classId: legacy.class_id } : null,
    lesson,
  };
}

function activeLessonOf(teacherId) {
  return db.prepare("SELECT * FROM lessons WHERE status = 'active' AND teacher_id = ? ORDER BY id DESC LIMIT 1").get(teacherId) ?? null;
}

function lessonDevices(lessonId) {
  return db
    .prepare(
      `SELECT ld.*, d.name AS device_name, d.serial, d.model, d.status AS device_status, d.battery,
              d.last_seen, d.foreground_app, d.app_mode, s.name AS student_name, s.student_no, s.class_id AS student_class_id
       FROM lesson_devices ld
       JOIN devices d ON d.id = ld.device_id
       LEFT JOIN students s ON s.id = ld.student_id
       WHERE ld.lesson_id = ? ORDER BY d.id`,
    )
    .all(lessonId);
}

/** 课堂里每台头显的实时情况：谁在用、跑了多久、画面到什么时候为止。 */
function deviceRowsWithRuntime(lessonId) {
  const seconds = db
    .prepare(
      `SELECT device_id, COALESCE(SUM(seconds),0) AS seconds, COUNT(*) AS sessions
       FROM usage_events WHERE lesson_id = ? GROUP BY device_id`,
    )
    .all(lessonId);
  const byDevice = new Map(seconds.map((row) => [row.device_id, row]));
  const screens = new Map(
    db.prepare("SELECT device_id, ts, bytes, width, height FROM device_screens WHERE device_id IN (SELECT device_id FROM lesson_devices WHERE lesson_id = ?)")
      .all(lessonId)
      .map((row) => [row.device_id, row]),
  );
  return lessonDevices(lessonId).map((row) => {
    const used = byDevice.get(row.device_id) ?? { seconds: 0, sessions: 0 };
    const screen = screens.get(row.device_id) ?? null;
    const device = { id: row.device_id, last_seen: row.last_seen };
    return {
      deviceId: row.device_id,
      name: row.device_name,
      serial: row.serial,
      model: row.model,
      status: row.device_status,
      online: online(device),
      battery: row.battery,
      lastSeen: row.last_seen,
      foregroundApp: row.foreground_app,
      student: row.student_id ? { id: row.student_id, name: row.student_name, studentNo: row.student_no } : null,
      appKeys: parseKeys(row.app_keys),
      assignedAt: row.assigned_at ?? null,
      usedSeconds: Number(used.seconds),
      sessions: Number(used.sessions),
      screen: screen ? { ts: screen.ts, bytes: screen.bytes, width: screen.width, height: screen.height } : null,
    };
  });
}

/** 这节课已经产生的使用记录，按学生 × 应用汇总（记录和学生绑定就在这里）。 */
export function lessonSummary(lessonId) {
  return db
    .prepare(
      `SELECT u.student_id, s.name AS student_name, s.student_no, u.device_id, d.name AS device_name,
              u.app_id, a.name AS app_name, a.icon, SUM(u.seconds) AS seconds, COUNT(*) AS sessions,
              MAX(u.ended_at) AS last_end
       FROM usage_events u
       LEFT JOIN students s ON s.id = u.student_id
       LEFT JOIN devices d ON d.id = u.device_id
       JOIN apps a ON a.id = u.app_id
       WHERE u.lesson_id = ?
       GROUP BY u.student_id, u.device_id, u.app_id
       ORDER BY seconds DESC`,
    )
    .all(lessonId)
    .map((row) => ({
      studentId: row.student_id,
      student: row.student_name ? { id: row.student_id, name: row.student_name, studentNo: row.student_no } : null,
      deviceId: row.device_id,
      device: row.device_name,
      appId: row.app_id,
      app: row.app_name,
      icon: row.icon,
      seconds: Number(row.seconds),
      sessions: Number(row.sessions),
      lastEnd: row.last_end,
    }));
}

function lessonPayload(lesson) {
  const devices = deviceRowsWithRuntime(lesson.id);
  const rows = lessonSummary(lesson.id);
  const totalSeconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const classNames = new Map(db.prepare("SELECT id, name FROM classes").all().map((row) => [row.id, row.name]));
  return {
    id: lesson.id,
    title: lesson.title,
    classId: lesson.class_id,
    className: lesson.class_id ? classNames.get(lesson.class_id) ?? null : null,
    status: lesson.status,
    startedAt: lesson.started_at,
    endedAt: lesson.ended_at ?? null,
    note: lesson.note ?? null,
    appKeys: parseKeys(lesson.app_keys),
    devices,
    summary: rows,
    totals: {
      devices: devices.length,
      assigned: devices.filter((row) => row.student).length,
      online: devices.filter((row) => row.online).length,
      seconds: totalSeconds,
      students: new Set(rows.map((row) => row.studentId).filter(Boolean)).size,
    },
  };
}

/** 老师点「开课」：把选中的头显拉进这节课，应用清单留空表示跟随后台全局清单。 */
export function startLesson(body, teacher) {
  const title = String(body.title ?? "").trim();
  if (!title) {
    throw new HttpError(400, "课程名称不能为空");
  }
  const deviceIds = [...new Set((Array.isArray(body.deviceIds) ? body.deviceIds : []).map(Number).filter(Boolean))];
  if (!deviceIds.length) {
    throw new HttpError(400, "至少选一台头显");
  }
  const existing = activeLessonOf(teacher.id);
  if (existing) {
    throw new HttpError(400, `「${existing.title}」还没下课，先下课再开新课`);
  }
  const devices = deviceIds.map((id) => db.prepare("SELECT * FROM devices WHERE id = ?").get(id)).filter(Boolean);
  if (devices.length !== deviceIds.length) {
    throw new HttpError(400, "有头显不存在，刷新页面重新选");
  }
  const taken = devices
    .map((device) => activeLessonForDevice(device.id))
    .find((lesson) => lesson);
  if (taken) {
    throw new HttpError(400, `有头显正在「${taken.title}」这节课里，先把那节课下了`);
  }
  const appKeys = Array.isArray(body.appKeys) && body.appKeys.length ? JSON.stringify(body.appKeys.map(String)) : null;

  db.exec("BEGIN");
  let lessonId;
  try {
    lessonId = Number(
      db
        .prepare("INSERT INTO lessons (title, class_id, teacher_id, status, started_at, note, app_keys) VALUES (?,?,?,'active',?,?,?)")
        .run(title, body.classId ? Number(body.classId) : null, teacher.id, now(), String(body.note ?? "").trim() || null, appKeys)
        .lastInsertRowid,
    );
    // app_keys 留空 = 这台跟随整节课的清单，之后老师改整节课的清单这台自动跟着变
    const insert = db.prepare("INSERT INTO lesson_devices (lesson_id, device_id, student_id, app_keys, enrolled_at) VALUES (?,?,?,NULL,?)");
    for (const device of devices) {
      insert.run(lessonId, device.id, null, now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (?,?,?,?,?)").run(
    teacher.id,
    "lesson.start",
    `lesson:${lessonId}`,
    `开课《${title}》，${devices.length} 台头显`,
    now(),
  );
  return { ok: true, id: lessonId, ...lessonPayload(db.prepare("SELECT * FROM lessons WHERE id = ?").get(lessonId)) };
}

/** 上课中或历史的一节课，带每台头显的画面与实时时长。 */
export function getLesson(id) {
  const lesson = db.prepare("SELECT * FROM lessons WHERE id = ?").get(Number(id));
  if (!lesson) {
    throw new HttpError(400, "课堂不存在");
  }
  return lessonPayload(lesson);
}

export function currentLesson(teacher) {
  const lesson = activeLessonOf(teacher.id) ?? db.prepare("SELECT * FROM lessons WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  return lesson ? lessonPayload(lesson) : null;
}

export function listLessons(limit = 30) {
  return db
    .prepare(
      `SELECT l.*, c.name AS class_name, t.name AS teacher_name,
              (SELECT COUNT(*) FROM lesson_devices ld WHERE ld.lesson_id = l.id) AS device_count,
              (SELECT COUNT(DISTINCT student_id) FROM usage_events u WHERE u.lesson_id = l.id AND student_id IS NOT NULL) AS student_count,
              (SELECT COALESCE(SUM(seconds),0) FROM usage_events u WHERE u.lesson_id = l.id) AS seconds
       FROM lessons l LEFT JOIN classes c ON c.id = l.class_id LEFT JOIN teachers t ON t.id = l.teacher_id
       ORDER BY l.id DESC LIMIT ?`,
    )
    .all(Number(limit))
    .map((row) => ({
      id: row.id,
      title: row.title,
      className: row.class_name ?? null,
      teacher: row.teacher_name ?? null,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? null,
      deviceCount: row.device_count,
      studentCount: row.student_count,
      seconds: Number(row.seconds),
      appKeys: parseKeys(row.app_keys),
    }));
}

/** 老师指定某个学生用某台头显；换人时这台头显的历史记录不动，之后的记录算到新的人头上。 */
export function assignStudent(lessonId, body) {
  const lesson = db.prepare("SELECT * FROM lessons WHERE id = ?").get(Number(lessonId));
  if (!lesson) {
    throw new HttpError(400, "课堂不存在");
  }
  const deviceId = Number(body.deviceId);
  // 一起把设备名捞出来：日志里要写「改用 PICO 一号机」，只查 lesson_devices 是拿不到名字的
  const row = db
    .prepare(
      `SELECT ld.*, d.name AS device_name FROM lesson_devices ld JOIN devices d ON d.id = ld.device_id
       WHERE ld.lesson_id = ? AND ld.device_id = ?`,
    )
    .get(lesson.id, deviceId);
  if (!row) {
    throw new HttpError(400, "这台头显不在这节课里");
  }
  const studentId = body.studentId === null || body.studentId === "" || body.studentId === undefined ? null : Number(body.studentId);
  let student = null;
  if (studentId !== null) {
    student = db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
    if (!student) {
      throw new HttpError(400, "要指定的学生不存在");
    }
    if (lesson.status !== "active") {
      throw new HttpError(400, "这节课已经下课了，不能再换人");
    }
    const clash = db
      .prepare(
        `SELECT d.name FROM lesson_devices ld JOIN devices d ON d.id = ld.device_id
         WHERE ld.lesson_id = ? AND ld.student_id = ? AND ld.device_id <> ?`,
      )
      .get(lesson.id, studentId, deviceId);
    if (clash) {
      throw new HttpError(400, `${student.name} 已经在用「${clash.name}」，先把他从那台上换下来`);
    }
  }
  db.prepare("UPDATE lesson_devices SET student_id = ?, assigned_at = ? WHERE lesson_id = ? AND device_id = ?").run(
    student?.id ?? null,
    now(),
    lesson.id,
    deviceId,
  );
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (NULL,?,?,?,?)").run(
    "lesson.assign",
    `lesson:${lesson.id}:device:${deviceId}`,
    student
      ? `${lesson.title}：${student.name} 改用 ${row.device_name ?? `头显 #${deviceId}`}`
      : `${lesson.title}：${row.device_name ?? `头显 #${deviceId}`} 取消使用者`,
    now(),
  );
  // 停用的学生照样能点，但点了这台立刻会被 device_requires_lock 锁住：
  // 判断在后台这边，不能只靠网页在下拉框里标一行小字，所以把话随结果一起带回去
  const warning =
    student && student.status !== "active"
      ? `${student.name} 是「暂停使用」状态，这台头显马上会锁住，他只能停在锁定页。要让他真能跑，先去「学生」页点「恢复使用」。`
      : "";
  return { ok: true, studentId: student?.id ?? null, warning };
}

/** 课上临时改「这节课能跑哪些应用」，可以整节课改，也可以只改一台。 */
export function setLessonApps(lessonId, body) {
  const lesson = db.prepare("SELECT * FROM lessons WHERE id = ?").get(Number(lessonId));
  if (!lesson) {
    throw new HttpError(400, "课堂不存在");
  }
  // 下课之后再改这节课的应用清单，头显那边早就按后台默认清单在跑了，改了谁也看不见
  if (lesson.status !== "active") {
    throw new HttpError(400, "这节课已经下课了，清单就定稿了；要长期放开应用，去「头显应用」里配策略");
  }
  const keys = Array.isArray(body.appKeys) ? body.appKeys.map(String) : null;
  if (!keys) {
    throw new HttpError(400, "应用清单格式不对");
  }
  const known = new Set(db.prepare("SELECT key FROM apps WHERE managed = 1").all().map((row) => row.key));
  const bad = keys.filter((key) => !known.has(key));
  if (bad.length) {
    throw new HttpError(400, `这些应用不在管理清单里：${bad.join("、")}`);
  }
  const payload = keys.length ? JSON.stringify(keys) : null;
  const deviceId = body.deviceId ? Number(body.deviceId) : null;
  if (deviceId) {
    const info = db.prepare("UPDATE lesson_devices SET app_keys = ? WHERE lesson_id = ? AND device_id = ?").run(payload, lesson.id, deviceId);
    if (info.changes === 0) {
      throw new HttpError(400, "这台头显不在这节课里");
    }
  } else {
    db.prepare("UPDATE lesson_devices SET app_keys = ? WHERE lesson_id = ?").run(payload, lesson.id);
    db.prepare("UPDATE lessons SET app_keys = ? WHERE id = ?").run(payload, lesson.id);
  }
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (NULL,?,?,?,?)").run(
    "lesson.apps",
    `lesson:${lesson.id}`,
    `${lesson.title}：可用应用改成 ${keys.length ? keys.join("、") : "跟随后台全局清单"}`,
    now(),
  );
  return { ok: true, appKeys: keys };
}

/** 往这节课里补头显（教室里临时多出一台）。 */
export function addLessonDevice(lessonId, body, teacher = null) {
  const lesson = db.prepare("SELECT * FROM lessons WHERE id = ?").get(Number(lessonId));
  if (!lesson) {
    throw new HttpError(400, "课堂不存在");
  }
  if (lesson.status !== "active") {
    throw new HttpError(400, "这节课已经下课了");
  }
  const deviceId = Number(body.deviceId);
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!device) {
    throw new HttpError(400, "头显不存在");
  }
  if (db.prepare("SELECT device_id FROM lesson_devices WHERE lesson_id = ? AND device_id = ?").get(lesson.id, deviceId)) {
    throw new HttpError(400, "这台头显已经在这节课里了");
  }
  const other = activeLessonForDevice(deviceId);
  if (other) {
    throw new HttpError(400, `这台头显正在「${other.title}」这节课里`);
  }
  db.prepare("INSERT INTO lesson_devices (lesson_id, device_id, student_id, app_keys, enrolled_at) VALUES (?,?,?,NULL,?)").run(
    lesson.id,
    deviceId,
    null,
    now(),
  );
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (?,?,?,?,?)").run(
    teacher?.id ?? null,
    "lesson.device",
    `lesson:${lesson.id}`,
    `${lesson.title}：加进 ${device.name}`,
    now(),
  );
  return { ok: true };
}

/** 下课：定格这节课，头显恢复后台全局策略。 */
export function endLesson(lessonId, teacher) {
  const lesson = db.prepare("SELECT * FROM lessons WHERE id = ?").get(Number(lessonId));
  if (!lesson) {
    throw new HttpError(400, "课堂不存在");
  }
  if (lesson.status !== "active") {
    throw new HttpError(400, "这节课已经下过了");
  }
  db.prepare("UPDATE lessons SET status = 'ended', ended_at = ? WHERE id = ?").run(now(), lesson.id);
  db.prepare("INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (?,?,?,?,?)").run(
    teacher.id,
    "lesson.end",
    `lesson:${lesson.id}`,
    `下课《${lesson.title}》，时长 ${Math.round(sumSeconds(lesson.id) / 60)} 分钟`,
    now(),
  );
  return { ok: true, ...lessonPayload(db.prepare("SELECT * FROM lessons WHERE id = ?").get(lesson.id)) };
}

function sumSeconds(lessonId) {
  return Number(db.prepare("SELECT COALESCE(SUM(seconds),0) AS s FROM usage_events WHERE lesson_id = ?").get(lessonId).s);
}

/** 下发给头显的课堂信息：这节课谁在用我、能跑哪些应用、画面多久传一帧。 */
export function lessonForManifest(deviceId, screenIntervalMs) {
  const lesson = activeLessonForDevice(deviceId);
  if (!lesson) {
    return { active: false, screen: { enabled: false, intervalMs: screenIntervalMs } };
  }
  return {
    active: true,
    id: lesson.id,
    title: lesson.title,
    className: lesson.className,
    teacher: lesson.teacher,
    startedAt: lesson.startedAt,
    student: lesson.student,
    appKeys: lesson.appKeys ?? [],
    screen: { enabled: true, intervalMs: screenIntervalMs },
  };
}

/** 头显传上来的一帧画面：落盘 + 记一条最新时间，网页用 <img> 轮询。 */
export function saveScreenFrame(device, buffer, headers) {
  if (!buffer?.length) {
    throw new HttpError(400, "画面数据是空的");
  }
  const maxBytes = 900_000;
  if (buffer.length > maxBytes) {
    throw new HttpError(400, `一帧画面太大了（${Math.round(buffer.length / 1024)} KB）`);
  }
  const head = buffer.subarray(0, 4).toString("hex");
  const looksImage = head.startsWith("ffd8") || head.startsWith("89504e47");
  if (!looksImage) {
    throw new HttpError(400, "画面得是 JPEG 或 PNG");
  }
  const file = path.join(screenDir, `device-${device.id}.jpg`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, buffer);
  renameSync(temp, file);
  db.prepare(
    `INSERT INTO device_screens (device_id, ts, bytes, width, height) VALUES (?,?,?,?,?)
     ON CONFLICT (device_id) DO UPDATE SET ts = excluded.ts, bytes = excluded.bytes, width = excluded.width, height = excluded.height`,
  ).run(
    device.id,
    now(),
    buffer.length,
    Number(headers?.width ?? 0) || null,
    Number(headers?.height ?? 0) || null,
  );
  const foreground = String(headers?.foreground ?? "").trim();
  if (foreground) {
    db.prepare("UPDATE devices SET foreground_app = ? WHERE id = ?").run(foreground, device.id);
  }
  return { ok: true, bytes: buffer.length };
}

export function readScreenFrame(deviceId) {
  const row = db.prepare("SELECT * FROM device_screens WHERE device_id = ?").get(Number(deviceId));
  if (!row) {
    return null;
  }
  const file = path.join(screenDir, `device-${row.device_id}.jpg`);
  try {
    return { ts: row.ts, bytes: row.bytes, width: row.width, height: row.height, data: readFileSync(file) };
  } catch {
    return { ts: row.ts, bytes: row.bytes, width: row.width, height: row.height, data: null };
  }
}

/** 时长 / 越权记录该算在哪个学生头上：以课上分配为准。 */
export function studentIdForDevice(device) {
  return studentForDevice(device).student?.id ?? null;
}

export function dayStartOf(ts) {
  return dayStart(ts);
}
