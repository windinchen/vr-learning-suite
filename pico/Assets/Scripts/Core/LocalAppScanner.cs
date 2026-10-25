using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using VrLauncher.Integration;

namespace VrLauncher.Core
{
    /// <summary>
    /// 本机应用清单从哪来：真机上问 PackageManager；在 Mac 编辑器里读本机一个 JSON 清单文件，
    /// 这样不带头显也能把「读本机应用 → 上报后台 → 按策略拦截」整条链路点出来。
    /// 清单文件可以直接手改（改完在界面上点「重新扫描」就生效），路径会显示在「本机应用」页里。
    /// </summary>
    public class LocalAppScanner
    {
        public string Source { get; private set; } = "还没扫描";
        public DateTime ScannedAt { get; private set; } = DateTime.MinValue;
        public bool Simulated { get; private set; }
        public string LastError { get; private set; } = "";

        readonly List<LocalAppRecord> apps = new List<LocalAppRecord>();

        public IReadOnlyList<LocalAppRecord> Apps => apps;
        public bool Scanned => ScannedAt != DateTime.MinValue;

        /// <summary>编辑器里用的模拟清单文件（真机上不用，直接问系统）。</summary>
        public static string FixturePath => Path.Combine(Application.persistentDataPath, "local-apps.json");

        public IReadOnlyList<LocalAppRecord> Scan(string selfPackage)
        {
            var real = AndroidApps.ScanInstalled(selfPackage);
            if (real != null && real.Count > 0)
            {
                Replace(real);
                Simulated = false;
                Source = "真机扫描（PackageManager）";
                LastError = "";
                return apps;
            }

            LoadFixture(real == null ? "编辑器里用模拟清单" : "真机扫描没拿到结果，退回模拟清单");
            return apps;
        }

        public LocalAppRecord Find(string packageName)
        {
            if (string.IsNullOrEmpty(packageName))
            {
                return null;
            }

            foreach (var record in apps)
            {
                if (record != null && record.packageName == packageName)
                {
                    return record;
                }
            }

            return null;
        }

        /// <summary>自检用：往本机清单里塞一个后台一定没登记过的应用，保证拦截测试每次都能跑到。</summary>
        public LocalAppRecord AddProbe(string packageName = "com.school.vr.probe", string label = "拦截探针")
        {
            var existing = Find(packageName);
            if (existing != null)
            {
                return existing;
            }

            var record = new LocalAppRecord
            {
                packageName = packageName,
                label = label,
                version = "0.0.1",
                versionCode = 1,
                isVr = true,
                isSystem = false,
                firstInstall = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                lastUpdate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            apps.Add(record);
            return record;
        }

        void Replace(IEnumerable<LocalAppRecord> records)
        {
            apps.Clear();
            foreach (var record in records)
            {
                if (record != null && !string.IsNullOrEmpty(record.packageName))
                {
                    apps.Add(record);
                }
            }

            ScannedAt = DateTime.Now;
        }

        void LoadFixture(string reason)
        {
            try
            {
                if (!File.Exists(FixturePath))
                {
                    File.WriteAllText(FixturePath, JsonUtility.ToJson(DefaultFixture(), true));
                    ApiClient.Log("本机应用", "首次运行，生成模拟清单：" + FixturePath);
                }

                var parsed = JsonUtility.FromJson<LocalAppList>(File.ReadAllText(FixturePath));
                var list = parsed != null && parsed.apps != null
                    ? new List<LocalAppRecord>(parsed.apps)
                    : new List<LocalAppRecord>();
                Replace(list);
                Simulated = true;
                Source = reason + "｜文件：" + FixturePath;
                LastError = "";
            }
            catch (Exception error)
            {
                Replace(Array.Empty<LocalAppRecord>());
                Simulated = true;
                Source = "模拟清单读失败";
                LastError = error.Message;
                ApiClient.Log("本机应用", "读清单失败：" + error.Message);
            }
        }

        /// <summary>一台刚装好三门课的头显长什么样，供 PC 模拟用。</summary>
        static LocalAppList DefaultFixture()
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var day = 86400000L;
            return new LocalAppList
            {
                apps = new[]
                {
                    Record("com.school.vr.ski", "雪山滑雪", "1.0.0", true, false, now - 6 * day, now - day),
                    Record("com.school.vr.shooting", "射击打靶", "1.0.0", true, false, now - 6 * day, now - 3 * day),
                    Record("com.school.vr.therapy", "心理拓展·疗法训练", "1.0.0", true, false, now - 5 * day, now - 2 * day),
                    Record("com.school.vr.chess", "象棋对弈", "0.9.2", true, false, now - 2 * day, now - 2 * day),
                    Record("com.pico.vr.browser", "PICO 浏览器", "3.1.0", false, true, now - 30 * day, now - 30 * day),
                    Record("com.pico.vr.store", "PICO 商店", "5.2.1", false, true, now - 30 * day, now - 12 * day),
                    Record("com.qualcomm.qti.xrserver", "XR 系统服务", "1.4.0", false, true, now - 30 * day, now - 30 * day),
                },
            };
        }

        static LocalAppRecord Record(string pkg, string label, string version, bool vr, bool system, long install, long update)
        {
            return new LocalAppRecord
            {
                packageName = pkg,
                label = label,
                version = version,
                versionCode = 1,
                isVr = vr,
                isSystem = system,
                firstInstall = install,
                lastUpdate = update,
            };
        }
    }
}
