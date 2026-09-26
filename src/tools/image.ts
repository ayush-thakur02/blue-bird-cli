import fs from "node:fs";
import path from "node:path";

import { shouldAttachImages, visionHint } from "../core/vision.ts";
import { ToolError } from "../util/errors.ts";
import { DEFAULT_MAX_IMAGE_BYTES, describeImage, exceedsComfortableSize, isImagePath, loadImage, mediaTypeFromPath } from "../util/images.ts";
import { optionalString, requiredString } from "./args.ts";
import { defineTool, type ToolContext } from "./types.ts";
import { ensureInsideWorkspace, resolveTarget } from "./workspace.ts";

export interface ImageToolOptions {
  note?: string;
  detail?: "auto" | "low" | "high";
  label?: string;
}

function imagesEnabled(ctx: ToolContext): boolean {
  return ctx.config.raw.images?.enabled !== false;
}

function maxBytesFor(ctx: ToolContext): number {
  return ctx.config.raw.images?.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
}

/**
 * Loads an image and shapes the tool result: a text description the model can
 * reason about even without vision, plus the encoded image itself.
 */
export function imageResult(ctx: ToolContext, absolute: string, options: ImageToolOptions = {}) {
  if (!imagesEnabled(ctx)) {
    throw new ToolError("Image input is disabled in this project", {
      hint: "Set images.enabled to true in .bluebird/config.json.",
    });
  }
  if (!shouldAttachImages(ctx.config.model)) {
    throw new ToolError(`Cannot look at ${path.basename(absolute)}: the active model is text-only`, {
      hint: visionHint(ctx.config.model),
    });
  }
  if (!ctx.config.raw.images?.allowOutsideWorkspace) ensureInsideWorkspace(ctx, absolute, "read");

  const image = loadImage(absolute, {
    maxBytes: maxBytesFor(ctx),
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.label ? { label: options.label } : {}),
  });

  const relative = relativePathOrRelative(ctx, absolute);
  const lines = [`Image: ${relative}`, describeImage(image)];
  if (exceedsComfortableSize(image)) {
    lines.push("Large image: providers downscale the long edge to about 1568px, so fine detail may be lost.");
  }
  if (options.note?.trim()) lines.push("", `Requested focus: ${options.note.trim()}`);
  lines.push("", "The image is attached to this result; describe what you observe rather than guessing.");
  const content = lines.join("\n");
  const dimensions = image.width && image.height ? `${image.width}×${image.height}` : "unknown size";
  const size = image.bytes > 1_000_000 ? `${(image.bytes / 1_000_000).toFixed(1)} MB` : `${(image.bytes / 1024).toFixed(1)} KB`;

  return {
    content,
    summary: `${dimensions} · ${size}`,
    display: { kind: "text" as const, title: relative, text: content, collapseAfter: 6 },
    images: [image],
    meta: { readFiles: [absolute], bytes: image.bytes, volatile: true },
  };
}

function relativePathOrRelative(ctx: ToolContext, absolute: string): string {
  const relative = path.relative(ctx.cwd, absolute);
  return relative.startsWith("..") ? absolute : relative;
}

/** True when the path or the file's first bytes look like an image. */
export function looksLikeImage(filePath: string, sampleSize = 16): boolean {
  if (isImagePath(filePath)) return true;
  try {
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(sampleSize);
      const read = fs.readSync(handle, buffer, 0, sampleSize, 0);
      return detectFromSample(buffer.subarray(0, read));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

function detectFromSample(sample: Buffer): boolean {
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (sample.length >= 3 && sample.subarray(0, 3).toString("latin1") === "GIF") return true;
  if (sample.length >= 4 && sample[0] === 0xff && sample[1] === 0xd8) return true;
  if (sample.length >= 12 && sample.subarray(0, 4).toString("latin1") === "RIFF" && sample.subarray(8, 12).toString("latin1") === "WEBP") return true;
  return false;
}

export const viewImageTool = defineTool({
  name: "view_image",
  label: "ViewImage",
  description:
    "Look at an image: screenshots, UI mockups, diagrams, charts, photos of whiteboards or error dialogs, or a rendered page. Returns the image to a vision model together with its dimensions and format. Use `read` for text files.",
  tags: ["fs", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  prompt: "When the user references a screenshot or design file, call `view_image` on it and describe what you actually see before changing code.",
  isEnabled(ctx) {
    return imagesEnabled(ctx) && shouldAttachImages(ctx.config.model);
  },
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to a PNG, JPEG, GIF or WebP file." },
      note: { type: "string", description: "What to look for, e.g. 'the spacing in the header'." },
      detail: {
        type: "string",
        enum: ["auto", "low", "high"],
        description: "Detail hint for OpenAI-style providers; `high` costs more tokens and reads small text better.",
      },
    },
    required: ["file_path"],
  },
  describe(args) {
    return optionalString(args, "file_path", "path", "file") ?? "?";
  },
  async prepare(args, ctx) {
    const requested = requiredString(args, ["file_path", "path", "file", "image"], "view_image");
    const absolute = resolveTarget(ctx, requested);
    if (!fs.existsSync(absolute)) {
      throw new ToolError(`No such file: ${requested}`, { hint: "Check the path, or list the directory first." });
    }
    if (!isImagePath(absolute) && mediaTypeFromPath(absolute) === undefined && !looksLikeImage(absolute)) {
      throw new ToolError(`${requested} is not a supported image (PNG, JPEG, GIF or WebP)`, {
        hint: "Use `read` for text files.",
      });
    }
    return {
      ...args,
      file_path: absolute,
      ...(optionalString(args, "note") ? { note: optionalString(args, "note")! } : {}),
      ...(optionalString(args, "detail") ? { detail: optionalString(args, "detail")! } : {}),
    };
  },
  async execute(args, ctx) {
    const absolute = args.file_path as string;
    return imageResult(ctx, absolute, {
      ...(typeof args.note === "string" ? { note: args.note } : {}),
      ...(typeof args.detail === "string" ? { detail: args.detail as "auto" | "low" | "high" } : {}),
    });
  },
});

export const MAX_IMAGES_PER_MESSAGE_DEFAULT = 8;

export function imageBudget(ctx: ToolContext): number {
  return ctx.config.raw.images?.maxPerMessage ?? MAX_IMAGES_PER_MESSAGE_DEFAULT;
}
