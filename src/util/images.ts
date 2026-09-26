import fs from "node:fs";
import path from "node:path";
import type { ImageAttachment, ImageMediaType } from "../core/messages.ts";
import { prefixedId } from "./ids.ts";
import { ToolError } from "./errors.ts";
import { estimateImageTokens } from "./tokens.ts";

export interface ImageInfo {
  mediaType: ImageMediaType;
  width?: number;
  height?: number;
  animated?: boolean;
}

const EXTENSION_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mediaTypeFromPath(filePath: string): ImageMediaType | undefined {
  return EXTENSION_TYPES[path.extname(filePath).toLowerCase()];
}

export function isImagePath(filePath: string): boolean {
  return mediaTypeFromPath(filePath) !== undefined;
}

/** Identifies an image from its magic bytes, independent of the file name. */
export function detectImageType(buffer: Buffer): ImageInfo | undefined {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {
      mediaType: "image/png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString("latin1") === "GIF") {
    return {
      mediaType: "image/gif",
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
      animated: countGifFrames(buffer) > 1,
    };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mediaType: "image/webp", ...webpDimensions(buffer) };
  }
  const jpeg = jpegInfo(buffer);
  if (jpeg) return jpeg;
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jpegInfo(buffer: Buffer): ImageInfo | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        mediaType: "image/jpeg",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  return { mediaType: "image/jpeg" };
}

function webpDimensions(buffer: Buffer): { width?: number; height?: number; animated?: boolean } {
  const chunk = buffer.subarray(12, 16).toString("latin1");
  try {
    if (chunk === "VP8X") {
      const width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff);
      const height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff);
      const flags = buffer.readUInt8(20);
      return { width, height, animated: (flags & 0x02) !== 0 };
    }
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  } catch {
    return {};
  }
  return {};
}

function countGifFrames(buffer: Buffer): number {
  let frames = 0;
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0x21 && buffer[index + 1] === 0xf9) frames += 1;
  }
  return Math.max(1, frames);
}

export interface LoadImageOptions {
  maxBytes?: number;
  detail?: "auto" | "low" | "high";
  label?: string;
  note?: string;
}

export const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

/**
 * Reads an image from disk and prepares it for the model: magic-byte sniffing,
 * size limits, dimension probing and base64 encoding.
 */
export function loadImage(filePath: string, options: LoadImageOptions = {}): ImageAttachment {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    throw new ToolError(`Image not found: ${filePath}`);
  }
  if (!stats.isFile()) throw new ToolError(`${filePath} is not a file`);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (stats.size > maxBytes) {
    throw new ToolError(
      `Image is ${(stats.size / 1_000_000).toFixed(1)} MB, larger than the ${(maxBytes / 1_000_000).toFixed(1)} MB limit`,
      { hint: "Crop or downscale the image first, or raise images.maxBytes in your config." },
    );
  }

  const buffer = fs.readFileSync(filePath);
  const info = detectImageType(buffer);
  if (!info) {
    throw new ToolError(
      `${path.basename(filePath)} is not a supported image (PNG, JPEG, GIF or WebP)`,
      { hint: "Convert it first, for example `sips -s format png in.heic --out out.png` on macOS." },
    );
  }

  const extensionType = mediaTypeFromPath(filePath);
  const mediaType = extensionType ?? info.mediaType;
  return {
    id: prefixedId("img"),
    path: filePath,
    label: options.label ?? path.basename(filePath),
    mediaType,
    data: buffer.toString("base64"),
    bytes: buffer.length,
    ...(info.width ? { width: info.width } : {}),
    ...(info.height ? { height: info.height } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
}

export function dataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function describeImage(image: ImageAttachment): string {
  const dimensions = image.width && image.height ? `${image.width}×${image.height}` : "unknown size";
  const size = `${(image.bytes / 1024).toFixed(image.bytes > 1_000_000 ? 0 : 1)} KB`;
  return `${image.label} (${image.mediaType.replace("image/", "").toUpperCase()}, ${dimensions}, ${size})`;
}

/** Rough token cost of sending the image to a vision model. */
export function imageTokenCost(image: ImageAttachment): number {
  return estimateImageTokens(image.width ?? 1024, image.height ?? 1024);
}

/**
 * The long edge Anthropic and OpenAI downscale to. Reporting it helps the model
 * know when fine detail may be lost.
 */
export const VISION_LONG_EDGE = 1568;

export function exceedsComfortableSize(image: ImageAttachment): boolean {
  const longEdge = Math.max(image.width ?? 0, image.height ?? 0);
  return longEdge > VISION_LONG_EDGE;
}
