// 清空模拟数据。默认清「跑出来的」数据（时长流水、心跳、越权、指令、扫描清单、策略、审计、会话、
// 自检专用头显），保留班级、学生、头显和**整个应用目录**（清单只能由头显扫出来，删了就等于让老师重录）。
// 用法：bash scripts/stop.sh
//      node scripts/reset-data.mjs          清运行数据，保留档案
//      node scripts/reset-data.mjs --all    清空到只剩老师账号
//      node scripts/reset-data.mjs --demo   删掉库文件，重启后台后重新铺一套演示数据
//      bash scripts/dev.sh
// 清空的 SQL 在 server/src/reset.js，老师网页上的「清空数据」按钮走的是同一套。
const { db, now, dataDir } = await import(`${process.cwd()}/server/src/db.js`);
const { clearRunData, clearAllData } = await import(`${process.cwd()}/server/src/reset.js`);
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const args = process.argv.slice(2);
const mode = args.includes("--all") ? "all" : args.includes("--demo") ? "demo" : "run";
const TABLES = [
  "sessions", "audit_logs", "commands", "violations", "heartbeats", "usage_events",
  "device_apps", "policies", "devices", "apps", "students", "classes", "teachers",
];
const counts = () => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

console.log(`清空前：${TABLES.map((t) => `${t} ${counts()[t]}`).join("｜")}`);

if (mode === "demo") {
  const file = process.env.SUITE_DB || path.join(dataDir, "suite.db");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) {
      fs.rmSync(file + suffix);
      console.log(`  已删除 ${file}${suffix}`);
    }
  }
  console.log("下一步：bash scripts/dev.sh —— 建库时会自动重铺一套演示数据（老师 admin / pico123456）");
  process.exit(0);
}

const result = mode === "all" ? clearAllData(db, now) : clearRunData(db, now);
if (result.removedTestDevices) {
  console.log(`  移除自检专用头显 ${result.removedTestDevices} 台`);
}
console.log(`  复位成「登记过但从没上线」：${result.remaining?.devices ?? counts().devices} 台头显、${result.remaining?.students ?? counts().students} 名学生`);
console.log(`  应用目录原样保留 ${result.remaining?.apps ?? counts().apps} 个（要删应用去老师网页「应用与策略」页，或跑 --all）`);

// 头显端还压着一批没上报的时长（离线补报队列），不清掉的话一联网就把刚清掉的模拟时长送回后台
if (process.platform === "darwin") {
  const clientDir = path.join(os.homedir(), "Library", "Application Support", "school", "VR 学习启动器");
  const queue = path.join(clientDir, "usage_queue.json");
  if (fs.existsSync(queue)) {
    const pending = JSON.parse(fs.readFileSync(queue, "utf8")).events?.length ?? 0;
    fs.rmSync(queue);
    console.log(`  清掉头显端待补报的时长队列（${pending} 条）`);
  }
  console.log(`  保留 PC 模拟清单 ${path.join(clientDir, "local-apps.json")}（删了下次扫描会自动重新生成，改它才能换成真实清单）`);
}

db.exec("VACUUM");
const after = counts();
console.log(`清空后：${TABLES.map((t) => `${t} ${after[t]}`).join("｜")}`);
console.log(
  mode === "all"
    ? "结果：已清空到只剩老师账号，重新登录即可（admin / pico123456）"
    : "结果：模拟数据已清空，头显重新扫描后本机应用会重新长出来",
);
