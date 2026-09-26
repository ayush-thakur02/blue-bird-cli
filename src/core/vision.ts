import type { ResolvedModel } from "../config/schema.ts";

/** Model families known to accept image input. */
const VISION_PATTERNS: RegExp[] = [
  /claude/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4-turbo/i,
  /gpt-4v/i,
  /gpt-5/i,
  /\bchatgpt-4o/i,
  /\bo[134](-|$)/i,
  /gemini/i,
  /qwen[\w.-]*vl/i,
  /llava/i,
  /pixtral/i,
  /internvl/i,
  /llama[\w.-]*vision/i,
  /llama-4/i,
  /phi-[\d.]*-vision/i,
  /deepseek[\w.-]*vl/i,
  /grok[\w.-]*vision/i,
  /glm-4v/i,
  /minicpm[\w.-]*v/i,
  /moondream/i,
  /mistral-small-3/i,
  /minimax/i,
  /kimi[\w.-]*vision/i,
  /seed[\w.-]*vl/i,
  /step-1v/i,
  /yi-vl/i,
  /kosmos/i,
  /florence/i,
];

/** Model families that never accept images, so we do not offer the tool. */
const TEXT_ONLY_PATTERNS: RegExp[] = [
  /embed/i,
  /whisper/i,
  /tts/i,
  /dall-e/i,
  /stable-diffusion/i,
  /codex-mini/i,
  /text-embedding/i,
  /rerank/i,
  /moderation/i,
];

export function detectVisionSupport(modelId: string): boolean {
  if (TEXT_ONLY_PATTERNS.some((pattern) => pattern.test(modelId))) return false;
  return VISION_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Whether the active model can look at images. An explicit `supportsImages`
 * declaration always wins; otherwise the model id is inspected, and the mock
 * provider is assumed capable so demos and tests work offline. This gates the
 * `view_image` tool, where a wrong guess wastes a tool call.
 */
export function modelSupportsImages(model: ResolvedModel): boolean {
  if (model.model.supportsImages !== undefined) return model.model.supportsImages;
  if (model.api === "mock") return true;
  return detectVisionSupport(model.model.id) || detectVisionSupport(model.label);
}

/** True only for families that certainly cannot read images. */
export function isTextOnlyModel(modelId: string): boolean {
  return TEXT_ONLY_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Whether to attach an image the user explicitly handed over. Unknown models are
 * treated as capable — the user knows what they are running — while models that
 * are declared or known to be text-only are left alone.
 */
export function shouldAttachImages(model: ResolvedModel): boolean {
  if (model.model.supportsImages !== undefined) return model.model.supportsImages;
  if (model.api === "mock") return true;
  return !isTextOnlyModel(model.model.id) && !isTextOnlyModel(model.label);
}

export function visionHint(model: ResolvedModel): string {
  return (
    `The model "${model.model.id}" is not known to accept images. ` +
    `Set supportsImages: true on the model entry in your config if it does — otherwise switch to a ` +
    `vision-capable model (for example a Claude, GPT-4o/5-class, Gemini or Qwen-VL deployment).`
  );
}
