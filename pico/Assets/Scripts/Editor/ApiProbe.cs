using System;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace VrLauncher.EditorTools
{
    /// <summary>
    /// 诊断：逐个试「脚本后端 x CPU 架构」组合，找出能被 Android 构建接受的那一个。
    /// 架构校验在 PrepareForBuild 阶段几十毫秒就失败，所以一次运行能试完全部组合。
    /// </summary>
    public static class ApiProbe
    {
        [MenuItem("VR 启动器/调试：试架构组合")]
        public static void DiagnoseArch()
        {
            var scene = "Assets/Scenes/Launcher.unity";
            var combos = new (ScriptingImplementation Backend, AndroidArchitecture Arch, string Name)[]
            {
                (ScriptingImplementation.Mono2x, AndroidArchitecture.ARM64, "Mono + ARM64"),
                (ScriptingImplementation.Mono2x, AndroidArchitecture.ARMv7 | AndroidArchitecture.ARM64, "Mono + ARMv7|ARM64"),
                (ScriptingImplementation.IL2CPP, AndroidArchitecture.ARM64, "IL2CPP + ARM64"),
            };

            var report = new StringBuilder();
            foreach (var combo in combos)
            {
                PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, combo.Backend);
                PlayerSettings.Android.targetArchitectures = combo.Arch;
                PlayerSettings.SetArchitecture(BuildTargetGroup.Android,
                    combo.Arch == AndroidArchitecture.ARM64 ? 1 : 2);

                var options = new BuildPlayerOptions
                {
                    scenes = new[] { scene },
                    locationPathName = Path.Combine(
                        Path.GetFullPath("Temp/probe"), "probe-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".apk"),
                    target = BuildTarget.Android,
                    options = BuildOptions.BuildScriptsOnly,
                };

                BuildReport r;
                try
                {
                    r = BuildPipeline.BuildPlayer(options);
                }
                catch (Exception e)
                {
                    report.AppendLine("【" + combo.Name + "】抛异常：" + e.Message.Replace("\n", " / "));
                    continue;
                }

                report.AppendLine("【" + combo.Name + "】结果=" + r.summary.result
                    + " 错误数=" + r.summary.totalErrors
                    + " 读回 targetArchitectures=" + PlayerSettings.Android.targetArchitectures
                    + " GetArchitecture=" + PlayerSettings.GetArchitecture(BuildTargetGroup.Android));

                if (r.summary.result == BuildResult.Succeeded)
                {
                    report.AppendLine(">>> 可用配置：" + combo.Name);
                    break;
                }
            }

            Debug.Log("[架构诊断]\n" + report);
            foreach (var arg in Environment.GetCommandLineArgs())
            {
                if (string.Equals(arg, "-batchmode", StringComparison.OrdinalIgnoreCase))
                {
                    EditorApplication.Exit(0);
                }
            }
        }
    }
}
