import { ToolError } from "../util/errors.ts";
import { truncate } from "../util/text.ts";
import { optionalNumber, optionalString, requiredString } from "./args.ts";
import { defineTool } from "./types.ts";

const MAX_FETCH_BYTES = 3_000_000;
const MAX_SEARCH_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const FETCH_FORMATS = ["text", "markdown", "raw"] as const;

/**
 * Blocks link-local addresses, which is where cloud metadata services live
 * (169.254.169.254 hands out instance credentials). Ordinary loopback and
 * private addresses stay reachable so local dev servers keep working.
 */
export function assertSafeFetchUrl(url: URL): void {
  if (!/^https?:$/.test(url.protocol)) {
    throw new ToolError(`Only http and https URLs can be fetched (got ${url.protocol || "no scheme"})`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLinkLocal =
    host.startsWith("169.254.") ||
    host.startsWith("fe80:") ||
    /^::ffff:169\.254\./.test(host) ||
    host === "metadata.google.internal";
  if (isLinkLocal) {
    throw new ToolError(`Refusing to fetch ${url.href}: it resolves to a link-local metadata address`, {
      hint: "Metadata endpoints expose host credentials. Fetch the public URL instead.",
    });
  }
}

/** Follows redirects by hand so every hop is re-checked against the URL guard. */
async function safeFetch(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current);
    assertSafeFetchUrl(current);
  }
  throw new ToolError(`Too many redirects (more than ${MAX_REDIRECTS}) starting at ${url.href}`);
}

/**
 * Reads a response body up to `limit` bytes. Buffering first and checking the
 * size afterwards would let a large or endless response exhaust memory before
 * the limit ever applies.
 */
async function readCapped(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ToolError(`Response is too large (${Math.round(declared / 1024)} KB, limit ${Math.round(limit / 1024)} KB)`);
  }
  const body = response.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        chunks.push(value.subarray(0, value.byteLength - (total - limit)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  label: "WebFetch",
  description:
    "Fetch a URL and return readable text. HTML is converted to markdown-ish text; JSON and plain text are returned as-is. Use it for documentation, API references and changelogs.",
  tags: ["web", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      format: { type: "string", enum: ["text", "markdown", "raw"], description: "Defaults to markdown for HTML." },
      max_chars: { type: "number", description: "Truncate the result to this many characters." },
    },
    required: ["url"],
  },
  describe(args) {
    return truncate(optionalString(args, "url") ?? "?", 72);
  },
  async execute(args, ctx) {
    const input = requiredString(args, ["url", "uri", "link"], "web_fetch");
    let url: URL;
    try {
      url = new URL(input.startsWith("http") ? input : `https://${input}`);
    } catch {
      throw new ToolError(`Not a valid URL: ${input}`);
    }
    assertSafeFetchUrl(url);

    const requestedFormat = optionalString(args, "format");
    if (requestedFormat && !FETCH_FORMATS.includes(requestedFormat as (typeof FETCH_FORMATS)[number])) {
      throw new ToolError(`Unknown format "${requestedFormat}"`, {
        hint: `Use one of: ${FETCH_FORMATS.join(", ")}.`,
      });
    }

    const response = await safeFetch(
      url,
      {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; bluebird-cli/0.1.0)",
          accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
        },
      },
      AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
    ).catch((error: Error) => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`Fetch failed: ${error.message}`, { hint: "Check the URL and your network access." });
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ToolError(`HTTP ${response.status} for ${url.href}`, {
        hint: response.status === 404 ? "The page does not exist." : undefined,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const { text: body, truncated: bodyTruncated } = await readCapped(response, MAX_FETCH_BYTES);
    const format = (requestedFormat ?? (contentType.includes("html") ? "markdown" : "text")) as (typeof FETCH_FORMATS)[number];
    const converted =
      format === "raw" || !contentType.includes("html")
        ? body
        : format === "markdown"
          ? htmlToMarkdown(body)
          : htmlToText(body);
    const maxChars = Math.max(1000, Math.min(optionalNumber(args, "max_chars") ?? 60_000, 400_000));
    const clipped = converted.length > maxChars ? `${converted.slice(0, maxChars)}\n\n…[truncated at ${maxChars} characters]` : converted;
    const text = bodyTruncated ? `${clipped}\n\n…[response body was cut off at ${Math.round(MAX_FETCH_BYTES / 1024)} KB]` : clipped;

    return {
      content: `# ${url.href}\n\n${text.trim()}`,
      summary: `${Math.round(text.length / 1024)} KB`,
      display: { kind: "text", title: url.host + url.pathname, text: text.slice(0, 3000), collapseAfter: 16 },
      meta: { volatile: true, ...(bodyTruncated ? { truncated: true } : {}) },
    };
  },
});

export const webSearchTool = defineTool({
  name: "web_search",
  label: "WebSearch",
  description:
    "Search the web and return titles, URLs and snippets. Uses TAVILY_API_KEY, BRAVE_SEARCH_API_KEY or SERPER_API_KEY when present, otherwise DuckDuckGo.",
  tags: ["web", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      count: { type: "number", description: "Number of results (default 6, max 15)." },
    },
    required: ["query"],
  },
  describe(args) {
    return truncate(optionalString(args, "query") ?? "?", 72);
  },
  async execute(args, ctx) {
    const query = requiredString(args, ["query", "q", "search"], "web_search");
    const count = Math.max(1, Math.min(optionalNumber(args, "count", "limit") ?? 6, 15));
    const results = await searchWeb(query, count, ctx.signal);
    if (results.length === 0) {
      return { content: `No results for "${query}".`, summary: "no results" };
    }
    const rendered = results
      .map((result, index) => `${index + 1}. [${result.title}](${result.url})\n   ${result.snippet}`)
      .join("\n\n");
    return {
      content: `Results for "${query}":\n\n${rendered}`,
      summary: `${results.length} results`,
      display: { kind: "list", title: query, lines: results.map((result) => `${result.title} — ${result.url}`) },
      meta: { volatile: true },
    };
  },
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchWeb(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const tavily = process.env.TAVILY_API_KEY;
  if (tavily) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: tavily, query, max_results: count, search_depth: "basic" }),
      signal: timeout,
    });
    if (response.ok) {
      const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      return (data.results ?? []).map((entry) => ({
        title: entry.title ?? entry.url ?? "",
        url: entry.url ?? "",
        snippet: entry.content ?? "",
      }));
    }
  }

  const brave = process.env.BRAVE_SEARCH_API_KEY;
  if (brave) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    const response = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": brave },
      signal: timeout,
    });
    if (response.ok) {
      const data = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
      return (data.web?.results ?? []).map((entry) => ({
        title: entry.title ?? "",
        url: entry.url ?? "",
        snippet: entry.description ?? "",
      }));
    }
  }

  const serper = process.env.SERPER_API_KEY;
  if (serper) {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": serper },
      body: JSON.stringify({ q: query, num: count }),
      signal: timeout,
    });
    if (response.ok) {
      const data = (await response.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
      return (data.organic ?? []).map((entry) => ({
        title: entry.title ?? "",
        url: entry.link ?? "",
        snippet: entry.snippet ?? "",
      }));
    }
  }

  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; bluebird-cli/0.1.0)" },
    signal: timeout,
    redirect: "follow",
  }).catch((error: Error) => {
    throw new ToolError(`Search failed: ${error.message}`, {
      hint: "Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for a reliable search backend.",
    });
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ToolError(`Search backend returned HTTP ${response.status}`, {
      hint: "DuckDuckGo may be blocking automated requests. Set TAVILY_API_KEY for a stable backend.",
    });
  }
  const { text: html } = await readCapped(response, MAX_SEARCH_BYTES);
  return parseDuckDuckGo(html).slice(0, count);
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(match[1] ?? "");
    const url = normalizeDuckDuckGoUrl(rawUrl);
    if (!url.startsWith("http")) continue;
    results.push({
      title: stripTags(match[2] ?? "").trim(),
      url,
      snippet: stripTags(match[3] ?? "").trim(),
    });
  }
  return results;
}

function normalizeDuckDuckGoUrl(href: string): string {
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : parsed.href;
  } catch {
    return href;
  }
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => `\n\`\`\`\n${stripTags(code)}\n\`\`\`\n`);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => `\`${stripTags(code).trim()}\``);
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, body: string) => {
    return `\n\n${"#".repeat(Number(level))} ${stripTags(body).trim()}\n\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, body: string) => `\n- ${stripTags(body).trim()}`);
  text = text.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, body: string) => {
    const label = stripTags(body).trim();
    if (!label) return "";
    if (href.startsWith("#")) return label;
    return `[${label}](${href.startsWith("http") || href.startsWith("/") ? href : `#${href}`})`;
  });
  text = text
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");
}

export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    copy: "©",
    reg: "®",
    trade: "™",
    deg: "°",
    times: "×",
    middot: "·",
    bull: "•",
    laquo: "«",
    raquo: "»",
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}
