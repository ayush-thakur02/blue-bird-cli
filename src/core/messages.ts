import type { Usage } from "./contracts.ts";
import type { Effort } from "../config/schema.ts";
import { messageId } from "../util/ids.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  /** Provider-specific signature (Anthropic requires echoing it back). */
  signature?: string;
  redacted?: boolean;
}

/** An image the model can actually look at. */
export interface ImageAttachment {
  /** Stable id so repeated attachments can be de-duplicated. */
  id: string;
  /** Absolute path on disk, when it came from the filesystem. */
  path?: string;
  /** Display label, e.g. "design.png" or "screenshot". */
  label: string;
  mediaType: ImageMediaType;
  /** Base64 payload without the data URL prefix. */
  data: string;
  bytes: number;
  width?: number;
  height?: number;
  /** OpenAI-compatible detail hint. */
  detail?: "auto" | "low" | "high";
  note?: string;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageBlock {
  type: "image";
  image: ImageAttachment;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Raw argument text as received, kept for diagnostics. */
  raw?: string;
  parseError?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  id: string;
  name: string;
  content: string;
  isError?: boolean;
  /** Images produced by the tool, sent to vision models alongside the text. */
  images?: ImageAttachment[];
}

export type Block = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | ImageBlock;

export interface MessageMeta {
  model?: string;
  providerId?: string;
  effort?: Effort;
  usage?: Usage;
  elapsedMs?: number;
  interrupted?: boolean;
  /** Injected by the harness rather than produced by the model. */
  synthetic?: boolean;
  /** Replacement summary created during compaction. */
  compacted?: boolean;
  /** Number of turns folded into this message by compaction. */
  folded?: number;
  hidden?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  blocks: Block[];
  ts: number;
  meta?: MessageMeta;
}

export function createMessage(role: Role, blocks: Block[], meta?: MessageMeta): Message {
  return { id: messageId(), role, blocks, ts: Date.now(), ...(meta ? { meta } : {}) };
}

export function userMessage(text: string, meta?: MessageMeta): Message {
  return createMessage("user", [{ type: "text", text }], meta);
}

export function systemMessage(text: string, meta?: MessageMeta): Message {
  return createMessage("system", [{ type: "text", text }], meta);
}

export function assistantMessage(blocks: Block[], meta?: MessageMeta): Message {
  return createMessage("assistant", blocks, meta);
}

export function toolResultMessage(results: ToolResultBlock[], meta?: MessageMeta): Message {
  return createMessage("tool", results, meta);
}

export function textBlocks(message: Message): TextBlock[] {
  return message.blocks.filter((block): block is TextBlock => block.type === "text");
}

export function toolCallBlocks(message: Message): ToolCallBlock[] {
  return message.blocks.filter((block): block is ToolCallBlock => block.type === "tool_call");
}

export function toolResultBlocks(message: Message): ToolResultBlock[] {
  return message.blocks.filter((block): block is ToolResultBlock => block.type === "tool_result");
}

export function thinkingBlocks(message: Message): ThinkingBlock[] {
  return message.blocks.filter((block): block is ThinkingBlock => block.type === "thinking");
}

export function imageBlocks(message: Message): ImageBlock[] {
  return message.blocks.filter((block): block is ImageBlock => block.type === "image");
}

/** Every image carried by a message, whether attached or produced by a tool. */
export function collectImages(message: Message): ImageAttachment[] {
  const images: ImageAttachment[] = [];
  for (const block of message.blocks) {
    if (block.type === "image") images.push(block.image);
    else if (block.type === "tool_result" && block.images?.length) images.push(...block.images);
  }
  return images;
}

export function hasImages(message: Message): boolean {
  return message.blocks.some(
    (block) => block.type === "image" || (block.type === "tool_result" && (block.images?.length ?? 0) > 0),
  );
}

export function messageText(message: Message): string {
  return message.blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function messageThinking(message: Message): string {
  return thinkingBlocks(message)
    .map((block) => block.text)
    .join("");
}

export function hasToolCalls(message: Message): boolean {
  return message.blocks.some((block) => block.type === "tool_call");
}

export function isToolResultFor(block: ToolResultBlock, call: ToolCallBlock): boolean {
  return block.id === call.id;
}

export function cloneMessage(message: Message): Message {
  return {
    ...message,
    blocks: message.blocks.map((block) => ({ ...block })),
    ...(message.meta ? { meta: { ...message.meta } } : {}),
  };
}
