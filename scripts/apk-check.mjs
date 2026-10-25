#!/usr/bin/env node
// APK 体检：确认打出来的包里到底有没有最新功能（不用装到头显上）。
//   node scripts/apk-check.mjs                      检查 Build/Android/VR-Launcher.apk
//   node scripts/apk-check.mjs --apk 某个.apk        检查指定包
//   node scripts/apk-check.mjs --strict              少一个标记就非 0 退出（给自己化自检用）
//
// 为什么要这个：曾经有个 APK 打出来是能跑的，但里面根本不开 8790 问话口，
// 网页「按 IP 找头显」填什么都报「拒了连接」，排查半天——包是新是旧，拆开搜字符串最快。
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const STRICT = args.includes("--strict");
const APK = path.resolve(argOf("apk", path.join(ROOT, "Build/Android/VR-Launcher.apk")));

// 要找的标记只能是**字符串字面量**：端口 8790 在代码里是 int 常量（DefaultPort），
// 编译进元数据的是数字不是文字，拿它当标记会永远搜不到。认问话口就认它自己的那几句字符串。
const NEEDLES = [
  { text: "本机信息卡", must: true, why: "中文界面（第 8 节那套）在包里" },
  { text: "v1/identity", must: true, why: "8790 问话口的接口路径" },
  { text: "v1/config", must: true, why: "「让它连上后台」推地址的口（老的包没有这一条）" },
  { text: "v1/hello", must: true, why: "头显自己扫网段找后台敲的口（更早的包没有，连不上时只能干等老师推地址）" },
  { text: "自动找后台", must: true, why: "设置页那个「自动找后台」按钮，和上一条是同一版功能" },
  { text: "重新拉一份清单", must: true, why: "认后台改动版本号：老师改完下次心跳（10 秒）就重拉清单，更早的包只能等定时轮询" },
  { text: "老师带话", must: true, why: "老师从网页「带句话」端上接得住并打上首页横幅（更早的包收到就丢掉，还回了一句已执行）" },
  { text: "后台还没安排能玩的应用", must: true, why: "后台把应用停光（200 + 空清单）时不再冤称「连不上后台」，横幅说得清是后台没安排（更早的包会一路报连不上）" },
  { text: "这儿只有 GET", must: true, why: "问话口的 404 分支，同一段新代码" },
  { text: "不在允许清单里", must: true, why: "白名单拦截的提示语（第 4 节那套规则）" },
  { text: "下面还有", must: true, why: "弹层列表被裁时的「下面还有 · 往前推滑一下」提示（第 12 节：导航只有一条那一版才有的）" },
  { text: "退出到 PICO 桌面", must: true, why: "底部导航右侧的「回桌面」动作卡；更早的包把它当成一个页签混在页签里" },
  { text: "com.school.vr.launcher", must: false, why: "启动器包名（可能只写在二进制清单里）" },
];
// 只在这几类条目里搜，省时间也避免误命中
const SCAN_HINTS = ["global-metadata.dat", "libil2cpp.so", "assets/bin"];

const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};
if (!existsSync(APK)) fail(`找不到 APK：${APK}（先 bash scripts/unity.sh apk）`);

const listed = execFileSync("unzip", ["-l", APK], { encoding: "utf-8" });
const entries = listed
  .split("\n")
  .map((line) => line.trim().replace(/^\s*\d+\s+/, "").split(/\s{2,}/).pop())
  .filter((name) => name && SCAN_HINTS.some((hint) => name.includes(hint)));
console.log(`检查：${APK}（${(statSync(APK).size / 1024 / 1024).toFixed(1)} MB）`);
const firstRow = listed.split("\n").find((line) => /^\s*\d+\s+\d{2}-\d{2}-\d{4}/.test(line));
// Android 打包会把包内条目时间归一成 1981，这行永远是固定值，只是顺手证明包能正常解
if (firstRow) console.log(`包内首个条目时间：${firstRow.trim().split(/\s{2,}/).slice(1, 3).join(" ")}（Android 会归一化时间，别当构建时间看）`);
if (!entries.length) fail("包里没找到 global-metadata.dat / libil2cpp.so，不像个能跑的包");

const needles = NEEDLES.flatMap((n) => [
  { ...n, label: n.text, buf: Buffer.from(n.text, "utf8") },
  { ...n, label: `${n.text}（UTF-16）`, buf: Buffer.from(n.text, "utf16le") },
]);
const found = new Map();
const scanned = [];
for (const entry of entries) {
  let data;
  try {
    data = execFileSync("unzip", ["-p", APK, entry], { maxBuffer: 512 * 1024 * 1024 });
  } catch (error) {
    console.log(`  跳过 ${entry}（读不出来：${String(error.message).slice(0, 60)}）`);
    continue;
  }
  scanned.push(`${entry}（${(data.length / 1024 / 1024).toFixed(1)} MB）`);
  for (const needle of needles) {
    if (data.includes(needle.buf)) {
      const hits = found.get(needle.text) ?? [];
      if (!hits.includes(entry)) hits.push(entry);
      found.set(needle.text, hits);
    }
  }
}
console.log("已扫描：");
for (const line of scanned) console.log(`  · ${line}`);

console.log("\n标记：");
let missing = [];
for (const needle of NEEDLES) {
  const hits = found.get(needle.text);
  if (hits?.length) {
    console.log(`  ✅ ${needle.text}　${needle.why}｜在 ${hits[0].split("/").pop()}`);
  } else {
    console.log(`  ${needle.must ? "❌" : "⚠️"} ${needle.text}　没搜到（${needle.why}）`);
    if (needle.must) missing.push(needle.text);
  }
}
const mtime = statSync(APK).mtime.toLocaleString("zh-CN", { hour12: false });
console.log(`\nAPK 文件时间：${mtime}（复制、移动都会改它，判断新旧看上面的标记，别只看日期）`);
if (missing.length) {
  console.log(`结论：这个包还是旧的，缺 ${missing.join("、")}——用当前源码重打一次 bash scripts/unity.sh apk`);
  if (STRICT) process.exit(1);
} else {
  console.log("结论：这是含最新功能的包（中文界面 + 8790 问话口都在）");
}
