// src/host/config.ts
import Schema from "@deepseek-ai/schemastery";

// src/contract.ts
var DEFAULT_THRESHOLDS = {
  critical: 0.85,
  medium: 0.65,
  low: 0.45
};
var STARTLUX_THRESHOLDS = {
  critical: 0.52,
  medium: 0.37,
  low: 0.24
};
var QUESTION_SET_VERSION = "jev-highlight/questions/v2";
var MAX_QUESTION_CHARS = 600;
var PRIORITY_WEIGHTS = {
  coreAnswer: 0.5,
  actionable: 0.3,
  warningOrDefinition: 0.2
};
function unitInterval(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
function combinePriority(scores) {
  const value = PRIORITY_WEIGHTS.coreAnswer * unitInterval(scores.is_core_answer) + PRIORITY_WEIGHTS.actionable * unitInterval(scores.is_actionable) + PRIORITY_WEIGHTS.warningOrDefinition * Math.max(unitInterval(scores.is_warning), unitInterval(scores.is_definition));
  return Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4;
}
function levelFor(priority, thresholds = DEFAULT_THRESHOLDS) {
  const p = unitInterval(priority);
  if (p >= thresholds.critical) return "critical";
  if (p >= thresholds.medium) return "medium";
  if (p >= thresholds.low) return "low";
  return "none";
}

// src/host/config.ts
function threshold(label, value) {
  return Schema.number().min(0).max(1).default(value).description(`Priority cutoff for the ${label} highlight bucket (0..1).`);
}
var Config = Schema.object({
  provider: Schema.string().default("startlux").description("Judge backend: 'startlux' (domestic default, OpenAI-compatible decision API) or 'jev' (TypeSafe)."),
  jevApiKey: Schema.string().default("").description("Jev only \u2014 optional literal override. Prefer $DSH_HOME/.credentials.yaml jevApiKey or JEV_API_KEY."),
  jevBaseUrl: Schema.string().default("https://api.typesafe.ai").description("Jev only \u2014 API origin; the client appends /v1/systemone."),
  model: Schema.string().default("jev-1.13.0").description("Jev model version (used when provider = jev)."),
  startluxBaseUrl: Schema.string().default("https://api.bamboonode.dev/v1").description("StartLux OpenAI-compatible decision API base (Bamboo Relay default)."),
  startluxModel: Schema.string().default("startlux-decision-27b-autothink").description("StartLux / Bamboo model id sent in the request body."),
  startluxEndpointPath: Schema.string().default("/decisions").description("Path appended to startluxBaseUrl (Bamboo: /decisions; self-hosted TypeSafe-compatible: /systemone)."),
  startluxThinkMode: Schema.string().default("never").description("StartLux think_mode: 'never' (fastest), 'auto', or 'always'. Ignored by Instant models."),
  startluxKeyFile: Schema.string().default("").description("Optional key-file path; empty resolves to $DSH_HOME/jev-highlight-startlux.key (written by the Settings tab)."),
  maxConcurrency: Schema.natural().min(1).max(12).default(8).description("Maximum in-flight Jev requests; the spec asks for 8\u201312."),
  requestTokenBudget: Schema.natural().min(1e3).max(6e4).default(24e3).description("Estimated input-token cap per Jev request (spec: 20k\u201324k, hard API cap 64k)."),
  unitTokenBudget: Schema.natural().min(500).max(24e3).default(2e4).description("Oversized units are split into sub-chunks no larger than this."),
  cacheCapacity: Schema.natural().min(1).max(1e5).default(500).description("LRU verdict cache entries keyed by content hash."),
  requestTimeoutMs: Schema.natural().min(1e3).max(12e4).default(3e4).description("Per-request timeout; the AbortSignal also cancels on turn/plugin teardown."),
  startluxThresholds: Schema.object({
    critical: threshold("critical", STARTLUX_THRESHOLDS.critical),
    medium: threshold("medium", STARTLUX_THRESHOLDS.medium),
    low: threshold("low", STARTLUX_THRESHOLDS.low)
  }).default({ ...STARTLUX_THRESHOLDS }).description(
    "StartLux-only priority cutoffs (calibrated: .52/.37/.24). highlightThresholds is used for provider=jev."
  ),
  highlightThresholds: Schema.object({
    critical: threshold("critical", DEFAULT_THRESHOLDS.critical),
    medium: threshold("medium", DEFAULT_THRESHOLDS.medium),
    low: threshold("low", DEFAULT_THRESHOLDS.low)
  }).default({ ...DEFAULT_THRESHOLDS }).description("Jev-only priority cutoffs: critical >= .85, medium >= .65, low >= .45, below = none."),
  autoStart: Schema.boolean().default(true).description("Judge streamed units automatically; false keeps the pipeline idle until toggled."),
  requireApiKey: Schema.boolean().default(false).description(
    "true = fail activation with MissingJevApiKeyError when no key resolves (strict); false (default) = load in degraded mode, keep routes/chip, disable judging, and report the error."
  ),
  debug: Schema.boolean().default(false).description("Verbose host logging.")
});
function normaliseConfig(raw) {
  const provider = raw?.provider === "jev" ? "jev" : "startlux";
  const rawThresholds = provider === "startlux" ? raw?.startluxThresholds : raw?.highlightThresholds;
  const fallback = provider === "startlux" ? STARTLUX_THRESHOLDS : DEFAULT_THRESHOLDS;
  const thresholds = {
    critical: clamp01(rawThresholds?.critical, fallback.critical),
    medium: clamp01(rawThresholds?.medium, fallback.medium),
    low: clamp01(rawThresholds?.low, fallback.low)
  };
  if (thresholds.medium > thresholds.critical) thresholds.medium = thresholds.critical;
  if (thresholds.low > thresholds.medium) thresholds.low = thresholds.medium;
  return {
    provider,
    jevApiKey: str(raw?.jevApiKey),
    jevBaseUrl: stripTrailingSlash(str(raw?.jevBaseUrl) || "https://api.typesafe.ai"),
    model: str(raw?.model) || "jev-1.13.0",
    startluxBaseUrl: stripTrailingSlash(str(raw?.startluxBaseUrl) || "https://api.bamboonode.dev/v1"),
    startluxModel: str(raw?.startluxModel) || "startlux-decision-27b-autothink",
    startluxEndpointPath: normalisePath(str(raw?.startluxEndpointPath), "/decisions"),
    startluxThinkMode: normaliseThinkMode(raw?.startluxThinkMode),
    startluxKeyFile: str(raw?.startluxKeyFile),
    maxConcurrency: clampInt(raw?.maxConcurrency, 8, 1, 12),
    requestTokenBudget: clampInt(raw?.requestTokenBudget, 24e3, 1e3, 6e4),
    unitTokenBudget: clampInt(raw?.unitTokenBudget, 2e4, 500, 24e3),
    cacheCapacity: clampInt(raw?.cacheCapacity, 500, 1, 1e5),
    requestTimeoutMs: clampInt(raw?.requestTimeoutMs, 3e4, 1e3, 12e4),
    highlightThresholds: thresholds,
    autoStart: raw?.autoStart !== false,
    requireApiKey: raw?.requireApiKey === true,
    debug: raw?.debug === true
  };
}
function str(value) {
  return typeof value === "string" ? value.trim() : "";
}
function clamp01(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? Math.round(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}
function normalisePath(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}
function normaliseThinkMode(value) {
  return value === "auto" || value === "always" ? value : "never";
}

// src/host/cache.ts
import { createHash } from "node:crypto";
function normaliseCacheText(text) {
  return text.replace(/\s+/gu, " ").trim();
}
function cacheKeyFor(input, model) {
  const payload = JSON.stringify({
    v: QUESTION_SET_VERSION,
    model,
    type: input.type ?? "",
    text: normaliseCacheText(input.text),
    heading: normaliseCacheText(input.context?.heading ?? ""),
    before: normaliseCacheText(input.context?.before ?? ""),
    question: normaliseCacheText(input.context?.question ?? "")
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
function cacheKeyForUnit(unit, model) {
  return cacheKeyFor(unit, model);
}
var LruVerdictCache = class {
  capacity;
  entries = /* @__PURE__ */ new Map();
  hits = 0;
  misses = 0;
  constructor(options = {}) {
    const capacity = Math.floor(options.capacity ?? 500);
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 500;
  }
  /** Look up a verdict; a miss is recorded whenever the key is absent. */
  get(key) {
    const value = this.entries.get(key);
    if (value === void 0) {
      this.misses += 1;
      return void 0;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
  get size() {
    return this.entries.size;
  }
  stats() {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
  clear() {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
};

// src/host/errors.ts
var JevAbortError = class extends Error {
  code = "JEV_ABORTED";
  constructor(message = "Jev request was aborted") {
    super(message);
    this.name = "JevAbortError";
  }
};
var JevTimeoutError = class extends Error {
  code = "JEV_TIMEOUT";
  constructor(message = "Jev request timed out") {
    super(message);
    this.name = "JevTimeoutError";
  }
};
var JevHttpError = class extends Error {
  code = "JEV_HTTP";
  status;
  constructor(status, message) {
    super(message);
    this.name = "JevHttpError";
    this.status = status;
  }
};
var JevBudgetError = class extends Error {
  code = "JEV_BUDGET";
  constructor(message) {
    super(message);
    this.name = "JevBudgetError";
  }
};
var JevParseError = class extends Error {
  code = "JEV_PARSE";
  constructor(message) {
    super(message);
    this.name = "JevParseError";
  }
};
function isAbortLike(error) {
  if (error === null || error === void 0) return false;
  if (typeof error === "object") {
    const candidate = error;
    if (candidate.name === "AbortError" || candidate.name === "JevAbortError") return true;
    if (candidate.code === "JEV_ABORTED" || candidate.code === "ABORT_ERR") return true;
    if (typeof candidate.message === "string" && /aborted|aborterror/iu.test(candidate.message) && /abort/iu.test(candidate.message)) {
      return true;
    }
  }
  return false;
}
function describeError(error, limit = 400) {
  let message;
  if (error instanceof Error) {
    message = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  } else {
    try {
      message = typeof error === "string" ? error : JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }
  return message.length > limit ? `${message.slice(0, limit)}\u2026` : message;
}

// src/host/credentials.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var MissingJevApiKeyError = class extends Error {
  code = "JEV_API_KEY_MISSING";
  credentialsPath;
  constructor(credentialsPath, detail) {
    super(missingKeyMessage(credentialsPath, detail));
    this.name = "MissingJevApiKeyError";
    this.credentialsPath = credentialsPath;
  }
};
function missingKeyMessage(credentialsPath, detail) {
  const lines = [
    "No Jev API key is configured: the jev-highlight plugin cannot judge content without it.",
    "",
    "Provide the key in one of these places, then retry by restarting the DSH web profile (or toggling the plugin off and on):",
    `  1. $DSH_HOME/.credentials.yaml \u2014 add a top-level scalar line: jevApiKey: "<your key>" (resolved path: ${credentialsPath})`,
    "  2. environment variable JEV_API_KEY (or TYPESAFE_API_KEY) in the environment that starts dsh",
    "  3. the plugin config field `jevApiKey` (debug patches only; prefer the options above)",
    "",
    "The key is never logged, never returned over HTTP and never sent to the browser."
  ];
  if (typeof detail === "string" && detail !== "") lines.push("", `Hint: ${detail}`);
  return lines.join("\n");
}
function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
}
function credentialsFilePath(dshHome) {
  return join(dshHome !== void 0 && dshHome !== "" ? dshHome : resolveDshHome(), ".credentials.yaml");
}
function unquoteScalar(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
    }
    return raw.slice(1, -1);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/gu, "'");
  }
  return raw;
}
function parseCredentialsYaml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/u.test(line)) continue;
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (match === null) continue;
    const key = match[1];
    const rest = match[2];
    if (key === void 0 || rest === void 0) continue;
    let value = rest.trim();
    if (value === "" || value.startsWith("#")) continue;
    if (!value.startsWith('"') && !value.startsWith("'")) {
      value = value.replace(/[ \t]+#.*$/u, "").trim();
    }
    value = unquoteScalar(value);
    if (value === "") continue;
    result[key] = value;
  }
  return result;
}
function readCredentialsKey(credentialsPath) {
  let text;
  try {
    text = readFileSync(credentialsPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null ? error.code : void 0;
    if (code === "ENOENT") return {};
    return { error: `could not read ${credentialsPath}` };
  }
  const parsed = parseCredentialsYaml(text);
  const key = parsed.jevApiKey;
  return typeof key === "string" && key !== "" ? { key } : {};
}
function resolveJevApiKey(options = {}) {
  const env = options.env ?? process.env;
  const credentialsPath = options.credentialsPath ?? credentialsFilePath(options.dshHome);
  const configKey = typeof options.configKey === "string" ? options.configKey.trim() : "";
  if (configKey !== "") return { key: configKey, source: "config" };
  const jevEnv = typeof env.JEV_API_KEY === "string" ? env.JEV_API_KEY.trim() : "";
  if (jevEnv !== "") return { key: jevEnv, source: "env:JEV_API_KEY" };
  const typesafeEnv = typeof env.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY.trim() : "";
  if (typesafeEnv !== "") return { key: typesafeEnv, source: "env:TYPESAFE_API_KEY" };
  const fromFile = readCredentialsKey(credentialsPath);
  if (fromFile.key !== void 0) return { key: fromFile.key, source: "file:$DSH_HOME/.credentials.yaml" };
  throw new MissingJevApiKeyError(credentialsPath, fromFile.error);
}
var MissingStartLuxApiKeyError = class extends Error {
  code = "STARTLUX_API_KEY_MISSING";
  keyFile;
  constructor(keyFile, detail) {
    super(startluxMissingMessage(keyFile, detail));
    this.name = "MissingStartLuxApiKeyError";
    this.keyFile = keyFile;
  }
};
function startluxMissingMessage(keyFile, detail) {
  const lines = [
    "No StartLux API key is configured: the jev-highlight plugin cannot judge content without it.",
    "",
    "Provide the key in one of these places (the Settings tab is preferred):",
    "  1. DSH Settings \u2192 \u63D2\u4EF6 \u2192 Jev \u9AD8\u4EAE \u2192 API Key \u2192 \u4FDD\u5B58\uFF08write-only\uFF0C\u843D\u5230\u4E0B\u9762\u7684 key \u6587\u4EF6\uFF09",
    `  2. key file: ${keyFile}`,
    "  3. environment variables STARTLUX_API_KEY or BAMBOO_API_KEY in the environment that starts dsh",
    '  4. $DSH_HOME/.credentials.yaml \u2014 top-level scalar line: startluxApiKey: "<your key>"',
    "",
    "The key is never logged, never returned over HTTP and never sent to the browser."
  ];
  if (typeof detail === "string" && detail !== "") lines.push("", `Hint: ${detail}`);
  return lines.join("\n");
}
function startluxKeyFilePath(options = {}) {
  const override = typeof options.keyFile === "string" ? options.keyFile.trim() : "";
  if (override !== "") return override;
  const home = typeof options.dshHome === "string" && options.dshHome.trim() !== "" ? options.dshHome.trim() : resolveDshHome(options.env);
  return join(home, "jev-highlight-startlux.key");
}
function unquoteStartLuxValue(raw) {
  return unquoteScalar(raw);
}
function readStartLuxCredentialsYaml(credentialsPath) {
  let text;
  try {
    text = readFileSync(credentialsPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null ? error.code : void 0;
    if (code === "ENOENT") return {};
    return { error: `could not read ${credentialsPath}` };
  }
  const parsed = parseCredentialsYaml(text);
  const key = parsed.startluxApiKey;
  return typeof key === "string" && key !== "" ? { key } : {};
}
function readStartLuxKeyFile(keyFile) {
  try {
    if (!existsSync(keyFile)) return "";
    const text = readFileSync(keyFile, "utf8");
    const firstLine = text.split(/\r?\n/u)[0] ?? "";
    return unquoteStartLuxValue(firstLine.trim());
  } catch {
    return "";
  }
}
var API_KEY_TOKEN = /^\S{8,512}$/u;
function saveStartLuxKey(key, keyFile) {
  const candidate = typeof key === "string" ? key.trim() : "";
  if (!API_KEY_TOKEN.test(candidate)) {
    return { ok: false, error: "API key must be 8\u2013512 printable non-whitespace characters" };
  }
  try {
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${candidate}
`, { encoding: "utf8", mode: 384 });
    try {
      chmodSync(keyFile, 384);
    } catch {
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function clearStartLuxKey(keyFile) {
  try {
    if (existsSync(keyFile)) unlinkSync(keyFile);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function resolveStartLuxApiKey(options = {}) {
  const env = options.env ?? process.env;
  const keyFile = startluxKeyFilePath(options);
  const fromFile = readStartLuxKeyFile(keyFile);
  if (fromFile !== "") return { key: fromFile, source: "settings:key-file" };
  const startluxEnv = typeof env.STARTLUX_API_KEY === "string" ? env.STARTLUX_API_KEY.trim() : "";
  if (startluxEnv !== "") return { key: startluxEnv, source: "env:STARTLUX_API_KEY" };
  const bambooEnv = typeof env.BAMBOO_API_KEY === "string" ? env.BAMBOO_API_KEY.trim() : "";
  if (bambooEnv !== "") return { key: bambooEnv, source: "env:BAMBOO_API_KEY" };
  const credentialsPath = options.credentialsPath ?? credentialsFilePath(options.dshHome);
  const fromCredentials = readStartLuxCredentialsYaml(credentialsPath);
  if (fromCredentials.key !== void 0) return { key: fromCredentials.key, source: "file:$DSH_HOME/.credentials.yaml" };
  throw new MissingStartLuxApiKeyError(keyFile, fromCredentials.error);
}

// src/host/semaphore.ts
var Semaphore = class {
  limit;
  activeCount = 0;
  maxActiveObserved = 0;
  waiters = [];
  constructor(limit) {
    const normalised = Math.floor(limit);
    if (!Number.isFinite(normalised) || normalised < 1) {
      throw new RangeError(`Semaphore limit must be a positive integer, got ${String(limit)}`);
    }
    this.limit = normalised;
  }
  /** Slots currently held. */
  get active() {
    return this.activeCount;
  }
  /** Requests waiting for a slot. */
  get waiting() {
    return this.waiters.length;
  }
  /** Highest `active` value ever observed. */
  get maxObserved() {
    return this.maxActiveObserved;
  }
  /**
   * Acquire one slot, resolving with an idempotent release function.
   * Rejects with {@link JevAbortError} when `signal` aborts before the slot is
   * granted.
   */
  acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(new JevAbortError("aborted before acquiring a concurrency slot"));
    }
    if (this.activeCount < this.limit) {
      this.activeCount += 1;
      this.observe();
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, detach: void 0 };
      if (signal !== void 0) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.detach = void 0;
          reject(new JevAbortError("aborted while waiting for a concurrency slot"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiters.push(waiter);
    });
  }
  makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }
  release() {
    this.activeCount = Math.max(0, this.activeCount - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter.detach !== void 0) waiter.detach();
      if (waiter.signal?.aborted) {
        waiter.reject(new JevAbortError("aborted while waiting for a concurrency slot"));
        continue;
      }
      this.activeCount += 1;
      this.observe();
      waiter.resolve(this.makeRelease());
      return;
    }
  }
  observe() {
    if (this.activeCount > this.maxActiveObserved) this.maxActiveObserved = this.activeCount;
  }
};

// src/host/signals.ts
function combineSignals(signals) {
  const filtered = [];
  for (const signal of signals) {
    if (signal !== void 0) filtered.push(signal);
  }
  if (filtered.length === 0) return new AbortController().signal;
  const first = filtered[0];
  if (filtered.length === 1 && first !== void 0) return first;
  const any = AbortSignal.any;
  if (typeof any === "function") return any.call(AbortSignal, filtered);
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
  };
  for (const signal of filtered) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}
function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    return { signal: controller.signal, clear: () => {
    } };
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const unref = timer.unref;
  if (typeof unref === "function") unref.call(timer);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    }
  };
}
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  return new Promise((resolve, reject) => {
    let timer;
    function cleanup() {
      if (timer !== void 0) {
        clearTimeout(timer);
        timer = void 0;
      }
      if (signal !== void 0) signal.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const unref = timer.unref;
    if (typeof unref === "function") unref.call(timer);
    if (signal !== void 0) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/host/token-estimator.ts
var CJK_RANGES = [
  [11904, 12031],
  // CJK radicals supplement
  [12288, 12351],
  // CJK symbols and punctuation
  [12352, 12543],
  // hiragana + katakana
  [12592, 12687],
  // hangul compatibility jamo
  [13312, 19903],
  // CJK extension A
  [19968, 40959],
  // CJK unified ideographs
  [43360, 43391],
  // hangul jamo extended-A
  [44032, 55215],
  // hangul syllables
  [63744, 64255],
  // CJK compatibility ideographs
  [65280, 65519],
  // half-width / full-width forms
  [127488, 127743],
  // enclosed ideographic supplement
  [131072, 195103]
  // CJK extensions B..F
];
var ESTIMATE_SAFETY_FACTOR = 1.15;
var CALIBRATED_CJK_TOKENS_PER_CHAR = 1.05;
var CALIBRATED_ASCII_TOKENS_PER_CHAR = 0.35;
var CALIBRATED_REQUEST_OVERHEAD = 320;
var CJK_TOKENS_PER_CHAR = CALIBRATED_CJK_TOKENS_PER_CHAR * ESTIMATE_SAFETY_FACTOR;
var ASCII_TOKENS_PER_CHAR = CALIBRATED_ASCII_TOKENS_PER_CHAR * ESTIMATE_SAFETY_FACTOR;
var FIXED_REQUEST_OVERHEAD_TOKENS = Math.ceil(CALIBRATED_REQUEST_OVERHEAD * ESTIMATE_SAFETY_FACTOR);
var HARD_STATE_QUESTION_LIMIT = 32e3;
var HARD_TOTAL_LIMIT = 64e3;
function isCjk(codePoint) {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}
function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isCjk(codePoint)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * ASCII_TOKENS_PER_CHAR);
}
function estimateJsonTokens(value) {
  let text;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  return estimateTokens(text);
}
function estimateRequestTokens(state, questionTexts, fixedOverheadTokens = FIXED_REQUEST_OVERHEAD_TOKENS) {
  const stateTokens = estimateTokens(state);
  let longestQuestionTokens = 0;
  for (const question of questionTexts) {
    const tokens = estimateTokens(question);
    if (tokens > longestQuestionTokens) longestQuestionTokens = tokens;
  }
  return stateTokens + longestQuestionTokens + fixedOverheadTokens;
}
function checkRequestBudget(state, questionTexts, requestTokenBudget, fixedOverheadTokens = FIXED_REQUEST_OVERHEAD_TOKENS) {
  const stateTokens = estimateTokens(state);
  let longestQuestionTokens = 0;
  for (const question of questionTexts) {
    const tokens = estimateTokens(question);
    if (tokens > longestQuestionTokens) longestQuestionTokens = tokens;
  }
  const estimatedTokens = stateTokens + longestQuestionTokens + fixedOverheadTokens;
  return {
    estimatedTokens,
    stateTokens,
    longestQuestionTokens,
    requestTokenBudget,
    withinRequestBudget: estimatedTokens <= requestTokenBudget,
    withinHardStateQuestionLimit: stateTokens + longestQuestionTokens <= HARD_STATE_QUESTION_LIMIT,
    withinHardTotalLimit: estimatedTokens <= HARD_TOTAL_LIMIT
  };
}
function assertRequestBudget(state, questionTexts, requestTokenBudget, fixedOverheadTokens = FIXED_REQUEST_OVERHEAD_TOKENS) {
  const check = checkRequestBudget(state, questionTexts, requestTokenBudget, fixedOverheadTokens);
  if (!check.withinHardTotalLimit) {
    throw new JevBudgetError(
      `Jev request estimate ${check.estimatedTokens} exceeds the hard total limit ${HARD_TOTAL_LIMIT} tokens`
    );
  }
  if (!check.withinHardStateQuestionLimit) {
    throw new JevBudgetError(
      `Jev request state ${check.stateTokens} + longest question ${check.longestQuestionTokens} tokens exceeds the hard limit ${HARD_STATE_QUESTION_LIMIT} tokens`
    );
  }
  if (!check.withinRequestBudget) {
    throw new JevBudgetError(
      `Jev request estimate ${check.estimatedTokens} exceeds requestTokenBudget ${requestTokenBudget} tokens`
    );
  }
  return check.estimatedTokens;
}
function hardSplitByTokenBudget(line, tokenBudget) {
  const budget = Math.max(1, tokenBudget);
  const pieces = [];
  let start = 0;
  let cost = 0;
  let index = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0) ?? 0;
    const weight = isCjk(codePoint) ? CJK_TOKENS_PER_CHAR : ASCII_TOKENS_PER_CHAR;
    if (cost + weight > budget && index > start) {
      pieces.push(line.slice(start, index));
      start = index;
      cost = 0;
    }
    cost += weight;
    index += character.length;
  }
  if (index > start) pieces.push(line.slice(start, index));
  return pieces.filter((piece) => piece.length > 0);
}
var SENTENCE_BOUNDARY = /(?<=[。！？；.!?;])/u;
function splitLineIntoSentences(line) {
  return line.split(SENTENCE_BOUNDARY).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}
function splitTextToTokenBudget(text, tokenBudget) {
  const budget = Math.max(1, Math.floor(tokenBudget));
  const chunks = [];
  const pushChunk = (lines) => {
    const chunk = lines.join("\n").trim();
    if (chunk !== "") chunks.push(chunk);
  };
  for (const line of text.split("\n")) {
    const lineTokens = estimateTokens(line);
    if (lineTokens <= budget) {
      const tail = chunks.length > 0 ? chunks[chunks.length - 1] ?? "" : "";
      if (tail !== "" && estimateTokens(`${tail}
${line}`) <= budget) {
        chunks[chunks.length - 1] = `${tail}
${line}`.trim();
      } else if (line.trim() !== "") {
        chunks.push(line.trim());
      }
      continue;
    }
    const sentences = splitLineIntoSentences(line);
    if (sentences.length <= 1) {
      chunks.push(...hardSplitByTokenBudget(line, budget));
      continue;
    }
    let current = [];
    for (const sentence of sentences) {
      const candidate = current.length === 0 ? sentence : `${current.join(" ")} ${sentence}`;
      if (estimateTokens(candidate) <= budget) {
        current.push(sentence);
        continue;
      }
      if (current.length > 0) {
        pushChunk(current);
        current = [];
      }
      if (estimateTokens(sentence) <= budget) current.push(sentence);
      else chunks.push(...hardSplitByTokenBudget(sentence, budget));
    }
    if (current.length > 0) pushChunk(current);
  }
  return chunks;
}

// src/host/jev-client.ts
var NOUL_QUESTIONS = [
  {
    id: "is_core_answer",
    // `[question]` is part of the state (the user request of this turn); the
    // instruction names it so Jev knows what "the user's question" refers to.
    instructions: "Is this passage the core answer that directly resolves the user's question given in [question]?"
  },
  {
    id: "is_actionable",
    instructions: "Does this passage contain a concrete action, command, or step the reader can execute?"
  },
  {
    id: "is_warning",
    instructions: "Does this passage warn about a risk, caveat, failure mode, or limitation?"
  },
  {
    id: "is_definition",
    instructions: "Does this passage define or explain the meaning of a term, concept, or field?"
  }
];
function buildJevQuestions(questions = NOUL_QUESTIONS) {
  const payload = {};
  for (const question of questions) {
    payload[question.id] = { type: "noul", instructions: question.instructions };
  }
  return payload;
}
function buildStateText(source, text = source.text) {
  const parts = [];
  const heading = source.context?.heading;
  const before = source.context?.before;
  const question = source.context?.question;
  if (typeof heading === "string" && heading !== "") parts.push(`[section] ${heading}`);
  if (typeof before === "string" && before !== "") parts.push(`[preceding line] ${before}`);
  if (typeof question === "string" && question !== "") parts.push(`[question] ${question}`);
  parts.push("[passage]");
  parts.push(text);
  return parts.join("\n");
}
var PROBABILITY_KEYS = [
  "noul",
  "probability",
  "p_yes",
  "pYes",
  "p(yes)",
  "pyes",
  "yes",
  "prob",
  "confidence",
  "score",
  "mean",
  "value"
];
var ENVELOPE_KEYS = ["answer", "result", "response"];
function clamp012(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
function extractProbability(value, depth = 0) {
  if (typeof value === "number") return clamp012(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return clamp012(parsed);
  }
  if (value === null || typeof value !== "object" || depth > 3) return void 0;
  const record = value;
  for (const key of PROBABILITY_KEYS) {
    if (key in record) {
      const found = extractProbability(record[key], depth + 1);
      if (found !== void 0) return found;
    }
  }
  for (const key of ENVELOPE_KEYS) {
    if (key in record) {
      const found = extractProbability(record[key], depth + 1);
      if (found !== void 0) return found;
    }
  }
  return void 0;
}
function collectAnswerEntries(container) {
  const entries = /* @__PURE__ */ new Map();
  const visit = (node, depth) => {
    if (node === null || typeof node !== "object" || depth > 2) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item === null || typeof item !== "object") continue;
        const record2 = item;
        const id = typeof record2.id === "string" ? record2.id : typeof record2.key === "string" ? record2.key : typeof record2.name === "string" ? record2.name : "";
        if (id !== "") entries.set(id, record2);
        else visit(record2, depth + 1);
      }
      return;
    }
    const record = node;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "number") {
        entries.set(key, value);
        continue;
      }
      if (value === null || typeof value !== "object") continue;
      if (!entries.has(key)) entries.set(key, value);
      visit(value, depth + 1);
    }
  };
  visit(container, 0);
  return entries;
}
function findEntry(entries, id) {
  if (entries.has(id)) return entries.get(id);
  const lower = id.toLowerCase();
  for (const [key, value] of entries) {
    if (key.toLowerCase() === lower) return value;
  }
  return void 0;
}
function parseSystemOneScoresDetailed(payload, questions = NOUL_QUESTIONS) {
  const response = payload ?? {};
  const candidates = [response.answers, response.results, response.scores, response.noul, response];
  let entries = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    if (candidate === void 0 || candidate === null) continue;
    const found = collectAnswerEntries(candidate);
    if (found.size > 0) {
      entries = found;
      break;
    }
  }
  const scores = {};
  const missing = [];
  for (const question of questions) {
    const entry = findEntry(entries, question.id);
    if (entry === void 0) {
      scores[question.id] = 0;
      missing.push(question.id);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const type = entry.type;
      if (typeof type === "string" && type !== "noul") {
        scores[question.id] = 0;
        missing.push(question.id);
        continue;
      }
    }
    const probability = extractProbability(entry);
    if (probability === void 0) {
      scores[question.id] = 0;
      missing.push(question.id);
      continue;
    }
    scores[question.id] = probability;
  }
  return { scores, missing, complete: missing.length === 0 };
}
function parseSystemOneScores(payload, questions = NOUL_QUESTIONS) {
  return parseSystemOneScoresDetailed(payload, questions).scores;
}
function combineScoresMax(scoreList, questions = NOUL_QUESTIONS) {
  const combined = {};
  for (const question of questions) combined[question.id] = 0;
  for (const scores of scoreList) {
    const record = scores;
    for (const question of questions) {
      const value = typeof record[question.id] === "number" ? record[question.id] : 0;
      const previous = combined[question.id] ?? 0;
      if (value > previous) combined[question.id] = value;
    }
  }
  return combined;
}
var MAX_SUB_CHUNKS = 64;
var MIN_CONTENT_TOKENS = 24;
var CONTEXT_SAFETY_TOKENS = 8;
function planUnitRequests(unit, options) {
  const questions = options.questions ?? NOUL_QUESTIONS;
  const questionTexts = questions.map((question) => question.instructions);
  const requestTokenBudget = Math.max(1, Math.floor(options.requestTokenBudget));
  const unitTokenBudget = Math.max(1, Math.floor(options.unitTokenBudget));
  const maxSubChunks = Math.max(1, Math.floor(options.maxSubChunks ?? MAX_SUB_CHUNKS));
  const fullState = buildStateText(unit);
  const fullCheck = checkRequestBudget(fullState, questionTexts, requestTokenBudget);
  const unitTokens = estimateTokens(unit.text);
  const fullFits = fullCheck.withinRequestBudget && fullCheck.withinHardStateQuestionLimit && fullCheck.withinHardTotalLimit && unitTokens <= unitTokenBudget;
  if (fullFits) {
    return [{ text: unit.text, state: fullState, estimatedTokens: fullCheck.estimatedTokens }];
  }
  const longestQuestionTokens = fullCheck.longestQuestionTokens;
  const questionOverhead = longestQuestionTokens + FIXED_REQUEST_OVERHEAD_TOKENS;
  let context = {};
  if (typeof unit.context?.heading === "string" || typeof unit.context?.before === "string") {
    context = { ...unit.context };
  }
  const contextTokensFor = (candidate) => estimateTokens(buildStateText({ text: "", context: candidate }));
  const maxStateTokens = () => Math.min(
    requestTokenBudget - questionOverhead,
    HARD_STATE_QUESTION_LIMIT - longestQuestionTokens,
    HARD_TOTAL_LIMIT - questionOverhead
  );
  if (maxStateTokens() - contextTokensFor(context) - CONTEXT_SAFETY_TOKENS < MIN_CONTENT_TOKENS) {
    if (context.before !== void 0) {
      const { before: _droppedBefore, ...rest } = context;
      context = rest;
    }
    if (maxStateTokens() - contextTokensFor(context) - CONTEXT_SAFETY_TOKENS < MIN_CONTENT_TOKENS) {
      context = {};
    }
  }
  const contentBudget = Math.max(
    MIN_CONTENT_TOKENS,
    Math.floor(Math.min(unitTokenBudget, maxStateTokens() - contextTokensFor(context) - CONTEXT_SAFETY_TOKENS))
  );
  const plans = [];
  const source = { text: unit.text, context };
  const addPlan = (chunkText, depth) => {
    const state = buildStateText(source, chunkText);
    const check = checkRequestBudget(state, questionTexts, requestTokenBudget);
    if (check.withinRequestBudget && check.withinHardStateQuestionLimit && check.withinHardTotalLimit) {
      plans.push({ text: chunkText, state, estimatedTokens: check.estimatedTokens });
      return;
    }
    if (depth >= 8 || chunkText.length <= 1) {
      throw new JevBudgetError(
        `cannot fit a Jev request: estimate ${check.estimatedTokens} tokens, budget ${requestTokenBudget} tokens`
      );
    }
    const halfBudget = Math.max(1, Math.floor(estimateTokens(chunkText) / 2));
    const pieces = splitTextToTokenBudget(chunkText, halfBudget);
    if (pieces.length <= 1) {
      throw new JevBudgetError(
        `cannot split a Jev request below budget ${requestTokenBudget} tokens (estimate ${check.estimatedTokens})`
      );
    }
    for (const piece of pieces) addPlan(piece, depth + 1);
  };
  const chunks = splitTextToTokenBudget(unit.text, contentBudget);
  const initialChunks = chunks.length > 0 ? chunks : [unit.text];
  if (initialChunks.length > maxSubChunks) {
    throw new JevBudgetError(
      `unit requires ${initialChunks.length} sub-chunks (limit ${maxSubChunks}); raise unitTokenBudget or split the message`
    );
  }
  for (const chunk of initialChunks) addPlan(chunk, 0);
  return plans;
}
var DEFAULT_MODEL = "jev-1.13.0";
var DEFAULT_BASE_URL = "https://api.typesafe.ai";
function normaliseBaseUrl(baseUrl) {
  const value = typeof baseUrl === "string" ? baseUrl.trim() : "";
  const resolved = value === "" ? DEFAULT_BASE_URL : value;
  return resolved.replace(/\/+$/u, "");
}
function normaliseEndpointPath(path, fallback) {
  const value = typeof path === "string" ? path.trim() : "";
  if (value === "") return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}
function readRetryAfterMs(response) {
  const headers = response.headers;
  if (headers === void 0) return void 0;
  let raw;
  const withGet = headers;
  if (typeof withGet.get === "function") {
    raw = withGet.get.call(headers, "retry-after");
  } else {
    const record = headers;
    raw = record["retry-after"] ?? record["Retry-After"];
  }
  if (typeof raw !== "string" || raw.trim() === "") return void 0;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1e3);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return void 0;
}
function defaultFetch(url, init) {
  return fetch(url, init);
}
async function readErrorDetail(response) {
  try {
    const text = await response.text();
    if (typeof text !== "string" || text.trim() === "") return "";
    let detail = text.trim();
    try {
      const parsed = JSON.parse(detail);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed;
        const candidate = typeof record.title === "string" ? record.title : typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : "";
        if (candidate !== "") detail = candidate;
      }
    } catch {
    }
    return detail.length > 160 ? `${detail.slice(0, 160)}\u2026` : detail;
  } catch {
    return "";
  }
}
var JevClient = class {
  model;
  provider;
  apiKey;
  baseUrl;
  endpointPath;
  thinkMode;
  fetchImpl;
  timeoutMs;
  requestTokenBudget;
  unitTokenBudget;
  cache;
  semaphore;
  retryBaseMs;
  maxRetries;
  log;
  requests = 0;
  inFlight = 0;
  maxConcurrentObserved = 0;
  maxRequestTokensObserved = 0;
  abortedRequests = 0;
  failures = 0;
  constructor(options) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new Error("JevClient requires a non-empty API key");
    }
    this.apiKey = options.apiKey;
    this.provider = options.provider === "startlux" ? "startlux" : "jev";
    this.baseUrl = normaliseBaseUrl(options.baseUrl);
    this.endpointPath = normaliseEndpointPath(options.endpointPath, this.provider === "startlux" ? "/decisions" : "/v1/systemone");
    this.thinkMode = this.provider === "startlux" ? options.thinkMode : void 0;
    this.model = typeof options.model === "string" && options.model.trim() !== "" ? options.model.trim() : DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 3e4));
    this.requestTokenBudget = Math.max(1, Math.floor(options.requestTokenBudget ?? 24e3));
    this.unitTokenBudget = Math.max(1, Math.floor(options.unitTokenBudget ?? 2e4));
    this.cache = options.cache ?? new LruVerdictCache({ capacity: 500 });
    this.semaphore = new Semaphore(Math.max(1, Math.floor(options.maxConcurrency ?? 8)));
    this.retryBaseMs = Math.max(0, Math.floor(options.retryBaseMs ?? 500));
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.log = options.log ?? (() => {
    });
  }
  get endpoint() {
    return `${this.baseUrl}${this.endpointPath}`;
  }
  /** Swap the key at runtime when the Settings tab saves/clears one. */
  setApiKey(apiKey) {
    this.apiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  }
  /** Switch StartLux think_mode at runtime (Settings tab). */
  setThinkMode(mode) {
    if (this.provider === "startlux") this.thinkMode = mode;
  }
  /** True when a key is currently configured on this client. */
  hasApiKey() {
    return this.apiKey !== "";
  }
  /** Live counters for diagnostics. */
  stats() {
    const cacheStats = this.cache.stats();
    return {
      requests: this.requests,
      inFlight: this.inFlight,
      maxConcurrentObserved: this.maxConcurrentObserved,
      maxRequestTokensObserved: this.maxRequestTokensObserved,
      abortedRequests: this.abortedRequests,
      failures: this.failures,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      cacheSize: cacheStats.size
    };
  }
  /** One budget-checked systemOne call. */
  async systemOne(input) {
    const questions = input.questions ?? buildJevQuestions();
    const questionTexts = Object.values(questions).map((question) => question.instructions);
    const estimatedTokens = estimateRequestTokens(input.state, questionTexts);
    this.observeRequestTokens(estimatedTokens);
    assertRequestBudget(input.state, questionTexts, this.requestTokenBudget);
    const body = JSON.stringify({
      model: this.model,
      state: input.state,
      questions,
      ...this.provider === "startlux" && this.thinkMode !== void 0 ? { think_mode: this.thinkMode } : {}
    });
    return await this.request(body, input.signal);
  }
  /**
   * Judge one content unit. Returns combined per-question scores; identical
   * content served from the LRU cache performs no network request.
   *
   * `stats().failures` counts failed *judgements* (after retries), not failed
   * HTTP attempts; aborted judgements are not failures.
   */
  async judgeUnit(unit, options = {}) {
    try {
      return await this.judgeUnitInternal(unit, options);
    } catch (error) {
      if (!isAbortLike(error)) this.failures += 1;
      throw error;
    }
  }
  async judgeUnitInternal(unit, options) {
    const cacheKey = cacheKeyForUnit(unit, this.model);
    const cachedScores = this.cache.get(cacheKey);
    if (cachedScores !== void 0) {
      return { scores: cachedScores, cached: true, priority: combinePriority(cachedScores), requestCount: 0 };
    }
    const plans = planUnitRequests(unit, {
      requestTokenBudget: this.requestTokenBudget,
      unitTokenBudget: this.unitTokenBudget,
      questions: NOUL_QUESTIONS
    });
    const ask = async () => Promise.all(
      plans.map(async (plan) => {
        const response = await this.systemOne({ state: plan.state, signal: options.signal });
        const parsed = parseSystemOneScoresDetailed(response);
        if (!parsed.complete) {
          throw new JevParseError(`Jev response is missing noul answers for: ${parsed.missing.join(", ")}`);
        }
        return parsed.scores;
      })
    );
    let responses;
    try {
      responses = await ask();
    } catch (error) {
      if (!(error instanceof JevParseError) || options.signal?.aborted === true) throw error;
      this.log("[jev-highlight] Jev response violated the noul contract; retrying once");
      responses = await ask();
    }
    const scores = combineScoresMax(responses);
    this.cache.set(cacheKey, scores);
    return { scores, cached: false, priority: combinePriority(scores), requestCount: plans.length };
  }
  async request(body, signal) {
    let attempt = 0;
    for (; ; ) {
      this.throwIfAborted(signal);
      const release = await this.acquireSlot(signal);
      const timeout = createTimeoutSignal(this.timeoutMs);
      try {
        const requestSignal = combineSignals([signal, timeout.signal]);
        this.requests += 1;
        this.beginInFlight();
        let response;
        try {
          response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
              accept: "application/json"
            },
            body,
            signal: requestSignal
          });
        } catch (error) {
          if (signal?.aborted) {
            this.abortedRequests += 1;
            throw new JevAbortError("Jev request aborted");
          }
          if (timeout.signal.aborted) {
            throw new JevTimeoutError(`Jev request timed out after ${this.timeoutMs}ms`);
          }
          if (isAbortLike(error)) {
            this.abortedRequests += 1;
            throw new JevAbortError("Jev request aborted");
          }
          if (attempt < this.maxRetries) {
            await this.backoff(attempt, void 0, signal);
            attempt += 1;
            continue;
          }
          throw error;
        } finally {
          this.endInFlight();
          timeout.clear();
        }
        if (!response.ok) {
          const status = Math.floor(response.status);
          const retryable = status === 429 || status >= 500;
          if (retryable && attempt < this.maxRetries) {
            await this.backoff(attempt, readRetryAfterMs(response), signal);
            attempt += 1;
            continue;
          }
          const detail = await readErrorDetail(response);
          const hint = status === 401 ? " \u2014 check the configured API key (Settings \u2192 \u63D2\u4EF6 \u2192 Jev \u9AD8\u4EAE for StartLux, STARTLUX_API_KEY / BAMBOO_API_KEY, or JEV_API_KEY / TYPESAFE_API_KEY for Jev)" : status === 451 ? " \u2014 the upstream API is not available from this network region; use the StartLux provider or a supported region" : "";
          throw new JevHttpError(
            status,
            `Jev API responded with HTTP ${status}${typeof response.statusText === "string" && response.statusText !== "" ? ` ${response.statusText}` : ""}${detail !== "" ? `: ${detail}` : ""}${retryable ? " (retries exhausted)" : ""}${hint}`
          );
        }
        return await this.readJson(response);
      } finally {
        release();
      }
    }
  }
  async readJson(response) {
    const text = await response.text();
    if (typeof text !== "string" || text.trim() === "") return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") return parsed;
      throw new JevParseError("Jev API returned a non-object JSON document");
    } catch (error) {
      if (error instanceof JevParseError) throw error;
      throw new JevParseError(`Jev API returned a non-JSON body (${text.length} characters)`);
    }
  }
  throwIfAborted(signal) {
    if (signal?.aborted) {
      this.abortedRequests += 1;
      throw new JevAbortError("Jev request aborted before it started");
    }
  }
  async acquireSlot(signal) {
    try {
      return await this.semaphore.acquire(signal);
    } catch (error) {
      if (isAbortLike(error)) this.abortedRequests += 1;
      throw error;
    }
  }
  async backoff(attempt, retryAfterMs, signal) {
    const exponential = this.retryBaseMs * 2 ** attempt;
    const base = retryAfterMs ?? exponential;
    const capped = Math.min(5e3, Math.max(0, base));
    const jitter = capped > 0 ? Math.floor(Math.random() * Math.min(50, Math.floor(capped / 4) + 1)) : 0;
    this.log(`[jev-highlight] retrying Jev request after ${capped + jitter}ms (attempt ${attempt + 1})`);
    await sleep(capped + jitter, signal);
  }
  beginInFlight() {
    this.inFlight += 1;
    if (this.inFlight > this.maxConcurrentObserved) this.maxConcurrentObserved = this.inFlight;
  }
  endInFlight() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
  observeRequestTokens(tokens) {
    if (tokens > this.maxRequestTokensObserved) this.maxRequestTokensObserved = tokens;
  }
};

// src/host/splitter.ts
var DEFAULT_BEFORE_LIMIT = 240;
var FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
var FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
var HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u;
var LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/u;
var TABLE_ROW = /^[ \t]*\|/u;
var HORIZONTAL_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
var TABLE_SEPARATOR_CELL = /^:?-+:?$/u;
function stripClosingHashes(text) {
  const stripped = text.replace(/[ \t]+#+[ \t]*$/u, "");
  return stripped.trim();
}
function isTableSeparator(line) {
  const text = line.trim();
  if (!text.includes("-")) return false;
  const stripped = text.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = stripped.split("|").map((cell) => cell.trim());
  if (cells.length === 0) return false;
  return cells.every((cell) => cell !== "" && TABLE_SEPARATOR_CELL.test(cell));
}
function tableRowCells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && text[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}
function lastLine(text) {
  const lines = text.split("\n");
  return (lines[lines.length - 1] ?? "").trim();
}
function truncateBefore(before, limit) {
  if (!(limit > 0) || before.length <= limit) return before;
  return before.slice(before.length - limit).trim();
}
var StreamingSplitter = class {
  sessionId;
  attemptId;
  blockIndex;
  beforeLimit;
  dedupeLimit;
  initialHeading;
  initialBefore;
  initialQuestion;
  buffer = "";
  headingText;
  beforeText;
  questionText;
  paragraphLines = [];
  listItem = null;
  fence = null;
  ordinal;
  seenTexts = /* @__PURE__ */ new Set();
  constructor(options) {
    this.sessionId = options.sessionId;
    this.attemptId = options.attemptId;
    this.blockIndex = options.blockIndex;
    this.beforeLimit = options.beforeLimit ?? DEFAULT_BEFORE_LIMIT;
    this.dedupeLimit = options.dedupeLimit ?? 256;
    this.initialHeading = options.initialHeading;
    this.initialBefore = options.initialBefore;
    this.initialQuestion = options.initialQuestion;
    this.headingText = options.initialHeading;
    this.beforeText = options.initialBefore;
    this.questionText = options.initialQuestion;
    this.ordinal = options.startOrdinal ?? 0;
  }
  /** Nearest heading observed so far (block-scoped; the pipeline persists it). */
  get heading() {
    return this.headingText;
  }
  /** Last line of the last emitted unit (grounding for the next unit). */
  get before() {
    return this.beforeText;
  }
  /** Heading the splitter was seeded with, needed when a block is reprocessed. */
  get seededHeading() {
    return this.initialHeading;
  }
  get seededBefore() {
    return this.initialBefore;
  }
  /** User request the splitter was seeded with (block-end reprocessing). */
  get seededQuestion() {
    return this.initialQuestion;
  }
  /** Next ordinal; feed it as `startOrdinal` to avoid duplicate ids on reprocess. */
  get nextOrdinal() {
    return this.ordinal;
  }
  /** Characters buffered because no line terminator arrived yet. */
  get bufferedCharacters() {
    return this.buffer.length;
  }
  /** Feed one streaming delta; returns the units that became complete. */
  push(text) {
    if (typeof text !== "string" || text === "") return [];
    this.buffer += text;
    if (this.buffer.indexOf("\n") === -1) return [];
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const units = [];
    for (const line of lines) {
      const emitted = this.consumeLine(line);
      if (emitted.length > 0) units.push(...emitted);
    }
    return units;
  }
  /** Close every pending construct (block-end / stream-end). */
  flush() {
    const units = [];
    if (this.buffer !== "") {
      const pending = this.buffer;
      this.buffer = "";
      const emitted = this.consumeLine(pending);
      if (emitted.length > 0) units.push(...emitted);
    }
    if (this.fence !== null) {
      const text = this.fence.lines.join("\n").replace(/\n+$/u, "");
      this.fence = null;
      const unit = this.emitUnit("code_block", text, { skipTrim: true });
      if (unit !== null) units.push(unit);
    }
    for (const unit of this.flushCurrent()) units.push(unit);
    return units;
  }
  consumeLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (this.fence !== null) {
      if (this.isFenceClose(line)) {
        const text = this.fence.lines.join("\n").replace(/\n+$/u, "");
        this.fence = null;
        const unit = this.emitUnit("code_block", text, { skipTrim: true });
        return unit === null ? [] : [unit];
      }
      this.fence.lines.push(line);
      return [];
    }
    if (line.trim() === "") return this.flushCurrent();
    const fenceMatch = FENCE_OPEN.exec(line);
    if (fenceMatch !== null) {
      const units = this.flushCurrent();
      const marker = fenceMatch[1] ?? "```";
      this.fence = { char: marker.charAt(0) === "~" ? "~" : "`", length: marker.length, lines: [] };
      return units;
    }
    const headingMatch = HEADING.exec(line);
    if (headingMatch !== null) {
      const units = this.flushCurrent();
      this.headingText = stripClosingHashes(headingMatch[2] ?? "");
      if (this.headingText === "") this.headingText = void 0;
      return units;
    }
    if (HORIZONTAL_RULE.test(line)) return this.flushCurrent();
    if (TABLE_ROW.test(line)) {
      const units = this.flushCurrent();
      if (isTableSeparator(line)) return units;
      const cells = tableRowCells(line);
      const text = cells.join(" | ");
      const matchText = cells.join(" ");
      const unit = this.emitUnit("table_row", text, {
        matchText: matchText !== text ? matchText : void 0
      });
      if (unit !== null) units.push(unit);
      return units;
    }
    const listMatch = LIST_ITEM.exec(line);
    if (listMatch !== null) {
      const units = this.flushCurrent();
      this.listItem = { lines: [listMatch[3] ?? ""] };
      return units;
    }
    if (this.listItem !== null) {
      this.listItem.lines.push(line.trimEnd());
      return [];
    }
    this.paragraphLines.push(line);
    return [];
  }
  isFenceClose(line) {
    const fence = this.fence;
    if (fence === null) return false;
    const match = FENCE_CLOSE.exec(line);
    if (match === null) return false;
    const marker = match[1] ?? "";
    if (marker.charAt(0) !== fence.char) return false;
    return marker.length >= fence.length;
  }
  flushCurrent() {
    const units = [];
    if (this.listItem !== null) {
      const lines = this.listItem.lines;
      this.listItem = null;
      const first = (lines[0] ?? "").trim();
      const rest = lines.slice(1).map((line) => line.trim()).filter((line) => line !== "");
      const text = [first, ...rest].join("\n").trim();
      const unit = this.emitUnit("list_item", text);
      if (unit !== null) units.push(unit);
    }
    if (this.paragraphLines.length > 0) {
      const text = this.paragraphLines.join("\n");
      this.paragraphLines = [];
      const unit = this.emitUnit("paragraph", text);
      if (unit !== null) units.push(unit);
    }
    return units;
  }
  emitUnit(type, rawText, options = {}) {
    const text = options.skipTrim === true ? rawText : rawText.trim();
    if (text === "") return null;
    if (type !== "code_block" && !/[\p{L}\p{N}]/u.test(text)) return null;
    if (this.seenTexts.has(text)) return null;
    this.seenTexts.add(text);
    if (this.seenTexts.size > this.dedupeLimit) {
      const oldest = this.seenTexts.values().next();
      if (oldest.done !== true) this.seenTexts.delete(oldest.value);
    }
    const context = {};
    if (this.headingText !== void 0 && this.headingText !== "") context.heading = this.headingText;
    if (this.beforeText !== void 0 && this.beforeText !== "") context.before = this.beforeText;
    if (this.questionText !== void 0 && this.questionText !== "") context.question = this.questionText;
    const unit = {
      id: `${this.sessionId}:${this.attemptId}:${this.blockIndex}:${this.ordinal}`,
      sessionId: this.sessionId,
      attemptId: this.attemptId,
      blockIndex: this.blockIndex,
      type,
      text,
      context
    };
    this.ordinal += 1;
    if (options.matchText !== void 0 && options.matchText !== "") unit.matchText = options.matchText;
    this.beforeText = truncateBefore(lastLine(text), this.beforeLimit);
    return unit;
  }
};
function splitMarkdownText(text, options) {
  const splitter = new StreamingSplitter(options);
  const units = splitter.push(text);
  for (const unit of splitter.flush()) units.push(unit);
  return units;
}

// src/host/pipeline.ts
var MAX_TRACKED_SESSIONS = 500;
var MAX_QUEUED_UNITS = 512;
function scopeKey(attemptId, revision) {
  return `${attemptId}#${revision}`;
}
function captureKey(attemptId, revision, blockIndex) {
  return `${attemptId}#${revision}#${blockIndex}`;
}
function readSessionId(value) {
  if (value === null || typeof value !== "object") return void 0;
  const id = value.id;
  return typeof id === "string" && id !== "" ? id : void 0;
}
function readIndex(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return 0;
}
function readRevision(frame) {
  const value = frame.revision;
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}
function readTurn(frame) {
  const value = frame.turn;
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : void 0;
}
function readAttemptId(frame) {
  const value = frame.attemptId;
  return typeof value === "string" ? value : "";
}
function readUserMessageText(message) {
  if (message === null || typeof message !== "object") return "";
  const record = message;
  const pieces = [];
  if (typeof record.text === "string") pieces.push(record.text);
  const content = record.content;
  if (typeof content === "string") {
    pieces.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const typed = block;
      if (typed.type === "text" && typeof typed.text === "string") pieces.push(typed.text);
    }
  }
  const text = pieces.join("\n").replace(/\s+/gu, " ").trim();
  return text.length > MAX_QUESTION_CHARS ? text.slice(0, MAX_QUESTION_CHARS) : text;
}
var JudgePipeline = class {
  client;
  store;
  model;
  baseUrl;
  keySource;
  provider;
  keyConfigured;
  thresholds;
  maxConcurrency;
  requestTokenBudget;
  autoStart;
  log;
  now;
  sessions = /* @__PURE__ */ new Map();
  queue = [];
  runningTasks = /* @__PURE__ */ new Set();
  active = false;
  disposed = false;
  enabled;
  running = 0;
  unitsSeen = 0;
  unitsJudged = 0;
  droppedUnits = 0;
  failures = 0;
  lastError = null;
  constructor(options) {
    this.client = options.client;
    this.store = options.store;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.keySource = options.keySource;
    this.provider = options.provider === "startlux" ? "startlux" : "jev";
    this.keyConfigured = options.keyConfigured !== false;
    this.thresholds = { ...options.thresholds };
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
    this.requestTokenBudget = Math.max(1, Math.floor(options.requestTokenBudget));
    this.autoStart = options.autoStart !== false;
    this.log = options.log ?? (() => {
    });
    this.now = options.now ?? Date.now;
    this.enabled = this.autoStart;
  }
  /** Begin accepting stream frames. */
  start() {
    if (this.disposed) throw new Error("jev-highlight pipeline has been disposed");
    this.active = true;
  }
  get isEnabled() {
    return this.enabled && !this.disposed;
  }
  get isActive() {
    return this.active && !this.disposed;
  }
  /** Record a non-request failure (route registration, unexpected wiring). */
  noteError(message) {
    this.lastError = message.length > 400 ? `${message.slice(0, 400)}\u2026` : message;
  }
  /** Toggle judging; disabling also drops pending units and block buffers. */
  setEnabled(enabled) {
    this.enabled = enabled === true && !this.disposed;
    if (!this.enabled) {
      this.dropQueued(() => true);
      for (const session of this.sessions.values()) session.captures.clear();
    }
    return this.enabled;
  }
  /**
   * Feed one `agent/assistant-stream` event payload ({agent, frame}).
   * Never throws: frame shapes are data from the model loop, not trusted input.
   */
  handleAssistantStream(payload) {
    if (!this.active || this.disposed) return;
    if (payload === null || typeof payload !== "object") return;
    const record = payload;
    const sessionId = readSessionId(record.agent);
    const frameValue = record.frame;
    if (sessionId === void 0 || frameValue === null || typeof frameValue !== "object") return;
    const frame = frameValue;
    const attemptId = readAttemptId(frame);
    if (attemptId === "") return;
    const revision = readRevision(frame);
    try {
      if (frame.type === "start") {
        this.handleStart(sessionId, attemptId, revision, readTurn(frame));
        return;
      }
      if (frame.type === "chunk") {
        this.handleChunk(sessionId, attemptId, revision, frame.chunk);
        return;
      }
      if (frame.type === "end") {
        this.handleEnd(sessionId, attemptId, revision, frame.outcome);
      }
    } catch (error) {
      this.failures += 1;
      this.lastError = describeError(error);
      this.log(`[jev-highlight] failed to handle assistant stream frame: ${this.lastError}`);
    }
  }
  /**
   * `agent/inbox/claimed` listener: remember the user request for this turn so
   * the Jev state can carry it as `[question]` and `is_core_answer` judges the
   * passage against the actual request, not just its own wording.
   */
  handleInboxClaimed(payload) {
    if (!this.active || this.disposed) return;
    if (payload === null || typeof payload !== "object") return;
    const record = payload;
    const sessionId = readSessionId(record.agent);
    if (sessionId === void 0) return;
    const text = readUserMessageText(record.message);
    if (text === "") return;
    const session = this.ensureSession(sessionId);
    session.question = text;
    session.questionTurn = typeof record.turn === "number" && Number.isFinite(record.turn) ? Math.floor(record.turn) : session.turn;
  }
  /** `agent/status` listener. Intentionally does not abort: see the file header. */
  handleAgentStatus(_payload) {
  }
  /** `agent/disposed` listener: abort every in-flight request of the agent. */
  handleAgentDisposed(payload) {
    if (payload === null || typeof payload !== "object") return;
    const sessionId = readSessionId(payload.agent);
    if (sessionId !== void 0) this.abortSession(sessionId, "agent disposed");
  }
  /** `session/disposed` listener: abort every in-flight request of the session. */
  handleSessionDisposed(session) {
    const sessionId = readSessionId(session);
    if (sessionId !== void 0) this.abortSession(sessionId, "session disposed");
  }
  /** Abort one model attempt (all its in-flight requests and queued units). */
  abortAttempt(sessionId, attemptId, revision, reason = "attempt aborted") {
    const session = this.sessions.get(sessionId);
    if (session === void 0) return 0;
    let aborted = 0;
    for (const [key, controller] of session.scopes) {
      if (!key.startsWith(`${attemptId}#`)) continue;
      if (revision !== void 0 && key !== scopeKey(attemptId, revision)) continue;
      if (!controller.signal.aborted) {
        controller.abort();
        aborted += 1;
      }
      session.scopes.delete(key);
    }
    for (const [key, capture] of session.captures) {
      if (capture.attemptId !== attemptId) continue;
      if (revision !== void 0 && capture.revision !== revision) continue;
      session.captures.delete(key);
    }
    this.dropQueued(
      (job) => job.sessionId === sessionId && job.attemptId === attemptId && (revision === void 0 || job.revision === revision)
    );
    if (aborted > 0) this.log(`[jev-highlight] ${reason}: aborted ${aborted} attempt scope(s)`);
    return aborted;
  }
  /** Abort the whole session: every in-flight request and queued unit. */
  abortSession(sessionId, reason = "session aborted") {
    const session = this.sessions.get(sessionId);
    if (session === void 0) return;
    session.controller.abort();
    for (const controller of session.scopes.values()) {
      if (!controller.signal.aborted) controller.abort();
    }
    session.scopes.clear();
    session.captures.clear();
    this.sessions.delete(sessionId);
    this.dropQueued((job) => job.sessionId === sessionId);
    this.log(`[jev-highlight] ${reason}: session ${sessionId} torn down`);
  }
  /** Current verdict counts (for GET /state). */
  counts() {
    return this.store.countsSnapshot();
  }
  /** Update credential diagnostics when the Settings tab saves/clears a key. */
  setCredentialState(state) {
    this.keySource = state.keySource;
    this.keyConfigured = state.keyConfigured;
  }
  /**
   * Apply new highlight thresholds: future verdicts use them and retained
   * verdicts are re-levelled immediately so the UI is consistent.
   */
  setThresholds(thresholds) {
    this.thresholds = { ...thresholds };
    this.store.relevel(this.thresholds);
  }
  /** Clear a stale credential/route error once a key is saved successfully. */
  clearError() {
    this.lastError = null;
  }
  /** Full diagnostics snapshot for GET /diag. */
  snapshot() {
    const clientStats = this.client.stats();
    return {
      active: this.isActive && this.isEnabled,
      unitsSeen: this.unitsSeen,
      unitsQueued: this.queue.length,
      unitsJudged: this.unitsJudged,
      requests: clientStats.requests,
      inFlight: clientStats.inFlight,
      maxConcurrentObserved: clientStats.maxConcurrentObserved,
      maxRequestTokensObserved: clientStats.maxRequestTokensObserved,
      requestBudget: this.requestTokenBudget,
      concurrencyLimit: this.maxConcurrency,
      cacheHits: clientStats.cacheHits,
      cacheMisses: clientStats.cacheMisses,
      cacheSize: clientStats.cacheSize,
      abortedRequests: clientStats.abortedRequests,
      failures: this.failures,
      droppedUnits: this.droppedUnits,
      lastError: this.lastError,
      keySource: this.keySource,
      provider: this.provider,
      keyConfigured: this.keyConfigured,
      questionSetVersion: QUESTION_SET_VERSION,
      model: this.model,
      baseUrl: this.baseUrl,
      thresholdOverrides: { ...this.thresholds }
    };
  }
  /** Test seam: number of queued jobs (also exposed through diag). */
  get queued() {
    return this.queue.length;
  }
  /** Stop accepting frames, abort everything in flight and wait for settle. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.enabled = false;
    for (const sessionId of [...this.sessions.keys()]) this.abortSession(sessionId, "plugin unloaded");
    this.dropQueued(() => true);
    await Promise.allSettled([...this.runningTasks]);
  }
  handleStart(sessionId, attemptId, revision, turn) {
    const session = this.ensureSession(sessionId);
    if (turn !== void 0 && session.turn !== void 0 && turn !== session.turn) {
      session.heading = void 0;
      session.before = void 0;
      if (session.questionTurn !== turn) {
        session.question = void 0;
        session.questionTurn = void 0;
      }
    }
    if (turn !== void 0) session.turn = turn;
    for (const [key, controller] of session.scopes) {
      if (!key.startsWith(`${attemptId}#`)) continue;
      if (key === scopeKey(attemptId, revision)) continue;
      if (!controller.signal.aborted) controller.abort();
      session.scopes.delete(key);
    }
    for (const [key, capture] of session.captures) {
      if (capture.attemptId === attemptId && capture.revision !== revision) session.captures.delete(key);
    }
    this.dropQueued((job) => job.sessionId === sessionId && job.attemptId === attemptId && job.revision !== revision);
  }
  handleChunk(sessionId, attemptId, revision, chunkValue) {
    if (chunkValue === null || typeof chunkValue !== "object") return;
    const chunk = chunkValue;
    const session = this.ensureSession(sessionId);
    const blockIndex = readIndex(chunk.index);
    if (chunk.type === "block-start") {
      if (chunk.blockType === "text") this.ensureCapture(session, attemptId, revision, blockIndex);
      return;
    }
    if (chunk.type === "text-delta") {
      const text = chunk.text;
      if (typeof text !== "string" || text === "") return;
      const capture = this.ensureCapture(session, attemptId, revision, blockIndex);
      capture.streamedText += text;
      this.publishUnits(session, capture, capture.splitter.push(text));
      return;
    }
    if (chunk.type === "block-end") {
      const block = chunk.block;
      if (block !== null && typeof block === "object" && block.type === "text") {
        const capture = this.ensureCapture(session, attemptId, revision, blockIndex);
        const finalText = block.text;
        this.finishCapture(session, capture, typeof finalText === "string" ? finalText : void 0);
        return;
      }
      session.captures.delete(captureKey(attemptId, revision, blockIndex));
    }
  }
  handleEnd(sessionId, attemptId, revision, outcomeValue) {
    const session = this.ensureSession(sessionId);
    const committed = outcomeValue !== null && typeof outcomeValue === "object" && outcomeValue.kind === "committed";
    for (const [key, capture] of session.captures) {
      if (capture.attemptId !== attemptId || capture.revision !== revision) continue;
      if (committed) this.finishCapture(session, capture, void 0);
      else session.captures.delete(key);
    }
    if (committed) {
      session.scopes.delete(scopeKey(attemptId, revision));
      return;
    }
    this.abortAttempt(sessionId, attemptId, revision, "assistant stream abandoned");
  }
  ensureSession(sessionId) {
    const existing = this.sessions.get(sessionId);
    if (existing !== void 0) return existing;
    while (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.abortSession(oldest.value, "session table overflow");
    }
    const session = {
      sessionId,
      controller: new AbortController(),
      scopes: /* @__PURE__ */ new Map(),
      captures: /* @__PURE__ */ new Map(),
      heading: void 0,
      before: void 0,
      question: void 0,
      questionTurn: void 0,
      turn: void 0
    };
    this.sessions.set(sessionId, session);
    return session;
  }
  ensureScope(session, attemptId, revision) {
    const key = scopeKey(attemptId, revision);
    const existing = session.scopes.get(key);
    if (existing !== void 0) return existing;
    const controller = new AbortController();
    session.scopes.set(key, controller);
    return controller;
  }
  ensureCapture(session, attemptId, revision, blockIndex) {
    const key = captureKey(attemptId, revision, blockIndex);
    const existing = session.captures.get(key);
    if (existing !== void 0) return existing;
    const capture = {
      key,
      attemptId,
      revision,
      blockIndex,
      splitter: new StreamingSplitter({
        sessionId: session.sessionId,
        attemptId,
        blockIndex,
        initialHeading: session.heading,
        initialBefore: session.before,
        initialQuestion: session.question
      }),
      streamedText: "",
      emittedTexts: /* @__PURE__ */ new Set()
    };
    session.captures.set(key, capture);
    return capture;
  }
  publishUnits(session, capture, units) {
    for (const unit of units) {
      capture.emittedTexts.add(unit.text);
      this.enqueue(capture.attemptId, capture.revision, unit);
    }
    this.syncContext(session, capture);
  }
  syncContext(session, capture) {
    const heading = capture.splitter.heading;
    if (heading !== void 0 && heading !== "") session.heading = heading;
    const before = capture.splitter.before;
    if (before !== void 0 && before !== "") session.before = before;
  }
  /**
   * Close one text block. `block-end` carries the authoritative block text;
   * the streaming accumulation is normally identical, but a mismatch (retry
   * with a new revision, provider normalisation) must not silently lose or
   * duplicate content: the authoritative text wins, and units already emitted
   * are not emitted twice.
   */
  finishCapture(session, capture, finalText) {
    if (finalText !== void 0 && finalText !== capture.streamedText) {
      if (finalText.startsWith(capture.streamedText)) {
        const suffix = finalText.slice(capture.streamedText.length);
        capture.streamedText = finalText;
        this.publishUnits(session, capture, capture.splitter.push(suffix));
        this.publishUnits(session, capture, capture.splitter.flush());
      } else {
        this.log(`[jev-highlight] block-end text mismatch for ${capture.key}; reprocessing the authoritative text`);
        const replacement = new StreamingSplitter({
          sessionId: session.sessionId,
          attemptId: capture.attemptId,
          blockIndex: capture.blockIndex,
          initialHeading: capture.splitter.seededHeading,
          initialBefore: capture.splitter.seededBefore,
          initialQuestion: capture.splitter.seededQuestion,
          startOrdinal: capture.splitter.nextOrdinal
        });
        const units = [...replacement.push(finalText), ...replacement.flush()];
        const fresh = units.filter((unit) => !capture.emittedTexts.has(unit.text));
        capture.splitter = replacement;
        capture.streamedText = finalText;
        this.publishUnits(session, capture, fresh);
      }
    } else {
      this.publishUnits(session, capture, capture.splitter.flush());
    }
    session.captures.delete(capture.key);
    this.syncContext(session, capture);
  }
  enqueue(attemptId, revision, unit) {
    this.unitsSeen += 1;
    if (!this.active || this.disposed || !this.enabled) {
      this.droppedUnits += 1;
      return;
    }
    while (this.queue.length >= MAX_QUEUED_UNITS) {
      const dropped = this.queue.shift();
      if (dropped === void 0) break;
      this.droppedUnits += 1;
    }
    this.queue.push({ sessionId: unit.sessionId, attemptId, revision, unit });
    this.pump();
  }
  dropQueued(predicate) {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index];
      if (job === void 0) continue;
      if (!predicate(job)) continue;
      this.queue.splice(index, 1);
      this.droppedUnits += 1;
    }
  }
  pump() {
    while (this.active && !this.disposed && this.running < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === void 0) return;
      this.running += 1;
      const task = this.execute(job).catch(() => {
      });
      this.runningTasks.add(task);
      void task.finally(() => {
        this.running = Math.max(0, this.running - 1);
        this.runningTasks.delete(task);
        this.pump();
      });
    }
  }
  async execute(job) {
    const session = this.sessions.get(job.sessionId);
    if (session === void 0 || session.controller.signal.aborted) {
      this.droppedUnits += 1;
      return;
    }
    const scope = this.ensureScope(session, job.attemptId, job.revision);
    const signal = combineSignals([session.controller.signal, scope.signal]);
    if (signal.aborted) {
      this.droppedUnits += 1;
      return;
    }
    try {
      const result = await this.client.judgeUnit(job.unit, { signal });
      if (!this.active || this.disposed || signal.aborted) {
        this.droppedUnits += 1;
        return;
      }
      const priority = combinePriority(result.scores);
      const level = levelFor(priority, this.thresholds);
      const verdict = {
        unitId: job.unit.id,
        sessionId: job.unit.sessionId,
        type: job.unit.type,
        text: job.unit.text,
        context: job.unit.context,
        priority,
        level,
        scores: result.scores,
        model: this.model,
        cached: result.cached === true,
        createdAt: this.now()
      };
      if (job.unit.matchText !== void 0) verdict.matchText = job.unit.matchText;
      this.store.append(verdict);
      this.unitsJudged += 1;
    } catch (error) {
      if (isAbortLike(error) || signal.aborted) {
        this.droppedUnits += 1;
        return;
      }
      this.failures += 1;
      this.lastError = describeError(error);
      this.log(`[jev-highlight] unit ${job.unit.id} failed: ${this.lastError}`);
    }
  }
};

// src/host/think-mode.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
function thinkModeFilePath(options = {}) {
  const override = typeof options.file === "string" ? options.file.trim() : "";
  if (override !== "") return override;
  const home = typeof options.dshHome === "string" && options.dshHome.trim() !== "" ? options.dshHome.trim() : resolveDshHome(options.env);
  return join2(home, "jev-highlight-think-mode");
}
function isStartLuxThinkMode(value) {
  return value === "never" || value === "auto" || value === "always";
}
function readThinkModeFile(file) {
  try {
    if (!existsSync2(file)) return null;
    const value = readFileSync2(file, "utf8").split(/\r?\n/u)[0]?.trim() ?? "";
    return isStartLuxThinkMode(value) ? value : null;
  } catch {
    return null;
  }
}
function saveThinkModeFile(mode, file) {
  if (!isStartLuxThinkMode(mode)) {
    return { ok: false, error: "think mode must be 'never', 'auto' or 'always'" };
  }
  try {
    mkdirSync2(dirname2(file), { recursive: true });
    writeFileSync2(file, `${mode}
`, { encoding: "utf8", mode: 384 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function clearThinkModeFile(file) {
  try {
    if (existsSync2(file)) unlinkSync2(file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// src/host/thresholds.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
function thresholdsFilePath(options = {}) {
  const override = typeof options.file === "string" ? options.file.trim() : "";
  if (override !== "") return override;
  const home = typeof options.dshHome === "string" && options.dshHome.trim() !== "" ? options.dshHome.trim() : resolveDshHome(options.env);
  return join3(home, "jev-highlight-thresholds.json");
}
function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isValidThresholds(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return validNumber(record.critical) && validNumber(record.medium) && validNumber(record.low);
}
function normaliseThresholds(value) {
  if (!isValidThresholds(value)) {
    return { ok: false, error: "thresholds must be three numbers between 0 and 1" };
  }
  const thresholds = {
    critical: round4(value.critical),
    medium: round4(value.medium),
    low: round4(value.low)
  };
  if (thresholds.medium > thresholds.critical) {
    return { ok: false, error: "critical must be greater than or equal to medium" };
  }
  if (thresholds.low > thresholds.medium) {
    return { ok: false, error: "medium must be greater than or equal to low" };
  }
  return { ok: true, thresholds };
}
function readThresholdsFile(file) {
  try {
    if (!existsSync3(file)) return null;
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    const result = normaliseThresholds(parsed);
    return result.ok ? result.thresholds : null;
  } catch {
    return null;
  }
}
function saveThresholdsFile(thresholds, file) {
  const result = normaliseThresholds(thresholds);
  if (!result.ok) return result;
  try {
    mkdirSync3(dirname3(file), { recursive: true });
    writeFileSync3(file, `${JSON.stringify(result.thresholds, null, 2)}
`, { encoding: "utf8", mode: 384 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function clearThresholdsFile(file) {
  try {
    if (existsSync3(file)) unlinkSync3(file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

// src/host/routes.ts
var ROUTE_STATE = "/jev-highlight/state";
var ROUTE_UNITS = "/jev-highlight/units";
var ROUTE_DIAG = "/jev-highlight/diag";
var ROUTE_TOGGLE = "/jev-highlight/toggle";
var ROUTE_PROMPTS = "/jev-highlight/prompts";
var ROUTE_PROVIDER = "/jev-highlight/provider";
var ROUTE_KEY = "/jev-highlight/key";
var ROUTE_CHECK = "/jev-highlight/check";
var ROUTE_THINK = "/jev-highlight/think";
var ROUTE_THRESHOLDS = "/jev-highlight/thresholds";
var JEV_ROUTE_PATHS = [
  ROUTE_STATE,
  ROUTE_UNITS,
  ROUTE_DIAG,
  ROUTE_TOGGLE,
  ROUTE_PROMPTS,
  ROUTE_PROVIDER,
  ROUTE_KEY,
  ROUTE_CHECK,
  ROUTE_THINK,
  ROUTE_THRESHOLDS
];
var MAX_BODY_BYTES = 65536;
function describeError2(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 400)}\u2026` : message;
}
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const parts = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        rejectBody(new Error("request body is too large"));
        req.destroy();
        return;
      }
      parts.push(buffer);
    });
    req.on("end", () => {
      const text = Buffer.concat(parts).toString("utf8").trim();
      if (text === "") {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch (error) {
        rejectBody(new Error(`request body is not JSON: ${describeError2(error)}`));
      }
    });
    req.on("error", (error) => rejectBody(error));
  });
}
function sendJson(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    body = JSON.stringify({ ok: false, error: "state is not serializable" });
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function guardRouteRequest(req, res, expectedMethod) {
  const method = String(req.method ?? "").toUpperCase();
  if (method !== expectedMethod) {
    sendJson(res, 405, { ok: false, error: `only ${expectedMethod} is allowed` });
    return false;
  }
  const headers = req.headers ?? {};
  const origin = typeof headers.origin === "string" ? headers.origin.trim() : "";
  if (origin !== "") {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = void 0;
    }
    const host = typeof headers.host === "string" ? headers.host : "";
    if (parsed === void 0 || host === "" || parsed.host !== host) {
      sendJson(res, 403, { ok: false, error: "only same-origin page requests are allowed" });
      return false;
    }
  }
  if (headers["sec-fetch-site"] === "cross-site") {
    sendJson(res, 403, { ok: false, error: "only same-origin page requests are allowed" });
    return false;
  }
  if (expectedMethod === "POST") {
    const contentType = typeof headers["content-type"] === "string" ? headers["content-type"].toLowerCase() : "";
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 415, { ok: false, error: "POST requests must use application/json" });
      return false;
    }
  }
  return true;
}
function parseNonNegativeInt(raw, fallback) {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
function clampLimit(raw) {
  const parsed = parseNonNegativeInt(raw, 200);
  if (parsed < 1) return 200;
  return Math.min(1e3, parsed);
}
function parseQuery(url) {
  const raw = typeof url === "string" ? url : "";
  const index = raw.indexOf("?");
  if (index === -1) return new URLSearchParams();
  try {
    return new URLSearchParams(raw.slice(index + 1));
  } catch {
    return new URLSearchParams();
  }
}
function registerJevRoutes(webServer, deps) {
  if (typeof webServer?.register !== "function") {
    throw new Error("the web server service is unavailable; cannot register jev-highlight routes");
  }
  const disposeState = webServer.register({
    kind: "exact",
    path: ROUTE_STATE,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, "GET")) return;
      try {
        sendJson(res, 200, { ok: true, ...deps.getState() });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposeUnits = webServer.register({
    kind: "exact",
    path: ROUTE_UNITS,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, "GET")) return;
      try {
        const query = parseQuery(req.url);
        const sessionId = query.get("sessionId") ?? void 0;
        const result = deps.getUnits({
          since: parseNonNegativeInt(query.get("since"), 0),
          sessionId: sessionId === void 0 || sessionId.trim() === "" ? void 0 : sessionId.trim(),
          limit: clampLimit(query.get("limit"))
        });
        sendJson(res, 200, { ok: true, units: result.units, seq: result.seq });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposeDiag = webServer.register({
    kind: "exact",
    path: ROUTE_DIAG,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, "GET")) return;
      try {
        sendJson(res, 200, { ok: true, ...deps.getDiag() });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposeToggle = webServer.register({
    kind: "exact",
    path: ROUTE_TOGGLE,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, "POST")) return;
      try {
        const body = await readJsonBody(req);
        if (typeof body?.enabled !== "boolean") {
          sendJson(res, 200, { ok: false, error: "body.enabled must be a boolean" });
          return;
        }
        sendJson(res, 200, { ok: true, state: deps.toggle(body.enabled) });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposePrompts = webServer.register({
    kind: "exact",
    path: ROUTE_PROMPTS,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, "GET")) return;
      try {
        sendJson(res, 200, { ok: true, ...deps.getPrompts() });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposeProvider = webServer.register({
    kind: "exact",
    path: ROUTE_PROVIDER,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, "GET")) return;
      try {
        sendJson(res, 200, { ok: true, provider: deps.getProvider() });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposeKey = webServer.register({
    kind: "exact",
    path: ROUTE_KEY,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, "POST")) return;
      try {
        const body = await readJsonBody(req);
        const action = typeof body?.action === "string" ? body.action.trim() : "save";
        if (action === "save") {
          if (typeof body.key !== "string" || body.key.trim() === "") {
            sendJson(res, 200, { ok: false, action, error: "body.key must be a non-empty string" });
            return;
          }
          const result = deps.saveKey(body.key);
          sendJson(res, 200, { ok: result.ok, action, provider: result.provider, ...result.error !== void 0 ? { error: result.error } : {} });
          return;
        }
        if (action === "clear") {
          const result = deps.clearKey();
          sendJson(res, 200, { ok: result.ok, action, provider: result.provider, ...result.error !== void 0 ? { error: result.error } : {} });
          return;
        }
        sendJson(res, 200, { ok: false, action, error: 'action must be "save" or "clear"' });
      } catch (error) {
        sendJson(res, 200, { ok: false, action: "save", error: describeError2(error) });
      }
    }
  });
  const disposeCheck = webServer.register({
    kind: "exact",
    path: ROUTE_CHECK,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, "POST")) return;
      try {
        const result = await deps.check();
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 200, { ok: false, provider: "jev", model: "", error: describeError2(error) });
      }
    }
  });
  const disposeThink = webServer.register({
    kind: "exact",
    path: ROUTE_THINK,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, "POST")) return;
      try {
        const body = await readJsonBody(req);
        const raw = typeof body?.mode === "string" ? body.mode.trim() : "";
        if (raw !== "never" && raw !== "auto" && raw !== "always" && raw !== "default") {
          sendJson(res, 200, { ok: false, error: "mode must be 'never', 'auto', 'always' or 'default'" });
          return;
        }
        const result = deps.setThinkMode(raw);
        sendJson(res, 200, { ok: result.ok, mode: result.mode, provider: result.provider, ...result.error !== void 0 ? { error: result.error } : {} });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  const disposeThresholds = webServer.register({
    kind: "exact",
    path: ROUTE_THRESHOLDS,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, "POST")) return;
      try {
        const body = await readJsonBody(req);
        const action = typeof body?.action === "string" ? body.action.trim() : "save";
        if (action === "reset") {
          const result2 = deps.resetThresholds();
          sendJson(res, 200, {
            ok: result2.ok,
            thresholds: result2.thresholds,
            source: result2.source,
            provider: result2.provider,
            ...result2.error !== void 0 ? { error: result2.error } : {}
          });
          return;
        }
        if (action !== "save") {
          sendJson(res, 200, { ok: false, error: "action must be 'save' or 'reset'" });
          return;
        }
        const result = deps.setThresholds({ critical: body.critical, medium: body.medium, low: body.low });
        sendJson(res, 200, {
          ok: result.ok,
          thresholds: result.thresholds,
          source: result.source,
          provider: result.provider,
          ...result.error !== void 0 ? { error: result.error } : {}
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError2(error) });
      }
    }
  });
  return () => {
    for (const dispose of [
      disposeState,
      disposeUnits,
      disposeDiag,
      disposeToggle,
      disposePrompts,
      disposeProvider,
      disposeKey,
      disposeCheck,
      disposeThink,
      disposeThresholds
    ]) {
      try {
        dispose();
      } catch {
      }
    }
  };
}

// src/host/store.ts
var DEFAULT_QUERY_LIMIT = 200;
var MAX_QUERY_LIMIT = 1e3;
function clampLimit2(limit) {
  const value = Math.floor(limit ?? DEFAULT_QUERY_LIMIT);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_QUERY_LIMIT;
  return Math.min(MAX_QUERY_LIMIT, value);
}
var VerdictStore = class {
  perSessionLimit;
  globalLimit;
  units = [];
  bySession = /* @__PURE__ */ new Map();
  counts = { critical: 0, medium: 0, low: 0 };
  evictedSeqs = /* @__PURE__ */ new Set();
  seqCursor = 0;
  constructor(options = {}) {
    const perSession = Math.floor(options.perSessionLimit ?? 500);
    const global = Math.floor(options.globalLimit ?? 2e3);
    this.perSessionLimit = Number.isFinite(perSession) && perSession > 0 ? perSession : 500;
    this.globalLimit = Number.isFinite(global) && global > 0 ? global : 2e3;
  }
  /** Highest sequence assigned so far. */
  get lastSeq() {
    return this.seqCursor;
  }
  get size() {
    return this.units.length;
  }
  /** Store a judgement; assigns the next monotonic sequence. */
  append(verdict) {
    this.seqCursor += 1;
    const stored = { ...verdict, seq: this.seqCursor };
    this.units.push(stored);
    const sessionUnits = this.bySession.get(stored.sessionId);
    if (sessionUnits === void 0) this.bySession.set(stored.sessionId, [stored]);
    else sessionUnits.push(stored);
    this.incrementLevel(stored.level);
    const sessionList = this.bySession.get(stored.sessionId);
    if (sessionList !== void 0) {
      while (sessionList.length > this.perSessionLimit) {
        const oldest = sessionList[0];
        if (oldest === void 0) break;
        this.evict(oldest);
      }
    }
    while (this.units.length > this.globalLimit) {
      const oldest = this.units[0];
      if (oldest === void 0) break;
      this.evict(oldest);
    }
    return stored;
  }
  /**
   * Query by cursor. `seq` is the next cursor: the last returned seq when the
   * result was truncated, otherwise the store's global last seq.
   */
  query(query = {}) {
    const since = Number.isFinite(query.since ?? 0) ? Math.max(0, Math.floor(query.since ?? 0)) : 0;
    const limit = clampLimit2(query.limit);
    const sessionId = typeof query.sessionId === "string" && query.sessionId !== "" ? query.sessionId : void 0;
    const result = [];
    for (const unit of this.units) {
      if (unit.seq <= since) continue;
      if (sessionId !== void 0 && unit.sessionId !== sessionId) continue;
      if (result.length >= limit) {
        const last = result[result.length - 1];
        return { units: result, seq: last !== void 0 ? last.seq : this.seqCursor };
      }
      result.push(unit);
    }
    return { units: result, seq: this.seqCursor };
  }
  /** Current highlight bucket counts across retained verdicts. */
  countsSnapshot() {
    return { critical: this.counts.critical, medium: this.counts.medium, low: this.counts.low };
  }
  /**
   * Recompute every retained verdict's level under new thresholds.
   *
   * Used when the Settings tab changes the cutoffs: without this, already
   * judged units would keep their old bucket while new units use the new one.
   */
  relevel(thresholds) {
    this.counts.critical = 0;
    this.counts.medium = 0;
    this.counts.low = 0;
    for (const unit of this.units) {
      const level = levelFor(unit.priority, thresholds);
      unit.level = level;
      this.incrementLevel(level);
    }
  }
  /** All verdicts of one session, oldest first (diagnostics/tests only). */
  sessionUnits(sessionId) {
    return [...this.bySession.get(sessionId) ?? []];
  }
  clear() {
    this.units.length = 0;
    this.bySession.clear();
    this.evictedSeqs.clear();
    this.counts.critical = 0;
    this.counts.medium = 0;
    this.counts.low = 0;
    this.seqCursor = 0;
  }
  evict(verdict) {
    if (this.evictedSeqs.has(verdict.seq)) return;
    this.evictedSeqs.add(verdict.seq);
    const globalIndex = this.units.indexOf(verdict);
    if (globalIndex >= 0) this.units.splice(globalIndex, 1);
    const sessionList = this.bySession.get(verdict.sessionId);
    if (sessionList !== void 0) {
      const index = sessionList.indexOf(verdict);
      if (index >= 0) sessionList.splice(index, 1);
      if (sessionList.length === 0) this.bySession.delete(verdict.sessionId);
    }
    this.decrementLevel(verdict.level);
  }
  incrementLevel(level) {
    if (level === "critical") this.counts.critical += 1;
    else if (level === "medium") this.counts.medium += 1;
    else if (level === "low") this.counts.low += 1;
  }
  decrementLevel(level) {
    if (level === "critical") this.counts.critical = Math.max(0, this.counts.critical - 1);
    else if (level === "medium") this.counts.medium = Math.max(0, this.counts.medium - 1);
    else if (level === "low") this.counts.low = Math.max(0, this.counts.low - 1);
  }
};

// src/host/runtime.ts
var pluginName = "jev-highlight";
var PER_SESSION_VERDICTS = 500;
var STATE_TEMPLATE = [
  "[section] {nearest markdown heading}",
  "[preceding line] {last line of the previous unit}",
  "[question] {current user request, bounded}",
  "[passage]",
  "{verbatim content unit text}"
].join("\n");
function isWebServerLike(value) {
  return value !== null && typeof value === "object" && typeof value.register === "function";
}
function makeLogger(ctx, debug) {
  return (message) => {
    if (!debug) return;
    try {
      const logger = ctx.logger;
      if (logger === void 0) return;
      if (typeof logger.warn === "function") logger.warn(message);
      else if (typeof logger.info === "function") logger.info(message);
      else if (typeof logger.error === "function") logger.error(message);
    } catch {
    }
  };
}
function providerEndpoint(config) {
  if (config.provider === "startlux") {
    const baseUrl = config.startluxBaseUrl;
    const endpointPath = config.startluxEndpointPath;
    return {
      provider: "startlux",
      baseUrl,
      endpointPath,
      url: `${baseUrl}${endpointPath}`,
      model: config.startluxModel
    };
  }
  return {
    provider: "jev",
    baseUrl: config.jevBaseUrl,
    endpointPath: "/v1/systemone",
    url: `${config.jevBaseUrl}/v1/systemone`,
    model: config.model
  };
}
function resolveProviderCredential(config) {
  if (config.provider === "startlux") {
    return resolveStartLuxApiKey({ keyFile: config.startluxKeyFile });
  }
  return resolveJevApiKey({ configKey: config.jevApiKey });
}
function createHostRuntime(options) {
  const { ctx, config, credential } = options;
  let credentialMissing = options.credentialMissing === true;
  let credentialNotice = options.credentialNotice ?? null;
  let keySource = credentialMissing ? null : credential.source;
  const log = makeLogger(ctx, config.debug);
  const target = providerEndpoint(config);
  const keyFile = startluxKeyFilePath({ keyFile: config.startluxKeyFile });
  const thinkFile = thinkModeFilePath();
  let thinkMode = readThinkModeFile(thinkFile) ?? config.startluxThinkMode;
  const thresholdsFile = thresholdsFilePath();
  const persistedThresholds = readThresholdsFile(thresholdsFile);
  let currentThresholds = persistedThresholds ?? { ...config.highlightThresholds };
  let thresholdsOverridden = persistedThresholds !== null;
  const cache = new LruVerdictCache({ capacity: config.cacheCapacity });
  const client = new JevClient({
    // JevClient enforces a non-empty key. In degraded mode no request is ever
    // issued (the pipeline stays disabled); the placeholder only satisfies that
    // invariant so the rest of the plugin can load.
    apiKey: credential.key !== "" ? credential.key : "unconfigured-degraded-mode",
    provider: target.provider,
    baseUrl: target.baseUrl,
    endpointPath: target.endpointPath,
    thinkMode,
    model: target.model,
    fetchImpl: options.fetchImpl,
    timeoutMs: config.requestTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    requestTokenBudget: config.requestTokenBudget,
    unitTokenBudget: config.unitTokenBudget,
    cache,
    log
  });
  const store = new VerdictStore({ perSessionLimit: PER_SESSION_VERDICTS });
  const pipeline = new JudgePipeline({
    client,
    store,
    model: target.model,
    baseUrl: target.url,
    keySource,
    provider: target.provider,
    keyConfigured: !credentialMissing,
    thresholds: currentThresholds,
    maxConcurrency: config.maxConcurrency,
    requestTokenBudget: config.requestTokenBudget,
    // Without a key there is nothing to judge with: keep the pipeline idle so
    // the UI can still load and show the actionable credential notice.
    autoStart: config.autoStart && !credentialMissing,
    log
  });
  if (credentialMissing && credentialNotice !== null) pipeline.noteError(credentialNotice);
  const cleanups = [];
  let started = false;
  let stopped = false;
  const registerCleanup = (cleanup) => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      try {
        cleanup();
      } catch {
      }
    };
    cleanups.push(once);
    const effect = ctx.effect;
    if (typeof effect === "function") {
      try {
        effect(() => once);
      } catch (error) {
        log(`[jev-highlight] ctx.effect failed: ${describeError(error)}`);
      }
    }
  };
  const resolveService = (name2) => {
    try {
      if (typeof ctx.get === "function") {
        const service = ctx.get(name2);
        if (service !== void 0 && service !== null) return service;
      }
    } catch (error) {
      log(`[jev-highlight] ctx.get(${name2}) failed: ${describeError(error)}`);
    }
    return ctx[name2];
  };
  const getWebServer = () => {
    const service = resolveService("webServer");
    return isWebServerLike(service) ? service : void 0;
  };
  const state = () => ({
    enabled: pipeline.isEnabled && !credentialMissing,
    provider: target.provider,
    keyConfigured: !credentialMissing,
    notice: credentialNotice,
    counts: pipeline.counts(),
    capabilities: { highlightApi: true },
    model: target.model,
    baseUrl: target.url,
    thresholds: { ...currentThresholds }
  });
  const providerStatus = () => ({
    provider: target.provider,
    model: target.model,
    baseUrl: target.baseUrl,
    endpointPath: target.endpointPath,
    thinkMode: target.provider === "startlux" ? thinkMode : "n/a",
    keyConfigured: !credentialMissing,
    keySource,
    keyFile,
    keyRequired: config.requireApiKey,
    thresholds: { ...currentThresholds },
    thresholdsSource: thresholdsOverridden ? "settings" : "config"
  });
  const getUnits = (query) => store.query(query);
  const diag = () => pipeline.snapshot();
  const getPrompts = () => ({
    questionSetVersion: QUESTION_SET_VERSION,
    provider: target.provider,
    model: target.model,
    stateTemplate: STATE_TEMPLATE,
    questions: buildJevQuestions(),
    weights: { ...PRIORITY_WEIGHTS },
    thresholds: { ...currentThresholds },
    maxQuestionChars: MAX_QUESTION_CHARS
  });
  const unavailableKeyResult = (action) => ({
    ok: false,
    action,
    provider: providerStatus(),
    error: target.provider === "startlux" ? credentialNotice ?? "StartLux key is not configured" : "The Settings key store is for StartLux; configure the Jev key via JEV_API_KEY or $DSH_HOME/.credentials.yaml"
  });
  const saveKey = (rawKey) => {
    if (target.provider !== "startlux") return unavailableKeyResult("save");
    const saved = saveStartLuxKey(rawKey, keyFile);
    if (!saved.ok) return { ok: false, action: "save", provider: providerStatus(), error: saved.error };
    client.setApiKey(rawKey.trim());
    credentialMissing = false;
    credentialNotice = null;
    keySource = "settings:key-file";
    pipeline.setCredentialState({ keySource, keyConfigured: true });
    pipeline.clearError();
    pipeline.setEnabled(config.autoStart);
    return { ok: true, action: "save", provider: providerStatus() };
  };
  const clearKey = () => {
    if (target.provider !== "startlux") return unavailableKeyResult("clear");
    const cleared = clearStartLuxKey(keyFile);
    if (!cleared.ok) return { ok: false, action: "clear", provider: providerStatus(), error: cleared.error };
    client.setApiKey("unconfigured-degraded-mode");
    credentialMissing = true;
    credentialNotice = new MissingStartLuxApiKeyError(keyFile).message;
    keySource = null;
    pipeline.setCredentialState({ keySource: null, keyConfigured: false });
    pipeline.noteError(credentialNotice);
    pipeline.setEnabled(false);
    return { ok: true, action: "clear", provider: providerStatus() };
  };
  const setThinkMode = (mode) => {
    if (target.provider !== "startlux") {
      return {
        ok: false,
        mode: config.startluxThinkMode,
        provider: providerStatus(),
        error: "think mode is only available for the StartLux provider"
      };
    }
    if (mode === "default") {
      const cleared = clearThinkModeFile(thinkFile);
      if (!cleared.ok) return { ok: false, mode: thinkMode, provider: providerStatus(), error: cleared.error };
      thinkMode = config.startluxThinkMode;
    } else {
      const saved = saveThinkModeFile(mode, thinkFile);
      if (!saved.ok) return { ok: false, mode: thinkMode, provider: providerStatus(), error: saved.error };
      thinkMode = mode;
    }
    client.setThinkMode(thinkMode);
    return { ok: true, mode: thinkMode, provider: providerStatus() };
  };
  const setThresholds = (input) => {
    const result = normaliseThresholds(input);
    if (!result.ok) {
      return {
        ok: false,
        thresholds: { ...currentThresholds },
        source: thresholdsOverridden ? "settings" : "config",
        provider: providerStatus(),
        error: result.error
      };
    }
    const saved = saveThresholdsFile(result.thresholds, thresholdsFile);
    if (!saved.ok) {
      return {
        ok: false,
        thresholds: { ...currentThresholds },
        source: thresholdsOverridden ? "settings" : "config",
        provider: providerStatus(),
        error: saved.error
      };
    }
    currentThresholds = result.thresholds;
    thresholdsOverridden = true;
    pipeline.setThresholds(currentThresholds);
    return { ok: true, thresholds: { ...currentThresholds }, source: "settings", provider: providerStatus() };
  };
  const resetThresholds = () => {
    const cleared = clearThresholdsFile(thresholdsFile);
    if (!cleared.ok) {
      return {
        ok: false,
        thresholds: { ...currentThresholds },
        source: thresholdsOverridden ? "settings" : "config",
        provider: providerStatus(),
        error: cleared.error
      };
    }
    currentThresholds = { ...config.highlightThresholds };
    thresholdsOverridden = false;
    pipeline.setThresholds(currentThresholds);
    return { ok: true, thresholds: { ...currentThresholds }, source: "config", provider: providerStatus() };
  };
  const check = async () => {
    if (credentialMissing) {
      return { ok: false, provider: target.provider, model: target.model, error: credentialNotice ?? "API key is not configured" };
    }
    const startedAt = Date.now();
    try {
      const response = await client.systemOne({
        state: "Health check: the jev-highlight plugin is verifying the configured decision endpoint.",
        questions: { health: { type: "noul", instructions: "Does this request reach the decision model successfully?" } }
      });
      const answers = response.answers;
      const health = answers !== void 0 && answers !== null ? answers.health : void 0;
      const answer = extractProbability(health);
      return {
        ok: true,
        provider: target.provider,
        model: target.model,
        latencyMs: Date.now() - startedAt,
        modelReturned: typeof response.model === "string" ? response.model : void 0,
        ...answer !== void 0 ? { answer } : {}
      };
    } catch (error) {
      return { ok: false, provider: target.provider, model: target.model, latencyMs: Date.now() - startedAt, error: describeError(error) };
    }
  };
  const start = () => {
    if (started || stopped) return;
    started = true;
    pipeline.start();
    const on = ctx.on;
    if (typeof on !== "function") throw new Error("jev-highlight requires a Cordis context with ctx.on");
    const listen = (event, listener) => {
      const disposer = on.call(ctx, event, listener);
      if (typeof disposer === "function") registerCleanup(() => disposer());
    };
    listen("agent/assistant-stream", (payload) => pipeline.handleAssistantStream(payload));
    listen("agent/inbox/claimed", (payload) => pipeline.handleInboxClaimed(payload));
    listen("agent/status", (payload) => pipeline.handleAgentStatus(payload));
    listen("agent/disposed", (payload) => pipeline.handleAgentDisposed(payload));
    listen("session/disposed", (session) => pipeline.handleSessionDisposed(session));
    const webServer = getWebServer();
    if (webServer === void 0) {
      const message = "the webServer service is unavailable; jev-highlight client routes were not registered";
      pipeline.noteError(message);
      log(`[jev-highlight] ${message}`);
      return;
    }
    try {
      const disposeRoutes = registerJevRoutes(webServer, {
        getState: state,
        getUnits,
        getDiag: diag,
        getPrompts,
        getProvider: providerStatus,
        saveKey,
        clearKey,
        setThinkMode,
        setThresholds,
        resetThresholds,
        check,
        toggle: (enabled) => {
          pipeline.setEnabled(credentialMissing ? false : enabled);
          return state();
        }
      });
      registerCleanup(disposeRoutes);
    } catch (error) {
      pipeline.noteError(describeError(error));
      log(`[jev-highlight] route registration failed: ${describeError(error)}`);
    }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await pipeline.dispose();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      const cleanup = cleanups[index];
      if (cleanup !== void 0) cleanup();
    }
    cleanups.length = 0;
  };
  return { start, stop, pipeline, client, store, cache, config, state, diag, providerStatus };
}
function apply(ctx, rawConfig) {
  const config = normaliseConfig(rawConfig);
  let credential;
  let credentialMissing = false;
  let credentialNotice = null;
  try {
    credential = resolveProviderCredential(config);
  } catch (error) {
    const expected = error instanceof MissingJevApiKeyError || error instanceof MissingStartLuxApiKeyError;
    if (config.requireApiKey || !expected) throw error;
    credentialMissing = true;
    credentialNotice = error.message;
    credential = { key: "", source: "missing" };
    try {
      const logger = ctx.logger;
      const message = `[jev-highlight] ${error.message} \u2014 loaded in degraded mode: judging stays disabled until a key is provided`;
      if (logger !== void 0 && typeof logger.error === "function") logger.error(message);
      else if (logger !== void 0 && typeof logger.warn === "function") logger.warn(message);
    } catch {
    }
  }
  const host = ctx;
  const runtime = createHostRuntime({ ctx: host, config, credential, credentialMissing, credentialNotice });
  const effect = host.effect;
  if (typeof effect === "function") {
    effect(() => {
      runtime.start();
      return () => runtime.stop();
    });
    return;
  }
  runtime.start();
}

// src/host/internal.ts
var __internals = {
  StreamingSplitter,
  splitMarkdownText,
  LruVerdictCache,
  cacheKeyFor,
  cacheKeyForUnit,
  normaliseCacheText,
  MissingJevApiKeyError,
  credentialsFilePath,
  parseCredentialsYaml,
  resolveDshHome,
  resolveJevApiKey,
  JevClient,
  NOUL_QUESTIONS,
  buildJevQuestions,
  buildStateText,
  combineScoresMax,
  extractProbability,
  parseSystemOneScores,
  parseSystemOneScoresDetailed,
  planUnitRequests,
  HARD_STATE_QUESTION_LIMIT,
  HARD_TOTAL_LIMIT,
  FIXED_REQUEST_OVERHEAD_TOKENS,
  estimateJsonTokens,
  estimateRequestTokens,
  estimateTokens,
  splitTextToTokenBudget,
  Semaphore,
  VerdictStore,
  JudgePipeline,
  guardRouteRequest,
  parseQuery,
  readJsonBody,
  registerJevRoutes,
  sendJson,
  createHostRuntime,
  DEFAULT_THRESHOLDS,
  STARTLUX_THRESHOLDS,
  MAX_QUESTION_CHARS,
  PRIORITY_WEIGHTS,
  QUESTION_SET_VERSION,
  combinePriority,
  levelFor
};

// src/index.ts
var name = pluginName;
var inject = ["webServer"];
function apply2(ctx, config) {
  apply(ctx, config);
}
export {
  ASCII_TOKENS_PER_CHAR,
  CALIBRATED_ASCII_TOKENS_PER_CHAR,
  CALIBRATED_CJK_TOKENS_PER_CHAR,
  CALIBRATED_REQUEST_OVERHEAD,
  CJK_TOKENS_PER_CHAR,
  Config,
  DEFAULT_BEFORE_LIMIT,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_THRESHOLDS,
  ESTIMATE_SAFETY_FACTOR,
  FIXED_REQUEST_OVERHEAD_TOKENS,
  HARD_STATE_QUESTION_LIMIT,
  HARD_TOTAL_LIMIT,
  JEV_ROUTE_PATHS,
  JevAbortError,
  JevBudgetError,
  JevClient,
  JevHttpError,
  JevParseError,
  JevTimeoutError,
  JudgePipeline,
  LruVerdictCache,
  MAX_QUERY_LIMIT,
  MAX_QUESTION_CHARS,
  MAX_QUEUED_UNITS,
  MAX_SUB_CHUNKS,
  MAX_TRACKED_SESSIONS,
  MissingJevApiKeyError,
  MissingStartLuxApiKeyError,
  NOUL_QUESTIONS,
  PRIORITY_WEIGHTS,
  QUESTION_SET_VERSION,
  ROUTE_CHECK,
  ROUTE_DIAG,
  ROUTE_KEY,
  ROUTE_PROMPTS,
  ROUTE_PROVIDER,
  ROUTE_STATE,
  ROUTE_THINK,
  ROUTE_THRESHOLDS,
  ROUTE_TOGGLE,
  ROUTE_UNITS,
  STARTLUX_THRESHOLDS,
  Semaphore,
  StreamingSplitter,
  VerdictStore,
  __internals,
  apply2 as apply,
  assertRequestBudget,
  buildJevQuestions,
  buildStateText,
  cacheKeyFor,
  cacheKeyForUnit,
  checkRequestBudget,
  clearStartLuxKey,
  clearThinkModeFile,
  combinePriority,
  combineScoresMax,
  combineSignals,
  createHostRuntime,
  createTimeoutSignal,
  credentialsFilePath,
  describeError,
  estimateJsonTokens,
  estimateRequestTokens,
  estimateTokens,
  extractProbability,
  guardRouteRequest,
  inject,
  isAbortLike,
  isStartLuxThinkMode,
  levelFor,
  name,
  normaliseCacheText,
  normaliseConfig,
  parseCredentialsYaml,
  parseQuery,
  parseSystemOneScores,
  parseSystemOneScoresDetailed,
  planUnitRequests,
  pluginName,
  readJsonBody,
  readStartLuxKeyFile,
  readThinkModeFile,
  readUserMessageText,
  registerJevRoutes,
  resolveDshHome,
  resolveJevApiKey,
  resolveStartLuxApiKey,
  saveStartLuxKey,
  saveThinkModeFile,
  sendJson,
  sleep,
  splitMarkdownText,
  splitTextToTokenBudget,
  startluxKeyFilePath,
  tableRowCells,
  thinkModeFilePath
};
