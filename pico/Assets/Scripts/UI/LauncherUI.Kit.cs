using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace VrLauncher.UI
{
    /// <summary>
    /// 界面构件基元：图片、文字、输入框，以及四个定位工具（左上角 / 右上角 / 居中 / 铺满）。
    /// 卡片类的东西在 LauncherUI 其他分文件里，全部由这些基元拼出来。
    /// 圆角是运行时按 SDF 生成的九宫格精灵（工程里不放图片资源），所有卡片、按钮、胶囊都走它，界面上没有硬边方块。
    /// </summary>
    public partial class LauncherUI
    {
        Image AddImage(Transform parent, string name, Color color)
        {
            return AddImage(parent, name, color, 0);
        }

        /// <summary>radius &gt; 0 时换成圆角九宫格精灵（按 Sliced 画，拉多高多宽角都不糊）。</summary>
        Image AddImage(Transform parent, string name, Color color, int radius)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var image = go.AddComponent<Image>();
            if (radius > 0)
            {
                image.sprite = Rounded(radius);
                image.type = Image.Type.Sliced;
            }
            else
            {
                image.sprite = Solid;
            }

            image.color = color;
            return image;
        }

        Text AddText(Transform parent, string name, string content, float size, Color color)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var text = go.AddComponent<Text>();
            text.font = font;
            text.text = content;
            text.color = color;
            text.fontSize = Mathf.RoundToInt(size);
            // 行距按 1.0：uGUI 单行占位高约等于 fontSize*1.16，1.16 的行距会让大字比文本框还高，
            // 底部就被 Truncate 切掉一截。多行小字本来排版就松，1.0 读起来正合适。
            text.lineSpacing = 1.0f;
            text.horizontalOverflow = HorizontalWrapMode.Wrap;
            text.verticalOverflow = VerticalWrapMode.Truncate;
            text.raycastTarget = false;
            return text;
        }

        InputField AddInputField(Transform parent, string name, float x, float y, float width, float height)
        {
            var fieldBg = AddImage(parent, name, new Color(0f, 0f, 0f, 0.42f), Mathf.RoundToInt(height * 0.5f));
            Place(fieldBg.rectTransform, x, y, width, height);
            var field = fieldBg.gameObject.AddComponent<InputField>();

            var text = AddText(fieldBg.rectTransform, "文本", "", 21f, Ink);
            Place(text.rectTransform, 20f, 0f, width - 40f, height);
            text.alignment = TextAnchor.MiddleLeft;
            text.horizontalOverflow = HorizontalWrapMode.Overflow;
            text.verticalOverflow = VerticalWrapMode.Overflow;

            var placeholder = AddText(fieldBg.rectTransform, "占位", "http://192.168.1.100:8787", 21f, Muted);
            Place(placeholder.rectTransform, 20f, 0f, width - 40f, height);
            placeholder.alignment = TextAnchor.MiddleLeft;

            field.textComponent = text;
            field.placeholder = placeholder;
            field.characterLimit = 128;
            field.contentType = InputField.ContentType.Standard;
            field.lineType = InputField.LineType.SingleLine;
            return field;
        }

        /// <summary>左上角定位（界面里绝大多数东西用它）。</summary>
        static void Place(RectTransform rect, float x, float y, float width, float height)
        {
            rect.anchorMin = new Vector2(0f, 1f);
            rect.anchorMax = new Vector2(0f, 1f);
            rect.pivot = new Vector2(0f, 1f);
            rect.anchoredPosition = new Vector2(x, -y);
            rect.sizeDelta = new Vector2(width, height);
            FitRadius(rect, width, height);
        }

        /// <summary>右上角定位，卡片右侧那一列都用它，宽卡片也不会挤到左边文字。</summary>
        static void PlaceRight(RectTransform rect, float rightMargin, float y, float width, float height)
        {
            rect.anchorMin = new Vector2(1f, 1f);
            rect.anchorMax = new Vector2(1f, 1f);
            rect.pivot = new Vector2(1f, 1f);
            rect.anchoredPosition = new Vector2(-rightMargin, -y);
            rect.sizeDelta = new Vector2(width, height);
            FitRadius(rect, width, height);
        }

        /// <summary>
        /// 圆角自动收敛：九宫格上下（或左右）两片圆角加起来不能超过元素短边，否则中间可拉伸区被算成负数，
        /// 整块底色会塌成一条细线（状态胶囊、按钮、色条最容易被吃掉）。
        /// 所有定位工具都顺手调它，以后新增卡片不用自己惦记半径够不够。
        /// </summary>
        static void FitRadius(RectTransform rect, float width, float height)
        {
            if (rect == null)
            {
                return;
            }

            var shortest = Mathf.Min(width, height);
            if (shortest < 4f)
            {
                return;
            }

            var image = rect.GetComponent<Image>();
            if (image == null || image.sprite == null || image.type != Image.Type.Sliced)
            {
                return;
            }

            var radius = Mathf.RoundToInt(image.sprite.border.x);
            if (radius <= 0)
            {
                return;
            }

            // 给中间留出至少 2 像素可拉伸区，圆角视觉上还是全圆角
            var limit = Mathf.FloorToInt(shortest * 0.5f) - 1;
            if (limit < 1 || radius <= limit)
            {
                return;
            }

            image.sprite = Rounded(limit);
        }

        /// <summary>
        /// 贴着左边的竖条（卡片左侧色条）。上下各缩进 inset，圆角卡片里的色条才不会从弧形角上戳出去。
        /// </summary>
        static void PlaceBar(RectTransform rect, float x, float width, float inset = 0f)
        {
            rect.anchorMin = new Vector2(0f, 0f);
            rect.anchorMax = new Vector2(0f, 1f);
            rect.pivot = new Vector2(0f, 0.5f);
            rect.anchoredPosition = new Vector2(x, 0f);
            rect.sizeDelta = new Vector2(width, -2f * inset);
            FitRadius(rect, width, float.MaxValue);
        }

        /// <summary>贴着底边的横线（卡片选中高亮线），左右缩进、上方抬起，跟着圆角走。</summary>
        static void PlaceLine(RectTransform rect, float height, float inset = 0f, float lift = 0f)
        {
            rect.anchorMin = new Vector2(0f, 0f);
            rect.anchorMax = new Vector2(1f, 0f);
            rect.pivot = new Vector2(0.5f, 0f);
            rect.anchoredPosition = new Vector2(0f, lift);
            rect.sizeDelta = new Vector2(-2f * inset, height);
            FitRadius(rect, float.MaxValue, height);
        }

        static void Center(RectTransform rect, float width, float height, float offsetX = 0f, float offsetY = 0f)
        {
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(offsetX, offsetY);
            rect.sizeDelta = new Vector2(width, height);
            FitRadius(rect, width, height);
        }

        static void Stretch(RectTransform rect)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
        }

        /// <summary>
        /// 清空一个容器。必须先摘出父子关系再 Destroy：Destroy 要等这一帧结束才生效，
        /// 布局组会把还没消失的旧卡片一起排版，新卡片就被顶出遮罩外看不见。
        /// </summary>
        static void Clear(RectTransform host)
        {
            if (host == null)
            {
                return;
            }

            for (var i = host.childCount - 1; i >= 0; i -= 1)
            {
                var child = host.GetChild(i);
                child.SetParent(null, false);
                Destroy(child.gameObject);
            }
        }

        Sprite Solid
        {
            get
            {
                if (solid == null)
                {
                    var texture = new Texture2D(1, 1);
                    texture.SetPixel(0, 0, Color.white);
                    texture.Apply();
                    solid = Sprite.Create(texture, new Rect(0f, 0f, 1f, 1f), new Vector2(0.5f, 0.5f));
                }

                return solid;
            }
        }

        /// <summary>
        /// 按圆角半径生成（并缓存）一张圆角精灵：半径 R 的圆角矩形 SDF，边缘留 1 像素渐变做抗锯齿，
        /// 九宫格四角不参与拉伸，所以卡片拉多大多小圆角都不变形。半径就是九宫格边框宽度，
        /// 元素短边至少要 2×半径 + 2，不够的话 FitRadius 会自动降档。
        /// </summary>
        static Sprite Rounded(int radius)
        {
            Sprite cached;
            if (rounded.TryGetValue(radius, out cached) && cached != null)
            {
                return cached;
            }

            // 九宫格四角取 radius 像素（不是 radius+1）：这样「半径=短边一半」的胶囊
            // 中间可拉伸区还剩 0~2 像素，不会被打成负数、塌成一条细线。
            var border = radius;
            var size = (radius + 1) * 2;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            texture.wrapMode = TextureWrapMode.Clamp;
            texture.filterMode = FilterMode.Bilinear;

            var half = size * 0.5f;
            var inner = half - radius;
            for (var y = 0; y < size; y += 1)
            {
                for (var x = 0; x < size; x += 1)
                {
                    var qx = Mathf.Abs(x + 0.5f - half) - inner;
                    var qy = Mathf.Abs(y + 0.5f - half) - inner;
                    var ox = Mathf.Max(qx, 0f);
                    var oy = Mathf.Max(qy, 0f);
                    // sdRoundBox 末尾必须再减回半径，减完才是「到圆角矩形边界的距离」；
                    // 少减这一项，整张精灵就只有中心几个像素是不透明的，卡片会被画成中间一条亮带。
                    var distance = Mathf.Sqrt(ox * ox + oy * oy) + Mathf.Min(Mathf.Max(qx, qy), 0f) - radius;
                    texture.SetPixel(x, y, new Color(1f, 1f, 1f, Mathf.Clamp01(0.5f - distance)));
                }
            }

            texture.Apply();
            var sprite = Sprite.Create(texture, new Rect(0f, 0f, size, size), new Vector2(0.5f, 0.5f),
                100f, 0, SpriteMeshType.FullRect, new Vector4(border, border, border, border));
            sprite.name = "圆角" + radius;
            rounded[radius] = sprite;
            return sprite;
        }
    }
}
