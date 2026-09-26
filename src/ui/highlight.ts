import type { Theme } from "./theme.ts";

export interface HighlightSpec {
  keywords: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  lineComments: readonly string[];
  blockComment?: readonly [string, string];
  quotes: readonly string[];
  decorator?: boolean;
  hashComment?: boolean;
}

const JS_KEYWORDS = [
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "declare", "default", "delete",
  "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "get", "if", "implements", "import", "in",
  "instanceof", "interface", "keyof", "let", "namespace", "new", "of", "private", "protected", "public", "readonly", "return",
  "satisfies", "set", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "with",
  "yield", "true", "false", "null", "undefined", "infer", "asserts", "override", "using",
];

const PY_KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield", "True", "False", "None", "match", "case", "self", "cls",
];

const RUST_KEYWORDS = [
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "fn", "for", "if", "impl",
  "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
  "trait", "type", "unsafe", "use", "where", "while", "true", "false", "Some", "None", "Ok", "Err",
];

const GO_KEYWORDS = [
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if",
  "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var", "true", "false",
  "nil", "error", "string", "int", "int64", "float64", "bool", "byte", "rune", "any",
];

const SHELL_KEYWORDS = [
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "in", "select",
  "time", "return", "exit", "local", "declare", "export", "readonly", "source", "alias", "set", "unset", "shift", "trap",
  "echo", "printf", "cd", "pwd", "ls", "cat", "grep", "sed", "awk", "curl", "git", "npm", "pnpm", "yarn", "node", "python",
];

const SQL_KEYWORDS = [
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "drop",
  "index", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "union",
  "all", "distinct", "as", "and", "or", "not", "null", "is", "in", "between", "like", "case", "when", "then", "else", "end",
  "primary", "key", "foreign", "references", "default", "constraint", "with", "returning", "begin", "commit", "rollback",
];

const C_KEYWORDS = [
  "auto", "break", "case", "const", "continue", "default", "do", "else", "enum", "extern", "for", "goto", "if", "inline",
  "register", "restrict", "return", "sizeof", "static", "struct", "switch", "typedef", "union", "volatile", "while", "class",
  "namespace", "template", "public", "private", "protected", "virtual", "override", "nullptr", "true", "false", "using",
  "new", "delete", "try", "catch", "throw", "constexpr", "noexcept", "explicit",
];

const JAVA_KEYWORDS = [
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do",
  "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int",
  "interface", "long", "native", "new", "package", "private", "protected", "public", "record", "return", "sealed", "short",
  "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "var", "void",
  "volatile", "while", "true", "false", "null", "fun", "val",
];

const RUBY_KEYWORDS = [
  "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else", "elsif", "end", "ensure", "false",
  "for", "if", "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry", "return", "self", "super", "then",
  "true", "undef", "unless", "until", "when", "while", "yield", "attr_accessor", "attr_reader", "require", "include",
];

const PHP_KEYWORDS = [
  "abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone", "const", "continue", "declare",
  "default", "do", "echo", "else", "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif", "endswitch", "endwhile",
  "enum", "extends", "final", "finally", "fn", "for", "foreach", "function", "global", "goto", "if", "implements", "include",
  "instanceof", "insteadof", "interface", "isset", "list", "match", "namespace", "new", "or", "print", "private", "protected",
  "public", "readonly", "require", "return", "static", "switch", "throw", "trait", "try", "unset", "use", "var", "while",
  "xor", "yield", "true", "false", "null",
];

const LUA_KEYWORDS = ["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"];

const SPECS: Record<string, HighlightSpec> = {
  javascript: {
    keywords: new Set(JS_KEYWORDS),
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ["'", '"', "`"],
    decorator: true,
  },
  python: {
    keywords: new Set(PY_KEYWORDS),
    lineComments: ["#"],
    quotes: ["'", '"'],
    decorator: true,
  },
  rust: {
    keywords: new Set(RUST_KEYWORDS),
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"'],
  },
  go: {
    keywords: new Set(GO_KEYWORDS),
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "`"],
  },
  c: {
    keywords: new Set(C_KEYWORDS),
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  java: {
    keywords: new Set(JAVA_KEYWORDS),
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  ruby: {
    keywords: new Set(RUBY_KEYWORDS),
    lineComments: ["#"],
    quotes: ['"', "'"],
  },
  php: {
    keywords: new Set(PHP_KEYWORDS),
    lineComments: ["//", "#"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  shell: {
    keywords: new Set(SHELL_KEYWORDS),
    lineComments: ["#"],
    quotes: ['"', "'"],
    hashComment: true,
  },
  sql: {
    keywords: new Set(SQL_KEYWORDS),
    lineComments: ["--"],
    blockComment: ["/*", "*/"],
    quotes: ["'", '"'],
  },
  json: { keywords: new Set(["true", "false", "null"]), lineComments: [], quotes: ['"'] },
  yaml: { keywords: new Set(["true", "false", "null", "yes", "no"]), lineComments: ["#"], quotes: ['"', "'"] },
  toml: { keywords: new Set(["true", "false"]), lineComments: ["#"], quotes: ['"', "'"] },
  ini: { keywords: new Set(), lineComments: ["#", ";"], quotes: ['"'] },
  css: { keywords: new Set(["important", "media", "supports", "keyframes", "import", "from", "to"]), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'"] },
  html: { keywords: new Set(), lineComments: [], blockComment: ["<!--", "-->"], quotes: ['"', "'"] },
  markdown: { keywords: new Set(), lineComments: [], quotes: ["`"] },
  diff: { keywords: new Set(), lineComments: [], quotes: [] },
  dockerfile: { keywords: new Set(["FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "AS"]), lineComments: ["#"], quotes: ['"', "'"] },
  makefile: { keywords: new Set(["ifeq", "ifneq", "ifdef", "ifndef", "else", "endif", "include", "export", "unexport", "define", "endef", "override"]), lineComments: ["#"], quotes: ['"'] },
  lua: { keywords: new Set(LUA_KEYWORDS), lineComments: ["--"], blockComment: ["--[[", "]]"], quotes: ['"', "'"] },
  graphql: { keywords: new Set(["query", "mutation", "subscription", "fragment", "on", "type", "input", "enum", "interface", "union", "scalar", "schema", "extend", "implements", "directive"]), lineComments: ["#"], quotes: ['"'] },
  protobuf: { keywords: new Set(["syntax", "package", "import", "option", "message", "enum", "service", "rpc", "returns", "repeated", "optional", "required", "oneof", "map", "reserved", "extend"]), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"'] },
  hcl: { keywords: new Set(["resource", "variable", "output", "module", "provider", "terraform", "data", "locals", "true", "false", "null", "for", "in", "if"]), lineComments: ["#", "//"], blockComment: ["/*", "*/"], quotes: ['"'] },
  plaintext: { keywords: new Set(), lineComments: [], quotes: [] },
};

const EXTENSION_MAP: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "javascript", mts: "javascript", cts: "javascript", tsx: "javascript",
  py: "python", pyi: "python",
  rs: "rust",
  go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hxx: "c", m: "c", mm: "c",
  java: "java", kt: "java", kts: "java", scala: "java", groovy: "java", gradle: "java",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  php: "php",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell", env: "shell",
  sql: "sql", psql: "sql",
  json: "json", jsonc: "json", json5: "json", ipynb: "json", lock: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini", properties: "ini",
  css: "css", scss: "css", sass: "css", less: "css", styl: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html", astro: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff",
  tf: "hcl", tfvars: "hcl", hcl: "hcl",
  lua: "lua",
  graphql: "graphql", gql: "graphql",
  proto: "protobuf",
  swift: "c",
  r: "plaintext", pl: "php", pm: "php",
  dockerfile: "dockerfile", mk: "makefile", makefile: "makefile",
  txt: "plaintext", log: "plaintext", csv: "plaintext", tsv: "plaintext",
};

const ALIASES: Record<string, string> = {
  js: "javascript", javascript: "javascript", jsx: "javascript", ts: "javascript", typescript: "javascript", tsx: "javascript", node: "javascript", mjs: "javascript",
  py: "python", python3: "python", python: "python",
  rs: "rust", rust: "rust",
  golang: "go", go: "go",
  "c++": "c", cpp: "c", cxx: "c", cc: "c", hpp: "c", "c#": "java", csharp: "java", cs: "java",
  kt: "java", kotlin: "java", java: "java", scala: "java",
  rb: "ruby", ruby: "ruby",
  php: "php",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", terminal: "shell",
  sql: "sql", postgres: "sql", mysql: "sql", sqlite: "sql",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "ini", properties: "ini", env: "shell",
  css: "css", scss: "css", sass: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff",
  dockerfile: "dockerfile", docker: "dockerfile",
  makefile: "makefile", make: "makefile", mk: "makefile",
  lua: "lua", hcl: "hcl", terraform: "hcl", tf: "hcl",
  graphql: "graphql", gql: "graphql", proto: "protobuf", protobuf: "protobuf",
  text: "plaintext", txt: "plaintext", plaintext: "plaintext", plain: "plaintext", log: "plaintext",
};

export function supportedLanguages(): string[] {
  return [...new Set(Object.values(SPECS).map((_, index) => Object.keys(SPECS)[index]!))].sort();
}

export function normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const key = lang.trim().toLowerCase().replace(/^language-/, "");
  if (SPECS[key]) return key;
  return ALIASES[key];
}

export function detectLanguageFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base.startsWith(".") && base.length > 1 && !base.includes(".")) return "shell";
  const extension = base.includes(".") ? base.split(".").pop()! : "";
  return EXTENSION_MAP[extension];
}

export function highlight(code: string, lang?: string, opts: { theme?: Theme } = {}): string {
  const theme = opts.theme;
  const language = normalizeLanguage(lang) ?? (lang ? undefined : undefined);
  if (!theme || theme.name === "none" || !language) return code;
  const spec = SPECS[language];
  if (!spec) return code;

  const styles = {
    keyword: theme.primary,
    type: theme.info,
    string: theme.success,
    number: theme.warn,
    comment: theme.dim,
    fn: theme.accent,
    punct: theme.dim,
    diffAdd: theme.diffAdd,
    diffDel: theme.diffDel,
    diffHunk: theme.diffHunk,
  };

  if (language === "diff") return highlightDiff(code, styles);
  if (language === "yaml" || language === "toml" || language === "ini" || language === "markdown") {
    return highlightSimple(code, language, styles);
  }

  let inBlockComment = false;
  const result: string[] = [];
  for (const line of code.split("\n")) {
    const tokenized = tokenizeLine(line, spec, styles, { inBlockComment });
    inBlockComment = tokenized.inBlockComment;
    result.push(tokenized.text);
  }
  return result.join("\n");
}

interface Styles {
  keyword: (text: string) => string;
  type: (text: string) => string;
  string: (text: string) => string;
  number: (text: string) => string;
  comment: (text: string) => string;
  fn: (text: string) => string;
  punct: (text: string) => string;
  diffAdd: (text: string) => string;
  diffDel: (text: string) => string;
  diffHunk: (text: string) => string;
}

function tokenizeLine(
  line: string,
  spec: HighlightSpec,
  styles: Styles,
  state: { inBlockComment: boolean },
): { text: string; inBlockComment: boolean } {
  let out = "";
  let index = 0;
  let inBlock = state.inBlockComment;

  while (index < line.length) {
    const rest = line.slice(index);

    if (inBlock) {
      const closeIndex = spec.blockComment ? rest.indexOf(spec.blockComment[1]) : -1;
      if (closeIndex === -1) {
        return { text: out + styles.comment(rest), inBlockComment: true };
      }
      out += styles.comment(rest.slice(0, closeIndex + spec.blockComment![1].length));
      index += closeIndex + spec.blockComment![1].length;
      inBlock = false;
      continue;
    }

    const lineComment = spec.lineComments.find((token) => rest.startsWith(token));
    if (lineComment) {
      out += styles.comment(rest);
      index = line.length;
      continue;
    }

    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const closeIndex = rest.indexOf(spec.blockComment[1], spec.blockComment[0].length);
      if (closeIndex === -1) {
        inBlock = true;
        return { text: out + styles.comment(rest), inBlockComment: true };
      }
      out += styles.comment(rest.slice(0, closeIndex + spec.blockComment[1].length));
      index += closeIndex + spec.blockComment[1].length;
      continue;
    }

    const char = line[index]!;

    if (spec.quotes.includes(char)) {
      const stringMatch = readString(rest, char);
      out += styles.string(stringMatch);
      index += stringMatch.length;
      continue;
    }

    if (spec.decorator && char === "@" && /[A-Za-z_]/.test(line[index + 1] ?? "")) {
      const match = /^@[A-Za-z_][\w.]*/.exec(rest)!;
      out += styles.type(match[0]);
      index += match[0].length;
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(line[index + 1] ?? ""))) {
      const match = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)(n)?/.exec(rest)!;
      out += styles.number(match[0]);
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(rest)!;
      const word = match[0];
      const after = line.slice(index + word.length);
      const isCall = /^\s*(\(|::|\.)/.test(after);
      if (spec.keywords.has(word)) out += styles.keyword(word);
      else if (isCall) out += styles.fn(word);
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word) && word.length > 2) out += styles.type(word);
      else out += word;
      index += word.length;
      continue;
    }

    if (/[{}()[\];,.<>=+\-*/%!?&|^~:]/.test(char)) {
      out += styles.punct(char);
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return { text: out, inBlockComment: inBlock };
}

function readString(rest: string, quote: string): string {
  let index = 1;
  while (index < rest.length) {
    const char = rest[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return rest.slice(0, index + 1);
    index += 1;
  }
  return rest;
}

function highlightDiff(code: string, styles: Styles): string {
  return code
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) return styles.diffHunk(line);
      if (line.startsWith("+++") || line.startsWith("---")) return styles.punct(line);
      if (line.startsWith("+")) return styles.diffAdd(line);
      if (line.startsWith("-")) return styles.diffDel(line);
      return line;
    })
    .join("\n");
}

function highlightSimple(code: string, language: string, styles: Styles): string {
  return code
    .split("\n")
    .map((line) => {
      if (language === "markdown") {
        if (/^#{1,6}\s/.test(line)) return styles.keyword(line);
        if (/^\s*[-*+]\s/.test(line)) return line.replace(/^(\s*[-*+]\s)/, (match) => styles.punct(match));
        if (/^```/.test(line)) return styles.punct(line);
        return line;
      }
      const commentIndex = line.search(/#|;/);
      const hashMatches =
        language === "yaml" || language === "toml" || language === "ini"
          ? findCommentIndex(line, language)
          : -1;
      if (hashMatches >= 0) {
        const head = colorizeKeyValue(line.slice(0, hashMatches), styles);
        return `${head}${styles.comment(line.slice(hashMatches))}`;
      }
      void commentIndex;
      return colorizeKeyValue(line, styles);
    })
    .join("\n");
}

function findCommentIndex(line: string, language: string): number {
  let inString: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (inString) {
      if (char === inString && line[index - 1] !== "\\") inString = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (language === "ini" ? char === ";" || char === "#" : char === "#") return index;
  }
  return -1;
}

function colorizeKeyValue(line: string, styles: Styles): string {
  const match = /^(\s*)([\w.-]+)(\s*[:=]\s*)(.*)$/.exec(line);
  if (!match) {
    const listItem = /^(\s*-\s*)(.*)$/.exec(line);
    if (listItem) return `${styles.punct(listItem[1]!)}${listItem[2]}`;
    return line;
  }
  const [, indent, key, separator, value] = match;
  const painted = value!.replace(/^(["'])(.*)\1$/, (whole, quote: string, body: string) => `${quote}${styles.string(body)}${quote}`);
  return `${indent}${styles.type(key!)}${styles.punct(separator!)}${painted}`;
}
