import { deflateSync, inflateSync } from "node:zlib";

/** Long edge cap for screenshots sent to the model (plan computer-use D6); keeps a frame far below the 8 MiB relay limit. */
export const SCREENSHOT_MAX_EDGE = 1280;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Raster { width: number; height: number; channels: 1 | 2 | 3 | 4; data: Buffer }

export interface ScaledPng { data: Buffer; width: number; height: number; /** original / scaled; multiply model coordinates by this to get device pixels. */ scale: number }

/** Returns null when the PNG is not a plain 8-bit non-interlaced grey/RGB(A) image (caller then passes it through or rejects it by size). */
export function downscalePng(png: Buffer, maxEdge = SCREENSHOT_MAX_EDGE): ScaledPng | null {
  const raster = decodePng(png);
  if (!raster) return null;
  const longEdge = Math.max(raster.width, raster.height);
  if (longEdge <= maxEdge) return { data: png, width: raster.width, height: raster.height, scale: 1 };
  const ratio = maxEdge / longEdge;
  const width = Math.max(1, Math.round(raster.width * ratio));
  const height = Math.max(1, Math.round(raster.height * ratio));
  return { data: encodePng(resize(raster, width, height)), width, height, scale: raster.width / width };
}

export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function decodePng(png: Buffer): Raster | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = -1; let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return null;
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); bitDepth = body[8]!; colorType = body[9]!; interlace = body[12]!; }
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, 1 | 2 | 3 | 4>)[colorType];
  if (!channels || bitDepth !== 8 || interlace !== 0 || width === 0 || height === 0 || width * height > 64_000_000) return null;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= channels ? prev[x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = src[x]!; break;
        case 1: value = src[x]! + a; break;
        case 2: value = src[x]! + b; break;
        case 3: value = src[x]! + ((a + b) >> 1); break;
        case 4: value = src[x]! + paeth(a, b, c); break;
        default: return null;
      }
      row[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Area-average resize: each target pixel averages the source box it covers. */
function resize(source: Raster, width: number, height: number): Raster {
  const { channels } = source;
  const out = Buffer.alloc(width * height * channels);
  const xRatio = source.width / width; const yRatio = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio); const y1 = Math.min(source.height, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio); const x1 = Math.min(source.width, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));
      const count = (y1 - y0) * (x1 - x0);
      for (let channel = 0; channel < channels; channel += 1) {
        let sum = 0;
        for (let sy = y0; sy < y1; sy += 1) {
          let index = (sy * source.width + x0) * channels + channel;
          for (let sx = x0; sx < x1; sx += 1, index += channels) sum += source.data[index]!;
        }
        out[(y * width + x) * channels + channel] = Math.round(sum / count);
      }
    }
  }
  return { width, height, channels, data: out };
}

function encodePng(raster: Raster): Buffer {
  const { width, height, channels } = raster;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    raw[base] = 1; // Sub filter compresses UI screenshots noticeably better than None.
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? raster.data[y * stride + x - channels]! : 0;
      raw[base + 1 + x] = (raster.data[y * stride + x]! - left) & 0xff;
    }
  }
  const colorType = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as const)[channels];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = colorType;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

let crcTable: Uint32Array | undefined;
function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode raw 8-bit RGBA pixels as a PNG (used by tests and fixtures). */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  return encodePng({ width, height, channels: 4, data: rgba });
}

export function decodePngPixels(png: Buffer): { width: number; height: number; channels: number; data: Buffer } | null {
  return decodePng(png);
}
