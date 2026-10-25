// 按 IP 找头显：后台主动敲头显启动器开的小 HTTP 口，问它「你是谁、装着什么」。
// 约定：启动器在 8790 口提供 GET /v1/identity，返回
//   { serial, name, model, launcherVersion, battery, foregroundApp, ip, apps:[{packageName,label,version,isVr,isSystem}] }
// 只有 node 自带的 fetch，跟后台一样零第三方依赖。
import { networkInterfaces } from "node:os";
import { HttpError } from "./http-error.js";

export const DEFAULT_PORT = 8790;
// 单台问话给足 2.6 秒：真头显的 Wi-Fi 省电模式常把唤醒后的第一个请求拖到一秒多，
// 1.2 秒在 PC 模拟上好使、到真机上就成了「问了没回」，老师只能反复点。扫网段另算（700 毫秒，量在那儿）
const PROBE_TIMEOUT_MS = 2600;
const SCAN_TIMEOUT_MS = 700;
const SCAN_CONCURRENCY = 32;

/** 把老师输入的「192.168.1.20」「192.168.1.20:8790」「192.168.1」「192.168.1:8790」整理成能用的地址。 */
export function parseTarget(input, fallbackPort = DEFAULT_PORT) {
  const text = String(input ?? "").trim();
  if (!text) {
    throw new HttpError(400, "要填头显的 IP，比如 192.168.1.20");
  }
  const withPort = text.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
  if (withPort) {
    return { host: withPort[1], port: Number(withPort[2]) };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    return { host: text, port: fallbackPort };
  }
  // 网段前缀也允许带端口：问话口不在默认 8790 上时也能整段扫
  const prefixWithPort = text.match(/^(\d{1,3}(?:\.\d{1,3}){2}):(\d{2,5})$/);
  if (prefixWithPort) {
    return { host: prefixWithPort[1], port: Number(prefixWithPort[2]), prefix: true };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){2}$/.test(text)) {
    return { host: text, port: fallbackPort, prefix: true };
  }
  throw new HttpError(400, `「${text}」不像 IP：写 192.168.1.20，或网段前缀 192.168.1`);
}

/** 本机在用的 IPv4：报错时要能认出「老师填的其实就是跑后台的这台电脑」。 */
function localIpv4s() {
  const set = new Set(["127.0.0.1", "localhost"]);
  for (const list of Object.values(networkInterfaces() ?? {})) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" || item.family === 4) {
        set.add(item.address);
      }
    }
  }
  return set;
}

/**
 * 问不到的原因要说得能接着干活：光一句「拒了连接」，老师分不清是启动器没开、
 * 端口不对，还是这台头显装的启动器太旧、压根没开问话口。
 */
function failReason(error, { host, port }) {
  const code = String(error?.cause?.code ?? error?.name ?? error?.message ?? "");
  // 填的是本机（PC 模拟最常见）：直接把下一步点到眼前，别让老师去查头显
  const local = localIpv4s().has(host)
    ? `（${host} 就是跑后台的这台电脑：用 Unity 播放模式跑启动器，或者先起一台模拟头显 `
      + "node scripts/mock-pico.mjs --serve --respond-port 8790）"
    : "";
  if (/AbortError|TimeoutError|timeout/i.test(code)) {
    return (
      `问了没回（${port} 口没应答，${PROBE_TIMEOUT_MS} 毫秒就放弃了）：`
      + `确认 ${host} 是这台头显现在的 IP、启动器开着，而且它和后台在同一个网段${local}`
    );
  }
  if (/ECONNREFUSED/i.test(code)) {
    return (
      `这台 IP 拒了连接（${host}:${port} 没人监听）：启动器没在跑，或者它太旧没开问话口 —— `
      + `旧启动器请升级，实在要先把这台收进后台，改用「登记头显」手填序列号${local}`
    );
  }
  if (code) {
    return code;
  }
  return error?.message ?? "不知道的原因";
}

/** 问一台 IP 要身份。返回 { ok, ...身份 } 或 { ok:false, reason }。 */
export async function probeDeviceHost(host, { port = DEFAULT_PORT, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const url = `http://${host}:${port}/v1/identity`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        ok: false,
        host,
        port,
        reason:
          `它回了 HTTP ${response.status}，不像启动器的问话口（它只答 GET /v1/identity）：`
          + `${host}:${port} 上跑的可能是别的服务，或者这台头显的启动器版本太旧`,
      };
    }
    const info = await response.json();
    const serial = String(info?.serial ?? "").trim();
    if (!serial) {
      return { ok: false, host, port, reason: "应答里没有序列号，不认这台" };
    }
    return {
      ok: true,
      host,
      port,
      serial,
      name: String(info.name ?? "").trim() || serial,
      model: String(info.model ?? "").trim() || "PICO 头显",
      launcherVersion: String(info.launcherVersion ?? "").trim() || "0.1.0",
      battery: info.battery === undefined || info.battery === null ? null : Math.max(0, Math.min(100, Number(info.battery))),
      foregroundApp: String(info.foregroundApp ?? "").trim() || null,
      apps: Array.isArray(info.apps) ? info.apps : null,
      // 这台启动器正在连哪个后台、连上没有 —— 收进后台却永远不心跳的，九成是这里指错了地方
      serverBaseUrl: String(info.serverBaseUrl ?? "").trim() || null,
      backendOnline: info.backendOnline === true,
      backendError: String(info.backendError ?? "").trim() || null,
    };
  } catch (error) {
    return { ok: false, host, port, reason: failReason(error, { host, port }) };
  }
}

/** 扫一个 C 段（192.168.1 → .1~.254），并发开 32 路，找到几台算几台。 */
export async function scanSegment(prefix, { port = DEFAULT_PORT, timeoutMs = SCAN_TIMEOUT_MS, from = 1, to = 254 } = {}) {
  const hosts = [];
  for (let i = from; i <= to; i += 1) {
    hosts.push(`${prefix}.${i}`);
  }
  const found = [];
  const misses = [];
  let cursor = 0;
  async function worker() {
    while (cursor < hosts.length) {
      const host = hosts[cursor];
      cursor += 1;
      const result = await probeDeviceHost(host, { port, timeoutMs });
      if (result.ok) {
        found.push(result);
      } else {
        misses.push(result);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, hosts.length) }, worker));
  return { scanned: hosts.length, found, misses };
}

/**
 * 把后台自己的地址推给启动器（POST /v1/config）。
 * 启动器打包时写的默认地址是占位的 http://192.168.1.100:8787，老师不改「设置」就永远连不上：
 * 收编那一步顺手把它指过来，省掉戴着头显敲 IP 这一步。旧启动器没这个口，认出来并说清怎么手填。
 */
export async function configureDeviceHost(host, { port = DEFAULT_PORT, serverBaseUrl = "", timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const target = String(serverBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!target) {
    return { ok: false, host, port, reason: "后台报不出自己的地址（既没配 PUBLIC_BASE_URL，也读不到本机局域网 IP）" };
  }
  try {
    const response = await fetch(`http://${host}:${port}/v1/config`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ serverBaseUrl: target }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        host,
        port,
        serverBaseUrl: target,
        reason:
          `它回了 HTTP ${response.status}${parsed?.error ? `：${parsed.error}` : ""} —— `
          + "这台启动器多半太旧（不认「推后台地址」），请戴上头显在「设置 → 后台地址」里手填",
      };
    }
    const applied = String(parsed?.serverBaseUrl ?? "").trim();
    if (!applied) {
      return { ok: false, host, port, serverBaseUrl: target, reason: "它没回改后的地址，不确定改成了没有" };
    }
    return { ok: true, host, port, serverBaseUrl: applied, applied: parsed?.applied === true };
  } catch (error) {
    return { ok: false, host, port, serverBaseUrl: target, reason: failReason(error, { host, port }) };
  }
}
