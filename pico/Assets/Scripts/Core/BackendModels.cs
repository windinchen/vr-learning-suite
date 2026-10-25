using System;

namespace VrLauncher.Core
{
    // 字段名必须和后台 JSON 完全一致（JsonUtility 按名字匹配，大小写敏感）

    [Serializable]
    public class LockState
    {
        public bool locked;
        public string reason;
    }

    [Serializable]
    public class StudentInfo
    {
        public int id;
        public string name;
        public string studentNo;
    }

    [Serializable]
    public class DeviceInfo
    {
        public int id;
        public string serial;
        public string name;
        public string status;
        public bool online;
    }

    /// <summary>课堂要求头显多久回传一帧画面。</summary>
    [Serializable]
    public class ScreenPolicy
    {
        public bool enabled;
        public int intervalMs;
    }

    /// <summary>正在上的这节课：谁在用、能跑哪些应用、要不要回传画面。</summary>
    [Serializable]
    public class LessonInfo
    {
        public bool active;
        public int id;
        public string title;
        public string className;
        public string teacher;
        public long startedAt;
        public StudentInfo student;
        public string[] appKeys;
        public ScreenPolicy screen;
    }

    [Serializable]
    public class AppItem
    {
        public int id;
        public string key;
        public string name;
        public string packageName;
        public string category;
        public string icon;
        public string version;
        public bool allowed;
        public string reason;
        public string scope;
        public int dailyMinutes;
        public int usedMinutes;
        public int remainingMinutes;
        public string window;

        // installed / missing / unknown：这台头显到底装没装，来自头显自己扫描的本机应用清单
        public string installState;
        public string installedVersion;
    }

    /// <summary>头显本机扫出来的一个应用。</summary>
    [Serializable]
    public class LocalAppRecord
    {
        public string packageName;
        public string label;
        public string version;
        public long versionCode;
        public bool isVr;
        public bool isSystem;
        public bool isSelf;
        public long firstInstall;
        public long lastUpdate;
    }

    [Serializable]
    public class LocalAppList
    {
        public LocalAppRecord[] apps = System.Array.Empty<LocalAppRecord>();
    }

    [Serializable]
    public class AppSyncRequest
    {
        public LocalAppRecord[] apps;
        public long scannedAt;
    }

    [Serializable]
    public class AppSyncResponse
    {
        public bool ok;
        public int scanned;
        public int discovered;
        public int uninstalled;
        public int installedCount;
        public int missingCount;
        public string mode;
        public long serverTime;
        public string error;
    }

    [Serializable]
    public class ViolationRequest
    {
        public string packageName;
        public string label;
        public string action;
    }

    [Serializable]
    public class LocalSummary
    {
        public string mode;
        public bool scanned;
        public int installedCount;
        public int missingCount;
        public long lastScanAt;
    }

    [Serializable]
    public class CommandInfo
    {
        public int id;
        public string type;
        /// <summary>带话指令的文字在这里；别的指令是 null。字段名跟后台 commandsPayload 一致。</summary>
        public CommandPayloadInfo payload;
    }

    [Serializable]
    public class CommandPayloadInfo
    {
        public string text;
    }

    [Serializable]
    public class ManifestResponse
    {
        public DeviceInfo device;
        public StudentInfo student;
        public LessonInfo lesson;
        public LockState locked;
        public AppItem[] apps;
        public string mode;
        public LocalSummary local;
        public long serverTime;
        public CommandInfo[] pendingCommands;
        /// <summary>后台改动版本号：老师在网页上做任何改动都会变，心跳拿它比对，变了就重拉清单。</summary>
        public long rev;
    }

    [Serializable]
    public class EnrollRequest
    {
        public string serial;
        public string name;
        public string model;
        public string launcherVersion;
    }

    [Serializable]
    public class EnrollResponse
    {
        public int deviceId;
        public string token;
        public string pairingCode;
        public StudentInfo student;
        public string status;
        public string error;
    }

    [Serializable]
    public class HeartbeatRequest
    {
        public int battery;
        public string foregroundApp;
        public string wifi;
        public string launcherVersion;
    }

    [Serializable]
    public class HeartbeatResponse
    {
        public bool ok;
        public long serverTime;
        public string status;
        public CommandInfo[] commands;
        public string error;
        /// <summary>后台当前改动版本号，和拿到清单时那个对不上就说明清单旧了。</summary>
        public long rev;
    }

    [Serializable]
    public class UsageEvent
    {
        public string appKey;
        public string packageName;
        public long startedAt;
        public long endedAt;
        public int seconds;
    }

    [Serializable]
    public class UsageBatch
    {
        public string batchId;
        public UsageEvent[] events;
    }

    [Serializable]
    public class UsageResponse
    {
        public bool ok;
        public string batchId;
        public int accepted;
        public int duplicates;
        public string error;
    }

    [Serializable]
    public class ScreenUploadResponse
    {
        public bool ok;
        public int bytes;
        public int intervalMs;
        public string error;
    }

    [Serializable]
    public class AckRequest
    {
        public int[] ids;
    }

    [Serializable]
    public class SimpleResponse
    {
        public bool ok;
        public int acked;
        public string error;
    }

    /// <summary>本地时长队列（写盘用），字段名与上报体保持一致。</summary>
    [Serializable]
    public class UsageQueueFile
    {
        public UsageEvent[] events = Array.Empty<UsageEvent>();
    }
}
