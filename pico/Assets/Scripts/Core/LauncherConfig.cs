using System;
using UnityEngine;

namespace VrLauncher.Core
{
    /// <summary>
    /// 启动器配置：后台地址、设备标识、轮询节奏。都存在 PlayerPrefs 里，改完立刻生效，
    /// 学生端设置面板可以直接改后台地址（机房换网不用重新打包）。
    /// </summary>
    public static class LauncherConfig
    {
        const string KeyServer = "backend_base_url";

        /// <summary>
        /// 默认后台地址：编辑器里直连本机，方便在 Mac 上点鼠标联调；
        /// 真机上先给一个局域网占位地址，进「设置」改成机房实际 IP 即可，不用重新打包。
        /// </summary>
#if UNITY_EDITOR
        const string DefaultServer = "http://127.0.0.1:8787";
        const string EditorSerial = "PICO-4U-A1B2C3";
#else
        const string DefaultServer = "http://192.168.1.100:8787";
#endif

        public const string AppVersion = "0.1.0";

        public static string ServerBaseUrl
        {
            get
            {
                var saved = PlayerPrefs.GetString(KeyServer, DefaultServer);
                return string.IsNullOrEmpty(saved) ? DefaultServer : saved.TrimEnd('/');
            }
            set
            {
                PlayerPrefs.SetString(KeyServer, (value ?? "").TrimEnd('/'));
                PlayerPrefs.Save();
            }
        }

        public static string DeviceToken
        {
            get => PlayerPrefs.GetString("device_token", "");
            set
            {
                PlayerPrefs.SetString("device_token", value ?? "");
                PlayerPrefs.Save();
            }
        }

        /// <summary>设备序列号：优先用 Android 的 ANDROID_ID，编辑器里退回 deviceUniqueIdentifier。</summary>
        public static string DeviceSerial
        {
            get
            {
                var saved = PlayerPrefs.GetString("device_serial", "");
                if (!string.IsNullOrEmpty(saved))
                {
                    return saved;
                }

#if UNITY_EDITOR
                // 编辑器里固定用后台种子数据里那台设备，一打开就能看到学生和应用清单
                PlayerPrefs.SetString("device_serial", EditorSerial);
                PlayerPrefs.Save();
                return EditorSerial;
#else
#if UNITY_ANDROID && !UNITY_EDITOR
                try
                {
                    using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                    using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                    using (var resolver = activity.Call<AndroidJavaObject>("getContentResolver"))
                    using (var secure = new AndroidJavaClass("android.provider.Settings$Secure"))
                    {
                        var id = secure.CallStatic<string>("getString", resolver, "android_id");
                        if (!string.IsNullOrEmpty(id))
                        {
                            var serial = "PICO-" + id.ToUpperInvariant();
                            PlayerPrefs.SetString("device_serial", serial);
                            PlayerPrefs.Save();
                            return serial;
                        }
                    }
                }
                catch (Exception error)
                {
                    Debug.LogWarning("[配置] 读 ANDROID_ID 失败，退回本机标识：" + error.Message);
                }
#endif
                var fallback = "PICO-" + SystemInfo.deviceUniqueIdentifier.Replace("-", "").ToUpperInvariant().Substring(0, 12);
                PlayerPrefs.SetString("device_serial", fallback);
                PlayerPrefs.Save();
                return fallback;
#endif
            }
        }

        public static string DeviceName => string.IsNullOrEmpty(SystemInfo.deviceName) ? "PICO 头显" : SystemInfo.deviceName;
        public static string DeviceModel => SystemInfo.deviceModel;
        public static int HeartbeatSeconds => 10;
        public static int FlushUsageSeconds => 30;
        /// <summary>
        /// 定时重拉清单的间隔。有了后台改动版本号（心跳一比就知道），这个只是兜底：
        /// 万一 rev 那条路没走通（后台太旧、请求丢了一轮），最迟 30 秒也会重新对齐一次。
        /// </summary>
        public static int ManifestSeconds => 30;
    }
}
