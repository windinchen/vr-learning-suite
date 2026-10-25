using System;
using System.Collections.Generic;
using UnityEngine;
using VrLauncher.Core;

namespace VrLauncher.Integration
{
    /// <summary>
    /// Android/PICO 侧的应用操作：按包名启动、查前台包名（统计第三方应用时长用）。
    /// 编辑器里全部退回空实现，方便在 Mac 上直接跑界面。
    /// </summary>
    public static class AndroidApps
    {
        public static bool IsAndroid => Application.platform == RuntimePlatform.Android;

        /// <summary>用 LAUNCHER intent 启动应用；失败返回 false（比如没装、没权限）。</summary>
        public static bool Launch(string packageName)
        {
            if (string.IsNullOrEmpty(packageName))
            {
                return false;
            }

            if (!IsAndroid)
            {
                Debug.Log("[应用] 非 Android 环境，模拟启动 " + packageName);
                return true;
            }

            try
            {
                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var packageManager = activity.Call<AndroidJavaObject>("getPackageManager"))
                using (var launch = packageManager.Call<AndroidJavaObject>("getLaunchIntentForPackage", packageName))
                {
                    if (launch == null)
                    {
                        Debug.LogWarning("[应用] " + packageName + " 没有可启动的入口（可能没装）");
                        return false;
                    }

                    // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
                    launch.Call<AndroidJavaObject>("addFlags", 0x10000000 | 0x04000000);
                    activity.Call("startActivity", launch);
                    return true;
                }
            }
            catch (Exception error)
            {
                Debug.LogWarning("[应用] 启动 " + packageName + " 失败：" + error.Message);
                return false;
            }
        }

        /// <summary>
        /// 扫描本机装了哪些能启动的应用。返回 null 表示当前不是 Android（编辑器里交给模拟清单）。
        /// 先按 LAUNCHER 入口捞一遍，再用几个 VR 专用入口标出哪些是 VR 应用。
        /// </summary>
        public static List<LocalAppRecord> ScanInstalled(string selfPackage)
        {
            if (!IsAndroid)
            {
                return null;
            }

            var found = new Dictionary<string, LocalAppRecord>();
            try
            {
                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var manager = activity.Call<AndroidJavaObject>("getPackageManager"))
                {
                    var vrPackages = new HashSet<string>();
                    foreach (var category in VrCategories)
                    {
                        foreach (var pkg in QueryPackages(manager, category))
                        {
                            vrPackages.Add(pkg);
                        }
                    }

                    foreach (var pkg in QueryPackages(manager, "android.intent.category.LAUNCHER"))
                    {
                        if (!found.ContainsKey(pkg))
                        {
                            AddRecord(found, manager, pkg, selfPackage, vrPackages.Contains(pkg));
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Debug.LogWarning("[应用] 扫描本机应用失败：" + error.Message);
            }

            var list = new List<LocalAppRecord>(found.Values);
            list.Sort(delegate(LocalAppRecord left, LocalAppRecord right)
            {
                if (left.isVr != right.isVr)
                {
                    return left.isVr ? -1 : 1;
                }

                return string.Compare(left.label, right.label, StringComparison.CurrentCultureIgnoreCase);
            });
            return list;
        }

        static readonly string[] VrCategories =
        {
            "android.intent.category.LAUNCHER",
            "com.oculus.intent.category.VR",
            "info.android.intent.category.VR",
            "com.pico.intent.category.VR",
        };

        static List<string> QueryPackages(AndroidJavaObject manager, string category)
        {
            var packages = new List<string>();
            try
            {
                using (var intent = new AndroidJavaObject("android.content.Intent", "android.intent.action.MAIN"))
                {
                    intent.Call<AndroidJavaObject>("addCategory", category);
                    // GET_RESOLVED_FILTER = 0x00000010 / 0：只要启得起来的入口
                    using (var results = manager.Call<AndroidJavaObject>("queryIntentActivities", intent, 0))
                    {
                        if (results == null)
                        {
                            return packages;
                        }

                        var count = results.Call<int>("size");
                        for (var i = 0; i < count; i += 1)
                        {
                            using (var info = results.Call<AndroidJavaObject>("get", i))
                            using (var activityInfo = info.Get<AndroidJavaObject>("activityInfo"))
                            {
                                var pkg = activityInfo == null ? null : activityInfo.Get<string>("packageName");
                                if (!string.IsNullOrEmpty(pkg))
                                {
                                    packages.Add(pkg);
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Debug.Log("[应用] 按 " + category + " 查询失败：" + error.Message);
            }

            return packages;
        }

        static void AddRecord(
            Dictionary<string, LocalAppRecord> found,
            AndroidJavaObject manager,
            string packageName,
            string selfPackage,
            bool isVr)
        {
            var record = new LocalAppRecord
            {
                packageName = packageName,
                label = packageName,
                isVr = isVr,
                isSelf = !string.IsNullOrEmpty(selfPackage) && packageName == selfPackage,
            };

            try
            {
                using (var info = manager.Call<AndroidJavaObject>("getPackageInfo", packageName, 0))
                {
                    if (info == null)
                    {
                        return;
                    }

                    record.version = info.Get<string>("versionName") ?? "";
                    record.firstInstall = info.Get<long>("firstInstallTime");
                    record.lastUpdate = info.Get<long>("lastUpdateTime");
                    using (var appInfo = info.Get<AndroidJavaObject>("applicationInfo"))
                    {
                        if (appInfo != null)
                        {
                            // FLAG_SYSTEM = 0x1，FLAG_UPDATED_SYSTEM_APP = 0x200
                            var flags = appInfo.Get<int>("flags");
                            record.isSystem = (flags & 0x1) != 0 || (flags & 0x200) != 0;
                            using (var label = appInfo.Call<AndroidJavaObject>("loadLabel", manager))
                            {
                                if (label != null)
                                {
                                    record.label = label.Call<string>("toString") ?? packageName;
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Debug.Log("[应用] 读 " + packageName + " 的信息失败：" + error.Message);
            }

            if (string.IsNullOrEmpty(record.label))
            {
                record.label = packageName;
            }

            found[packageName] = record;
        }

        /// <summary>这台机器上有没有装某个包（用来在点之前就知道会不会启动失败）。</summary>
        public static bool HasPackage(string packageName)
        {
            if (string.IsNullOrEmpty(packageName) || !IsAndroid)
            {
                return false;
            }

            try
            {
                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var manager = activity.Call<AndroidJavaObject>("getPackageManager"))
                using (var info = manager.Call<AndroidJavaObject>("getPackageInfo", packageName, 0))
                {
                    return info != null;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// 取最近在前台的应用包名。用 UsageStatsManager（需要在系统设置里授予「有权限查看使用情况」）。
        /// </summary>
        public static string ForegroundPackage(int lookBackSeconds = 90)
        {
            if (!IsAndroid)
            {
                return null;
            }

            try
            {
                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var service = activity.Call<AndroidJavaObject>("getSystemService", "usagestats"))
                {
                    if (service == null)
                    {
                        return null;
                    }

                    var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    using (var list = service.Call<AndroidJavaObject>(
                               "queryUsageStats", 4, nowMs - lookBackSeconds * 1000L, nowMs)) // INTERVAL_BEST = 4
                    {
                        if (list == null)
                        {
                            return null;
                        }

                        var size = list.Call<int>("size");
                        var bestMs = 0L;
                        var best = (string)null;
                        for (var i = 0; i < size; i += 1)
                        {
                            using (var stat = list.Call<AndroidJavaObject>("get", i))
                            {
                                var last = stat.Call<long>("getLastTimeUsed");
                                var pkg = stat.Call<string>("getPackageName");
                                if (last > bestMs && !string.IsNullOrEmpty(pkg) && !pkg.Contains("android.systemui"))
                                {
                                    bestMs = last;
                                    best = pkg;
                                }
                            }
                        }

                        return bestMs >= nowMs - lookBackSeconds * 1000L ? best : null;
                    }
                }
            }
            catch (Exception error)
            {
                Debug.Log("[应用] 取前台包名失败（可能是没给使用情况权限）：" + error.Message);
                return null;
            }
        }

        /// <summary>跳到系统的「使用情况访问」授权页，让学生/老师手动开权限。</summary>
        public static void OpenUsageAccessSettings()
        {
            if (!IsAndroid)
            {
                Debug.Log("[应用] 非 Android 环境，跳过授权页");
                return;
            }

            try
            {
                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var intent = new AndroidJavaObject(
                           "android.content.Intent", "android.settings.USAGE_ACCESS_SETTINGS"))
                {
                    intent.Call<AndroidJavaObject>("addFlags", 0x10000000);
                    activity.Call("startActivity", intent);
                }
            }
            catch (Exception error)
            {
                Debug.LogWarning("[应用] 打开授权页失败：" + error.Message);
            }
        }

        /// <summary>退出到系统桌面（PICO Home）。编辑器里只记一行日志，方便在 Mac 上接着点。</summary>
        public static void BackToHome()
        {
            if (!IsAndroid)
            {
                Debug.Log("[应用] 非 Android 环境，模拟回到桌面");
                return;
            }

            try
            {
                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var intent = new AndroidJavaObject("android.content.Intent", "android.intent.action.MAIN"))
                {
                    intent.Call("addCategory", "android.intent.category.HOME");
                    intent.Call<AndroidJavaObject>("addFlags", 0x10000000);
                    activity.Call("startActivity", intent);
                }
            }
            catch (Exception error)
            {
                Debug.LogWarning("[应用] 回桌面失败：" + error.Message);
            }
        }

        /// <summary>真正退出启动器（设置页里的「退出」按钮用）。</summary>
        public static void ExitApp()
        {
            if (!IsAndroid)
            {
                UnityEngine.Application.Quit();
                return;
            }

            BackToHome();
        }
    }
}
