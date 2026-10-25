using System;
using UnityEngine;

namespace VrLauncher.Core
{
    /// <summary>
    /// 把头显当前画面压成一帧图片交给后台，老师在网页上就能看见学生正在看什么。
    /// 这版 Unity 没有 JPEG 编码接口，统一用 PNG；画面太大就自动降分辨率重编码。
    /// 取画面用主相机离屏渲染（启动器界面就是这台相机画出来的），不依赖 ScreenCapture：
    /// 那个类在 Android 打包时程序集里引用不到，编辑器和真机会出现「一边能编一边不能编」。
    /// 只在主线程、一帧结束时调用；失败只回原因，不影响启动器主循环。
    /// </summary>
    public static class ScreenStreamer
    {
        /// <summary>画面最长边：够老师看清在跑哪个应用就行，别拿学生家的带宽开玩笑。</summary>
        public const int MaxEdge = 480;

        /// <summary>超上限时再降一档重编码。</summary>
        public const int FallbackEdge = 320;

        /// <summary>后台一帧最多收 900 KB，这里提前收着点。</summary>
        public const int MaxBytes = 600 * 1024;

        /// <summary>按比例缩到 edge 以内，长宽取整避免半像素抖动。</summary>
        public static void TargetSize(int sourceWidth, int sourceHeight, int edge, out int width, out int height)
        {
            var w = Mathf.Max(2, sourceWidth);
            var h = Mathf.Max(2, sourceHeight);
            var scale = Mathf.Min(1f, edge / (float) Mathf.Max(w, h));
            width = Mathf.Max(2, Mathf.RoundToInt(w * scale));
            height = Mathf.Max(2, Mathf.RoundToInt(h * scale));
        }

        /// <summary>抓一帧并编码成 PNG。返回 null 时看 error。</summary>
        public static byte[] CaptureFrame(out int width, out int height, out string error)
        {
            width = 0;
            height = 0;
            error = "";

            if (Screen.width < 2 || Screen.height < 2)
            {
                error = "屏幕尺寸读不到（" + Screen.width + "x" + Screen.height + "）";
                return null;
            }

            var bytes = Encode(Screen.width, Screen.height, MaxEdge, out width, out height, out error);
            if (bytes != null && bytes.Length > MaxBytes)
            {
                var smaller = Encode(Screen.width, Screen.height, FallbackEdge, out width, out height, out error);
                if (smaller != null)
                {
                    bytes = smaller;
                }
            }

            return bytes;
        }

        static byte[] Encode(int sourceWidth, int sourceHeight, int edge, out int width, out int height, out string error)
        {
            width = 0;
            height = 0;
            error = "";

            TargetSize(sourceWidth, sourceHeight, edge, out var w, out var h);
            var texture = new Texture2D(w, h, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            var temporary = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);

            try
            {
                string renderError;
                if (!RenderInto(temporary, out renderError))
                {
                    error = renderError;
                    return null;
                }

                RenderTexture.active = temporary;
                texture.ReadPixels(new Rect(0, 0, w, h), 0, 0, false);
                texture.Apply();

                var bytes = texture.EncodeToPNG();
                if (bytes == null || bytes.Length == 0)
                {
                    error = "画面编码成 PNG 失败";
                    return null;
                }

                width = w;
                height = h;
                return bytes;
            }
            catch (Exception exception)
            {
                error = exception.Message;
                return null;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(temporary);
                UnityEngine.Object.Destroy(texture);
            }
        }

        /// <summary>
        /// 把画面画进目标 RenderTexture：优先让主相机离屏渲染一次（编辑器、真机、XR 都走这条路），
        /// 拿不到相机就退一步拷后台缓冲。返回 false 时 error 里是中文原因。
        /// </summary>
        static bool RenderInto(RenderTexture target, out string error)
        {
            error = "";
            var camera = Camera.main;
            if (camera != null && camera.isActiveAndEnabled)
            {
                var previousTarget = camera.targetTexture;
                try
                {
                    camera.targetTexture = target;
                    camera.Render();
                    return true;
                }
                catch (Exception exception)
                {
                    error = "相机离屏渲染失败：" + exception.Message;
                }
                finally
                {
                    camera.targetTexture = previousTarget;
                }
            }

            try
            {
                Graphics.Blit((Texture) null, target);
                return true;
            }
            catch (Exception exception)
            {
                error = string.IsNullOrEmpty(error)
                    ? "取不到画面：没有可用相机（" + (camera == null ? "场景里没有主相机" : "主相机没启用")
                        + "），拷后台缓冲也失败：" + exception.Message
                    : error + "；拷后台缓冲也失败：" + exception.Message;
                return false;
            }
        }
    }
}
