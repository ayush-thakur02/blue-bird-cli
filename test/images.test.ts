import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_IMAGE_BYTES, dataUrl, describeImage, detectImageType, exceedsComfortableSize, isImagePath, loadImage, mediaTypeFromPath } from "../src/util/images.ts";
import { estimateImageTokens } from "../src/util/tokens.ts";
import { detectVisionSupport, isTextOnlyModel, modelSupportsImages, shouldAttachImages } from "../src/core/vision.ts";
import { toWireMessages } from "../src/providers/openai-chat.ts";
import { toAnthropicMessages } from "../src/providers/anthropic.ts";
import { toResponsesInput } from "../src/providers/openai-responses.ts";
import { assistantMessage, userMessage, type ImageAttachment, type Message } from "../src/core/messages.ts";
import { collectImages, hasImages } from "../src/core/messages.ts";
import type { ResolvedModel } from "../src/config/schema.ts";

function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([header, ihdr, Buffer.alloc(16)]);
}

function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.write("GIF89a", 0, "latin1");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function webp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(32, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8X", 12, "latin1");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

test("image type detection reads dimensions from every supported format", () => {
  assert.deepEqual(detectImageType(png(1280, 720)), { mediaType: "image/png", width: 1280, height: 720 });
  assert.deepEqual(detectImageType(jpeg(800, 600)), { mediaType: "image/jpeg", width: 800, height: 600 });
  assert.deepEqual(detectImageType(gif(320, 200)), { mediaType: "image/gif", width: 320, height: 200, animated: false });
  assert.deepEqual(detectImageType(webp(1000, 500)), { mediaType: "image/webp", width: 1000, height: 500, animated: false });
  assert.equal(detectImageType(Buffer.from("not an image at all")), undefined);
});

test("path helpers recognise image files", () => {
  assert.equal(mediaTypeFromPath("shot.PNG"), "image/png");
  assert.equal(mediaTypeFromPath("a/b/photo.jpeg"), "image/jpeg");
  assert.equal(mediaTypeFromPath("notes.md"), undefined);
  assert.ok(isImagePath("design.webp"));
  assert.ok(!isImagePath("main.rs"));
});

test("loadImage produces base64 attachments with metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-image-"));
  const file = path.join(dir, "screenshot.png");
  fs.writeFileSync(file, png(1600, 900));
  try {
    const image = loadImage(file);
    assert.equal(image.mediaType, "image/png");
    assert.equal(image.width, 1600);
    assert.equal(image.height, 900);
    assert.equal(image.label, "screenshot.png");
    assert.ok(image.data.length > 0);
    assert.equal(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.match(dataUrl(image), /^data:image\/png;base64,/);
    assert.match(describeImage(image), /1600×900/);
    assert.ok(exceedsComfortableSize(image), "1600px exceeds the comfortable vision size");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadImage enforces the size limit and rejects non-images", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-image-"));
  const big = path.join(dir, "big.png");
  fs.writeFileSync(big, Buffer.concat([png(10, 10), Buffer.alloc(DEFAULT_MAX_IMAGE_BYTES)]));
  const text = path.join(dir, "notes.txt");
  fs.writeFileSync(text, "hello");
  try {
    assert.throws(() => loadImage(big), /larger than the/);
    assert.throws(() => loadImage(text), /not a supported image/);
    assert.ok(loadImage(big, { maxBytes: 10_000_000 }).bytes > DEFAULT_MAX_IMAGE_BYTES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("image token estimates scale with pixels and detail", () => {
  const low = estimateImageTokens(512, 512, "low");
  const high = estimateImageTokens(2048, 1536, "high");
  assert.ok(low > 0);
  assert.ok(high > low);
  assert.ok(estimateImageTokens() > 0);
});

test("vision support is detected from the model id", () => {
  assert.ok(detectVisionSupport("gpt-4o-mini"));
  assert.ok(detectVisionSupport("claude-sonnet-4-5"));
  assert.ok(detectVisionSupport("qwen2.5-vl-7b"));
  assert.ok(!detectVisionSupport("text-embedding-3-large"));
  assert.ok(!detectVisionSupport("whisper-large-v3"));
});

test("explicit supportsImages beats the heuristic", () => {
  const base = {
    providerId: "p",
    provider: { api: "openai-completions", baseURL: "https://host/v1" },
    model: { id: "text-only-model", supportsImages: true },
    api: "openai-completions",
    baseURL: "https://host/v1",
    apiKeySource: "none",
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    label: "p/text-only-model",
  } as unknown as ResolvedModel;
  assert.ok(modelSupportsImages(base));
  const denied = { ...base, model: { id: "gpt-4o", supportsImages: false } } as unknown as ResolvedModel;
  assert.ok(!modelSupportsImages(denied));
});

test("attaching a user-supplied image is optimistic, known text-only models are not", () => {
  const unknown = {
    providerId: "p",
    provider: { api: "openai-completions", baseURL: "https://gateway.internal/v1" },
    model: { id: "house-model-v3" },
    api: "openai-completions",
    baseURL: "https://gateway.internal/v1",
    apiKeySource: "none",
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    label: "p/house-model-v3",
  } as unknown as ResolvedModel;

  // Unknown models get the benefit of the doubt: the user chose to attach it.
  assert.ok(shouldAttachImages(unknown));
  assert.ok(!modelSupportsImages(unknown), "but the view_image tool stays conservative");

  const embedding = { ...unknown, model: { id: "text-embedding-3-large" } } as unknown as ResolvedModel;
  assert.ok(!shouldAttachImages(embedding));
  assert.ok(isTextOnlyModel("whisper-large-v3"));

  const declared = { ...unknown, model: { id: "house-model-v3", supportsImages: false } } as unknown as ResolvedModel;
  assert.ok(!shouldAttachImages(declared));
});

function attachment(): ImageAttachment {
  return {
    id: "img_1",
    label: "shot.png",
    mediaType: "image/png",
    data: png(64, 64).toString("base64"),
    bytes: 64,
    width: 64,
    height: 64,
  };
}

function conversation(): Message[] {
  return [
    userMessage("look at this"),
    assistantMessage([
      { type: "text", text: "opening it" },
      { type: "tool_call", id: "c1", name: "view_image", args: { file_path: "shot.png" } },
    ]),
    {
      id: "m1",
      role: "tool",
      ts: Date.now(),
      blocks: [{ type: "tool_result", id: "c1", name: "view_image", content: "Image: shot.png\nPNG 64×64", images: [attachment()] }],
    },
  ];
}

test("openai chat wire format carries images as image_url parts", () => {
  const wire = toWireMessages("system", conversation(), new Set());
  const tool = wire.find((message) => message.role === "tool")!;
  assert.equal(typeof tool.content, "string", "tool messages stay text-only");

  const followUp = wire[wire.length - 1]!;
  assert.equal(followUp.role, "user");
  const parts = followUp.content as { type: string; image_url?: { url: string } }[];
  assert.ok(Array.isArray(parts));
  const image = parts.find((part) => part.type === "image_url")!;
  assert.match(image.image_url!.url, /^data:image\/png;base64,/);
});

test("openai chat wire format carries user image attachments", () => {
  const message = userMessage("what is wrong here?");
  message.blocks.push({ type: "image", image: attachment() });
  const wire = toWireMessages("system", [message], new Set());
  const parts = wire[1]!.content as { type: string; text?: string }[];
  assert.equal(parts[0]!.type, "text");
  assert.equal(parts[1]!.type, "image_url");
  assert.ok(hasImages(message));
  assert.equal(collectImages(message).length, 1);
});

test("anthropic wire format puts images inside the tool_result", () => {
  const wire = toAnthropicMessages(conversation());
  const result = wire[2]!;
  const block = result.content[0]!;
  assert.equal(block.type, "tool_result");
  const inner = block.content as { type: string; source?: { type: string; media_type: string; data: string } }[];
  assert.equal(inner[0]!.type, "text");
  assert.equal(inner[1]!.type, "image");
  assert.equal(inner[1]!.source!.type, "base64");
  assert.equal(inner[1]!.source!.media_type, "image/png");
  assert.ok(inner[1]!.source!.data.length > 0);
});

test("anthropic wire format carries user image attachments", () => {
  const message = userMessage("check this mockup");
  message.blocks.push({ type: "image", image: attachment() });
  const wire = toAnthropicMessages([message]);
  assert.equal(wire[0]!.content[1]!.type, "image");
});

test("responses wire format carries images in output arrays and user content", () => {
  const input = toResponsesInput(conversation()) as Record<string, unknown>[];
  const output = input.find((entry) => entry.type === "function_call_output")!;
  const content = output.output as { type: string }[];
  assert.ok(Array.isArray(content));
  assert.equal(content[0]!.type, "input_text");
  assert.equal(content[1]!.type, "input_image");

  const message = userMessage("rate this UI");
  message.blocks.push({ type: "image", image: attachment() });
  const input2 = toResponsesInput([message]) as Record<string, unknown>[];
  const userContent = input2[0]!.content as { type: string }[];
  assert.equal(userContent[1]!.type, "input_image");
});
