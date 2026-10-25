// 没有真机时，用纯 Node 画一张「像头显画面」的 PNG 传给后台，验证上课页的画面链路。
// 只依赖 node:zlib，不装任何包。
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 把 RGB 像素数组编码成 PNG。pixels 长度必须等于 width * height * 3。 */
export function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 真彩色
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // 每行的滤波类型：无滤波
    pixels.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hash = (text) => {
  let value = 0;
  for (const ch of String(text)) {
    value = (value * 31 + ch.charCodeAt(0)) & 0xffffff;
  }
  return value;
};

/**
 * 画一张模拟画面：底色随前台应用变化，中间一条进度条按分钟推进，
 * 这样在老师网页上一眼能看出「这台在跑哪个应用、画面在动」。
 */
export function mockScreenFrame({ width = 480, height = 270, foreground = "", progress = 0, label = "" }) {
  const seed = hash(foreground || "launcher");
  const base = [(seed & 0xff) / 4 + 12, ((seed >> 8) & 0xff) / 4 + 18, ((seed >> 16) & 0xff) / 4 + 34];
  const pixels = Buffer.alloc(width * height * 3);
  const barWidth = Math.round(width * 0.72 * Math.min(1, Math.max(0, progress)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      const fade = y / height;
      let r = base[0] * (1 - fade * 0.5);
      let g = base[1] * (1 - fade * 0.5);
      let b = base[2] * (1 - fade * 0.35);
      const inBar = y > height * 0.62 && y < height * 0.7 && x > width * 0.14 && x < width * 0.14 + barWidth;
      const inBarTrack = y > height * 0.62 && y < height * 0.7 && x > width * 0.14 && x < width * 0.86;
      const inTitle = y > height * 0.16 && y < height * 0.32 && x > width * 0.12 && x < width * 0.6;
      const inCard = y > height * 0.36 && y < height * 0.56 && x > width * 0.12 && x < width * 0.88;
      if (inCard) {
        r = 34;
        g = 48;
        b = 64;
      }
      if (inTitle) {
        r = 226;
        g = 238;
        b = 248;
      }
      if (inBarTrack) {
        r = 18;
        g = 28;
        b = 40;
      }
      if (inBar) {
        r = 53;
        g = 208;
        b = 186;
      }
      pixels[at] = Math.min(255, Math.round(r));
      pixels[at + 1] = Math.min(255, Math.round(g));
      pixels[at + 2] = Math.min(255, Math.round(b));
    }
  }
  return encodePng(width, height, pixels);
}
