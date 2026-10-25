using UnityEngine;

namespace VrLauncher.UI
{
    /// <summary>
    /// 中文字体：不依赖工程里的字体资源，直接找系统里的中文字体做动态字体。
    /// macOS 用苹方，Android/PICO 用 Noto Sans CJK /思源黑体，Windows 用微软雅黑。
    /// </summary>
    public static class ChineseFont
    {
        static Font cached;

        public static readonly string[] Candidates =
        {
            "Noto Sans CJK SC",
            "Noto Sans SC",
            "Source Han Sans SC",
            "Source Han Sans CN",
            "PingFang SC",
            "Heiti SC",
            "Hiragino Sans GB",
            "Microsoft YaHei",
            "Droid Sans Fallback",
            "WenQuanYi Micro Hei",
        };

        public static Font Load()
        {
            if (cached != null)
            {
                return cached;
            }

            cached = Font.CreateDynamicFontFromOSFont(Candidates, 32);
            if (cached == null)
            {
                cached = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
                Debug.LogWarning("[字体] 系统里没找到中文字体，退回内置字体，中文可能显示成方块");
            }
            else
            {
                Debug.Log("[字体] 使用中文字体：" + cached.name);
            }

            return cached;
        }

        /// <summary>字体能不能画这个字符（emoji 在中文字体里基本缺字，要退回首字徽标）。</summary>
        public static bool HasGlyph(Font font, string text)
        {
            if (font == null || string.IsNullOrEmpty(text))
            {
                return false;
            }

            // 表情符号块（U+2600 起）在 Noto Sans CJK / 苹方里都没有字形，
            // 而 RequestCharactersInTexture 会走回退链导致 HasCharacter 误报 true，画出来是空白。
            foreach (var ch in text)
            {
                if (ch >= 0x2600)
                {
                    return false;
                }
            }

            // 动态字体要先请求过一次，HasCharacter 才有准确结果
            font.RequestCharactersInTexture(text, 32, FontStyle.Normal);
            foreach (var ch in text)
            {
                if (char.IsWhiteSpace(ch))
                {
                    continue;
                }

                if (!font.HasCharacter(ch))
                {
                    return false;
                }
            }

            return true;
        }
    }
}
