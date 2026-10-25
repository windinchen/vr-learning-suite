using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using VrLauncher.Core;
using VrLauncher.UI;

namespace VrLauncher.EditorTools
{
    /// <summary>
    /// 工程引导工具：一键生成启动器场景、写好 Android 打包参数、导出 APK。
    /// 场景是运行时用代码搭界面的，所以这里只需要摆一个空物体挂上两个脚本，不用手写 .unity。
    /// </summary>
    public static class ProjectBootstrapper
    {
        const string SceneFolder = "Assets/Scenes";
        const string ScenePath = SceneFolder + "/Launcher.unity";
        const string DefaultApkDir = "../Build/Android";
        const string ApkName = "VR-Launcher.apk";

        public const string AndroidPackage = "com.school.vr.launcher";

        [MenuItem("VR 启动器/① 生成场景并配置打包参数")]
        public static void SetupProject()
        {
            CreateScene();
            ConfigureAndroid();
            Debug.Log("[引导] 工程已就绪。菜单「VR 启动器」里可以继续配 SDK 或直接打 APK。");
        }

        [MenuItem("VR 启动器/② 配置 Android SDK 与 JDK 路径")]
        public static void ConfigureToolchain()
        {
            var sdk = Environment.GetEnvironmentVariable("ANDROID_HOME");
            if (string.IsNullOrEmpty(sdk))
            {
                sdk = Environment.GetEnvironmentVariable("ANDROID_SDK_ROOT");
            }

            if (string.IsNullOrEmpty(sdk))
            {
                sdk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library/Android/sdk");
            }

            // JDK 优先用编辑器自带的 OpenJDK：团结引擎把它做成单独的模块
            // （PlaybackEngines/AndroidPlayer/OpenJDK，见 scripts/install-tuanjie-android.sh），
            // 而且它要的是 JDK 17 —— 本机 JAVA_HOME 指的是 JDK 11，直接拿过去构建会报「JDK not found」。
            var jdk = FindEmbeddedJdk();
            var usingEmbedded = !string.IsNullOrEmpty(jdk);
            if (!usingEmbedded)
            {
                jdk = Environment.GetEnvironmentVariable("JAVA_HOME");
            }

            if (string.IsNullOrEmpty(jdk))
            {
                jdk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    "tools/jdk-11.0.32.1+1/Contents/Home");
            }

            // 键名这块挺脏的：Unity 老键是 AndroidAndroidSdkPath / AndroidAndroidKitPath，
            // 团结引擎的 Android 扩展里同时存在 AndroidSdkPath / AndroidNdkPath / AndroidJavaRoot 这套。
            // 只写一套会撞上「JDK not found」（构建第一步 Detect Java Development Kit 就抛，0 秒失败），
            // 索性几套都写上，谁在用谁读到都是同一个路径。
            EditorPrefs.SetString("AndroidAndroidSdkPath", sdk);
            EditorPrefs.SetString("AndroidSdkPath", sdk);
            EditorPrefs.SetString("AndroidAndroidKitPath", jdk);
            EditorPrefs.SetString("AndroidJavaRoot", jdk);
            EditorPrefs.SetString("AndroidGradlePath", string.Empty);
            // 模块自带的 Gradle（PlaybackEngines/AndroidPlayer/Tools/gradle），显式指过去免得它去找系统的
            var gradleRoot = Path.Combine(EditorApplication.applicationContentsPath, "PlaybackEngines/AndroidPlayer/Tools/gradle");

            // 光写路径不够，还得把「不用编辑器自带、改用我填的路径」这几个开关打开，
            // 否则编辑器照旧去 PlaybackEngines/AndroidPlayer/OpenJDK 找 JDK——
            // 团结引擎的 Android 模块包（MacEditorTargetInstaller）里并不含 OpenJDK，
            // 于是构建第一步就抛 UnityException: JDK not found，0 秒失败。
            EditorPrefs.SetBool("AndroidSetupSdkOverride", true);
            EditorPrefs.SetBool("AndroidSetupJvmSDKOverride", true);
            // Gradle 用模块自带的那份（PlaybackEngines/AndroidPlayer/Tools/gradle），所以这个开关保持关
            EditorPrefs.SetBool("AndroidSetupGradleOverride", false);
            // 「用编辑器自带 JDK」的勾选：自带的那个真在就用它（1），没有才改成手动指路径（0）
            EditorPrefs.SetInt("JdkUseEmbedded", usingEmbedded ? 1 : 0);
            if (Directory.Exists(gradleRoot))
            {
                EditorPrefs.SetString("AndroidGradleRoot", gradleRoot);
            }

            var ndk = FindNdk(sdk);
            if (!string.IsNullOrEmpty(ndk))
            {
                EditorPrefs.SetBool("AndroidSetupNdkOverride", true);
                // Unity 2022.3 的 Android 模块按 NDK 版本分键存路径，它要的是 r23b（23.1.7093019）；
                // 只写通用键会被忽略，构建时报「Android NDK not found」。几个键都写上。
                EditorPrefs.SetString("AndroidNdkRootR23B", ndk);
                EditorPrefs.SetString("AndroidNdkPath", ndk);
                EditorPrefs.SetString("AndroidNDKPath", ndk);
                EditorPrefs.SetString("AndroidNDKRoot", ndk);
            }

            Debug.Log("[引导] Android SDK：" + sdk + "\n[引导] JDK：" + jdk);
            Debug.Log("[引导] 已改为手动指定：SDK/JDK 用上面的路径，Gradle 用模块自带的那份");
            Debug.Log("[引导] Gradle：" + (Directory.Exists(gradleRoot) ? gradleRoot : "未找到，交给构建自己找"));
            Debug.Log("[引导] JDK 来源：" + (usingEmbedded ? "编辑器自带 OpenJDK" : "环境变量 JAVA_HOME / 兜底路径"));
            Debug.Log("[引导] NDK：" + (ndk ?? "未找到（IL2CPP 打包会失败，先装 ndk/23.1.7779620 即 r23b）"));
        }

        /// <summary>
        /// 找编辑器自带的 OpenJDK。两种目录惯例都认：
        /// OpenJDK/bin/javac（官方模块包是平铺的）和 OpenJDK/Contents/Home/bin/javac（macOS 惯例）。
        /// </summary>
        static string FindEmbeddedJdk()
        {
            var root = Path.Combine(EditorApplication.applicationContentsPath, "PlaybackEngines/AndroidPlayer/OpenJDK");
            foreach (var candidate in new[]
                     {
                         Path.Combine(root, "Contents/Home"),
                         root,
                     })
            {
                if (File.Exists(Path.Combine(candidate, "bin/javac")))
                {
                    return candidate;
                }
            }

            return null;
        }

        /// <summary>优先用环境变量指到的 NDK，否则取 SDK/ndk 下版本号最大的那个。</summary>
        static string FindNdk(string sdkPath)
        {
            foreach (var key in new[] { "ANDROID_NDK_ROOT", "ANDROID_NDK_HOME", "VR_LAUNCHER_NDK" })
            {
                var value = Environment.GetEnvironmentVariable(key);
                if (!string.IsNullOrEmpty(value) && Directory.Exists(value))
                {
                    return value;
                }
            }

            var root = Path.Combine(sdkPath ?? string.Empty, "ndk");
            if (!Directory.Exists(root))
            {
                return null;
            }

            string best = null;
            foreach (var dir in Directory.GetDirectories(root))
            {
                if (File.Exists(Path.Combine(dir, "source.properties"))
                    && (best == null || string.CompareOrdinal(Path.GetFileName(dir), Path.GetFileName(best)) > 0))
                {
                    best = dir;
                }
            }

            return best;
        }

        [MenuItem("VR 启动器/③ 打 APK（Android）")]
        public static void BuildApk()
        {
            if (!File.Exists(ScenePath))
            {
                CreateScene();
            }

            ConfigureAndroid();
            ConfigureToolchain();

            var apkDir = Environment.GetEnvironmentVariable("VRLAUNCHER_APK_DIR");
            if (string.IsNullOrEmpty(apkDir))
            {
                apkDir = DefaultApkDir;
            }

            Directory.CreateDirectory(apkDir);
            var apkPath = Path.Combine(apkDir, ApkName);

            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = apkPath,
                target = BuildTarget.Android,
                options = BuildOptions.None,
            };

            // 同一个批处理进程里第一次 BuildPlayer 常会读到还没同步到原生侧的 CPU 架构值，
            // 直接报「Target architecture not specified」；重跑一次同样的参数就能过，所以这里带重试。
            BuildReport report = default;
            var summary = default(BuildSummary);
            for (var attempt = 1; attempt <= 3; attempt++)
            {
                ConfigureAndroid();
                try
                {
                    report = BuildPipeline.BuildPlayer(options);
                    summary = report.summary;
                }
                catch (Exception e)
                {
                    Debug.Log("[打包] 第 " + attempt + " 次尝试抛异常：" + e.Message);
                    continue;
                }

                if (summary.result == BuildResult.Succeeded)
                {
                    break;
                }

                Debug.Log("[打包] 第 " + attempt + " 次尝试未通过（错误 " + summary.totalErrors + "），重新断言参数后再试");
            }

            var line = "[打包] 结果：" + summary.result + "｜耗时 " + summary.totalTime.TotalSeconds.ToString("F0")
                + " 秒｜错误 " + summary.totalErrors + "｜大小 " + (summary.totalSize / (1024 * 1024)) + " MB";
            if (summary.result == BuildResult.Succeeded)
            {
                Debug.Log(line + "｜产物：" + Path.GetFullPath(apkPath));
            }
            else
            {
                Debug.LogError(line);
            }

            if (IsBatchMode && summary.result != BuildResult.Succeeded)
            {
                EditorApplication.Exit(1);
            }
        }

        /// <summary>2022.3 的 EditorApplication 没有 isBatchMode，直接看命令行。</summary>
        static bool IsBatchMode
        {
            get
            {
                foreach (var arg in Environment.GetCommandLineArgs())
                {
                    if (string.Equals(arg, "-batchmode", StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                return false;
            }
        }

        static void CreateScene()
        {
            if (!AssetDatabase.IsValidFolder(SceneFolder))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? "Assets/Scenes");
                AssetDatabase.CreateFolder("Assets", "Scenes");
            }

            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var root = new GameObject("VR 学习启动器");
            root.AddComponent<LauncherBootstrap>();
            root.AddComponent<LauncherUI>();

            var cameraGo = new GameObject("主相机");
            cameraGo.transform.SetParent(root.transform, false);
            cameraGo.tag = "MainCamera";
            var camera = cameraGo.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.043f, 0.059f, 0.090f);
            camera.nearClipPlane = 0.1f;
            cameraGo.AddComponent<AudioListener>();
            cameraGo.transform.localPosition = new Vector3(0f, 1.6f, -1.4f);

            if (!EditorSceneManager.SaveScene(scene, ScenePath))
            {
                throw new IOException("场景保存失败：" + ScenePath);
            }

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("[引导] 场景已生成：" + ScenePath);
        }

        static void ConfigureAndroid()
        {
            PlayerSettings.companyName = "school";
            PlayerSettings.productName = "VR 学习启动器";
            PlayerSettings.SetApplicationIdentifier(BuildTargetGroup.Android, AndroidPackage);
            // PICO 是 arm64 单机，用 IL2CPP + ARM64（Unity 的 Mono 后端会拒绝 ARM64 单架构，
            // 只能带上没用的 ARMv7）。IL2CPP 需要 NDK，路径由上面的 ConfigureToolchain 写进 EditorPrefs。
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.SetApiCompatibilityLevel(BuildTargetGroup.Android, ApiCompatibilityLevel.NET_Unity_4_8);
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
            // Unity 2022.3 自带的 Gradle 模板是 AGP 7.1.2，compileSdk 只测到 33；
            // 设成 34 会在 Gradle 阶段报「use a newer Android Gradle Plugin」。SDK 里装 34 只是给 Unity 的组件检查用。
            PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevel33;
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;

            // 2022.3 的 Android 后处理器读的是新的「按平台架构」表（ProjectSettings 里的 platformArchitecture），
            // 只写旧的 targetArchitectures 会被判成「没选架构」，两个 API 都要写。索引 1 = ARM64。
            PlayerSettings.SetArchitecture(BuildTargetGroup.Android, 1);
            // 兼容旧字段表：命令行新建的工程里这张表是空的，Android 构建阶段会读它。
            EditorUserBuildSettings.SetPlatformSettings("Android", "TargetArchitectures", "2");
            PlayerSettings.Android.useAPKExpansionFiles = false;
            PlayerSettings.Android.renderOutsideSafeArea = true;
            PlayerSettings.allowUnsafeCode = false;
            // 校园后台都是 http://192.168.x.x:8787 这种明文地址。默认值 NotAllowed 时，
            // PC 模拟（编辑器跑在 macOS/Windows）会直接抛
            // 「InvalidOperationException: Insecure connection not allowed」，一个请求都发不出去，
            // 表现就是「连不上这个后台」；Android 有 usesCleartextTraffic 兜着，真机看不出问题。
            // 写死 Always allowed，编辑器和真机行为一致。
            PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed;
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.AutoRotation;
            EditorUserBuildSettings.androidBuildSystem = AndroidBuildSystem.Gradle;
            EditorUserBuildSettings.exportAsGoogleAndroidProject = false;
            AssetDatabase.SaveAssets();
            Debug.Log("[引导] Android 参数已写入：包名 " + AndroidPackage
                + "，Mono + ARM64（targetArchitectures=" + PlayerSettings.Android.targetArchitectures
                + "，GetArchitecture=" + PlayerSettings.GetArchitecture(BuildTargetGroup.Android)
                + "，旧表 TargetArchitectures=" + EditorUserBuildSettings.GetPlatformSettings("Android", "TargetArchitectures")
                + "）");
        }
    }
}
