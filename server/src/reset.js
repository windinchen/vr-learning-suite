// 清空数据的唯一实现：老师网页上的「清空数据」按钮和 scripts/reset-data.mjs 都调这里，
// 免得两边各写一份 SQL 慢慢对不上。
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { screenDir } from "./lesson.js";
/** 删掉头显画面缓存帧（上课时头显一帧帧传上来的图片）。 */
function clearScreenFiles() {
  for (const file of readdirSync(screenDir)) {
    if (file.endsWith(".jpg") || file.endsWith(".tmp")) {
      rmSync(path.join(screenDir, file), { force: true });
    }
  }
}

/**
 * 清掉跑出来的数据：时长流水、心跳、越权、指令、本机应用扫描结果、策略、审计、会话，
 * 外加自检专用头显（序列号 `PICO-TEST-*`）；设备复位成「登记过但从没上线」。
 * 保留：老师账号、班级、学生、头显（含配对 token）、以及**整个应用目录**。
 *
 * 应用目录为什么一个都不删：清单只能由头显扫出来，「扫出来的」早就不等于「跑出来的脏数据」了，
 * 拿 `source='device'` 当脏数据删，老师点一次「清空数据」清单就空了。
 * 至自检塞进去的《偷偷装的游戏》那类，谁塞的谁自己删（见 `scripts/api-test.mjs` 收尾），
 * 真要一次清干净还有 `--all`。
 */
export function clearRunData(db, now) {
  let testDevices = [];
  db.exec("BEGIN");
  try {
    testDevices = db.prepare("SELECT id FROM devices WHERE serial LIKE 'PICO-TEST-%'").all();
    for (const device of testDevices) {
      db.prepare("DELETE FROM device_apps WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM policies WHERE scope = 'device' AND scope_id = ?").run(device.id);
      db.prepare("DELETE FROM usage_events WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM heartbeats WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM commands WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM violations WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM lesson_devices WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM device_screens WHERE device_id = ?").run(device.id);
      db.prepare("DELETE FROM devices WHERE id = ?").run(device.id);
    }

    for (const table of [
      "usage_events",
      "heartbeats",
      "violations",
      "commands",
      "device_apps",
      "policies",
      "audit_logs",
      "sessions",
      "lesson_devices",
      "lessons",
      "device_screens",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    clearScreenFiles();

    // 设备复位，但保留 token —— 头显不用重新配对
    db.prepare(
      `UPDATE devices SET battery = NULL, foreground_app = NULL, last_seen = enrolled_at,
              status = 'active', app_mode = 'allowlist'`,
    ).run();
    db.prepare("UPDATE students SET status = 'active'").run();
    db.prepare(
      "INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (NULL,?,?,?,?)",
    ).run("data.reset", "system", "清空模拟数据（保留班级/学生/头显/应用清单）", now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const tableRows = {};
  for (const table of ["devices", "students", "apps", "usage_events", "heartbeats", "violations", "device_apps", "policies"]) {
    tableRows[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  return { removedTestDevices: testDevices.length, remaining: tableRows };
}

/** 连演示档案一起清掉，只剩老师账号。清完是真正的空系统，班级学生头显都要重新录。 */
export function clearAllData(db, now) {
  const result = clearRunData(db, now);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM devices").run();
    db.prepare("DELETE FROM students").run();
    clearScreenFiles();
    db.prepare("DELETE FROM classes").run();
    db.prepare("DELETE FROM apps").run();
    db.prepare("DELETE FROM audit_logs").run();
    db.prepare("DELETE FROM sessions").run();
    db.prepare(
      "INSERT INTO audit_logs (teacher_id, action, target, detail, ts) VALUES (NULL,?,?,?,?)",
    ).run("data.reset", "system", "清空全部数据，只留老师账号", now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const remaining = {};
  for (const table of ["devices", "students", "classes", "apps", "teachers"]) {
    remaining[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  return { ...result, remaining };
}
