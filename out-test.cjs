// test/flow.test.ts
var import_fs3 = require("fs");
var import_os2 = require("os");
var import_path3 = require("path");

// src/main/store.ts
var import_fs = require("fs");
var import_path = require("path");
var Store = class {
  filePath;
  data;
  constructor(storeDir) {
    this.filePath = (0, import_path.join)(storeDir, "config.json");
    if (!(0, import_fs.existsSync)(storeDir)) (0, import_fs.mkdirSync)(storeDir, { recursive: true });
    this.data = this.load();
  }
  getConfigFile() {
    return this.filePath;
  }
  getBackupDir() {
    return (0, import_path.join)((0, import_path.join)(this.filePath, ".."), "backups");
  }
  load() {
    if (!(0, import_fs.existsSync)(this.filePath)) return { providers: [], active: {} };
    try {
      const raw = (0, import_fs.readFileSync)(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        active: parsed.active && typeof parsed.active === "object" ? parsed.active : {}
      };
    } catch {
      return { providers: [], active: {} };
    }
  }
  save() {
    (0, import_fs.mkdirSync)((0, import_path.join)(this.filePath, ".."), { recursive: true });
    (0, import_fs.writeFileSync)(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
  listProviders() {
    return this.data.providers;
  }
  getProvider(id) {
    return this.data.providers.find((p) => p.id === id);
  }
  upsertProvider(p) {
    const idx = this.data.providers.findIndex((x) => x.id === p.id);
    if (idx >= 0) this.data.providers[idx] = p;
    else this.data.providers.push(p);
    this.save();
  }
  deleteProvider(id) {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    for (const k of Object.keys(this.data.active)) {
      if (this.data.active[k] === id) delete this.data.active[k];
    }
    this.save();
  }
  getActive(agentId) {
    return this.data.active[agentId];
  }
  setActive(agentId, providerId) {
    this.data.active[agentId] = providerId;
    this.save();
  }
  listBackups(limit = 20) {
    const dir2 = this.getBackupDir();
    if (!(0, import_fs.existsSync)(dir2)) return [];
    return (0, import_fs.readdirSync)(dir2).map((f) => (0, import_path.join)(dir2, f)).sort((a, b) => a > b ? -1 : 1).slice(0, limit);
  }
};

// src/main/agents.ts
function platformConfigPaths(paths) {
  const p = process.platform;
  if (paths[p]) return paths[p];
  return paths["default"] || [];
}
var codegeexAgent = {
  id: "codegeex-vscode",
  name: "CodeGeeX (VSCode \u63D2\u4EF6)",
  description: "\u667A\u8C31 CodeGeeX \u63D2\u4EF6\uFF0C\u901A\u8FC7 VSCode settings.json \u7684 codegeex.* \u6241\u5E73\u952E\u63A5\u5165\u4EFB\u610F OpenAI \u517C\u5BB9 API",
  configPaths: platformConfigPaths({
    win32: ["{appdata}/Code/User/settings.json"],
    darwin: ["{home}/Library/Application Support/Code/User/settings.json", "{appdata}/Code/User/settings.json"],
    default: ["{config}/Code/User/settings.json", "{home}/.config/Code/User/settings.json"]
  }),
  fields: [
    { name: "baseUrl", jsonPath: "codegeex.apiBase", flat: true, source: "baseUrl" },
    { name: "apiKey", jsonPath: "codegeex.apiKey", flat: true, source: "apiKey" },
    { name: "modelName", jsonPath: "codegeex.model", flat: true, source: "modelName" }
  ],
  detection: "first"
};
var genericCliAgent = {
  id: "generic-cli",
  name: "\u901A\u7528 CLI Agent\uFF08JSON \u7EA6\u5B9A\uFF09",
  description: "\u9762\u5411\u4EE5 config.json + api_base/api_key/model \u4E3A\u7EA6\u5B9A\u7684\u56FD\u4EA7 CLI agent\uFF0C\u5C5E\u8BD5\u914D\u7528\u7684\u515C\u5E95\u9002\u914D\u5668",
  configPaths: [
    "{config}/agent-switch-cn/custom.json",
    "{home}/.agent-switch-cn/custom.json"
  ],
  fields: [
    { name: "baseUrl", jsonPath: "api_base", tomlPath: "api_base", source: "baseUrl" },
    { name: "apiKey", jsonPath: "api_key", tomlPath: "api_key", source: "apiKey" },
    { name: "modelName", jsonPath: "model", tomlPath: "model", source: "modelName" }
  ],
  detection: "first"
};
var AGENT_REGISTRY = [codegeexAgent, genericCliAgent];
function getAgentDef(id) {
  return AGENT_REGISTRY.find((a) => a.id === id);
}

// src/main/fsutil.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_os = require("os");
function readJson(file) {
  const raw = (0, import_fs2.readFileSync)(file, "utf-8");
  return JSON.parse(raw);
}
function writeJson(file, data) {
  (0, import_fs2.mkdirSync)((0, import_path2.dirname)(file), { recursive: true });
  (0, import_fs2.writeFileSync)(file, JSON.stringify(data, null, 2), "utf-8");
}
function readTomlFlat(file) {
  const raw = (0, import_fs2.readFileSync)(file, "utf-8");
  const result = {};
  let section = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = stripTomlQuotes(value);
    const fullKey = section ? `${section}.${key}` : key;
    result[fullKey] = value;
  }
  return result;
}
function writeTomlFlat(file, data) {
  const sections = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(data)) {
    const dot = key.indexOf(".");
    if (dot > 0) {
      const sec = key.slice(0, dot);
      const k = key.slice(dot + 1);
      if (!sections.has(sec)) sections.set(sec, {});
      sections.get(sec)[k] = value;
    } else {
      if (!sections.has("")) sections.set("", {});
      sections.get("")[key] = value;
    }
  }
  const lines = [];
  for (const [sec, kv] of sections) {
    if (sec) {
      lines.push("");
      lines.push(`[${sec}]`);
    }
    for (const [k, v] of Object.entries(kv)) {
      lines.push(`${k} = ${quoteToml(v)}`);
    }
  }
  (0, import_fs2.mkdirSync)((0, import_path2.dirname)(file), { recursive: true });
  (0, import_fs2.writeFileSync)(file, lines.join("\n") + "\n", "utf-8");
}
function stripTomlQuotes(v) {
  if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}
function quoteToml(v) {
  if (/^-?\d+$/.test(v) || /^-?\d+\.\d+$/.test(v) || v === "true" || v === "false") {
    return v;
  }
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function backupFile(file, storeDir) {
  if (!(0, import_fs2.existsSync)(file)) throw new Error(`\u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728: ${file}`);
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const base = `${(0, import_path2.dirname)(file).replace(/[\\/:]/g, "_")}_${file.split(/[\\/]/).pop()}`;
  const backupPath = (0, import_path2.join)(storeDir, "backups", `${base}.${ts}`);
  (0, import_fs2.mkdirSync)((0, import_path2.dirname)(backupPath), { recursive: true });
  (0, import_fs2.copyFileSync)(file, backupPath);
  return backupPath;
}
function getByPath(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return void 0;
    cur = cur[key];
  }
  return cur;
}
function setByPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== "object" || cur[k] === null) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return (0, import_path2.join)(home, p.slice(2));
  }
  return p;
}
function resolveTmpl(tmpl) {
  const home = (0, import_os.homedir)();
  const appdata = process.env.APPDATA || (0, import_path2.join)(home, ".config");
  const config = process.platform === "win32" ? (0, import_path2.join)(home, "AppData", "Roaming") : process.env.XDG_CONFIG_HOME || (0, import_path2.join)(home, ".config");
  let out = tmpl;
  out = out.replace(/{appdata}/g, appdata);
  out = out.replace(/{config}/g, config);
  out = out.replace(/{home}/g, home);
  out = expandHome(out, home);
  return out;
}
function detectFormat(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".toml") || lower.endsWith(".tml")) return "toml";
  return "json";
}
function fileExists(p) {
  return (0, import_fs2.existsSync)(p);
}

// src/main/AgentService.ts
var AgentService = class {
  constructor(store) {
    this.store = store;
  }
  listAgents() {
    return AGENT_REGISTRY;
  }
  /** 探测每个内置 agent 实际命中的配置文件 */
  detectAgents() {
    const instances = [];
    for (const def of AGENT_REGISTRY) {
      const resolvedPaths = def.configPaths.map((t) => resolveTmpl(t));
      if (def.detection === "first") {
        const hit = resolvedPaths.find((p) => fileExists(p));
        instances.push(this.toInstance(def, hit ?? resolvedPaths[0], hit != null));
      } else {
        for (const p of resolvedPaths) {
          if (fileExists(p)) instances.push(this.toInstance(def, p, true));
        }
      }
    }
    return instances;
  }
  toInstance(def, file, exists) {
    return {
      agentId: def.id,
      agentName: def.name,
      configFilePath: file,
      format: detectFormat(file),
      exists
    };
  }
  /** 根据字段定义从 provider 取值（可空） */
  fieldValue(f, provider) {
    switch (f.source) {
      case "baseUrl":
        return provider.baseUrl;
      case "apiKey":
        return provider.apiKey;
      case "modelName":
        return provider.modelName || null;
      case "const":
        return f.value ?? null;
      case "header:":
        return provider.headers?.[f.name.replace(/^header:/, "")] ?? null;
      default:
        return null;
    }
  }
  /** 将 provider 写入 agent 配置文件 */
  writeProviderToConfig(def, file, provider) {
    const format = detectFormat(file);
    if (format === "toml") {
      const data = fileExists(file) ? readTomlFlat(file) : {};
      for (const f of def.fields) {
        const key = f.tomlPath || f.name;
        const value = this.fieldValue(f, provider);
        if (value != null) data[key] = value;
      }
      writeTomlFlat(file, data);
    } else {
      const data = fileExists(file) ? readJson(file) : {};
      for (const f of def.fields) {
        const path = f.jsonPath;
        if (!path) continue;
        const value = this.fieldValue(f, provider);
        if (value != null) {
          if (f.flat) data[path] = value;
          else setByPath(data, path, value);
        }
      }
      writeJson(file, data);
    }
  }
  /** 检测 agent 当前是否已指向某个已配置的 provider */
  readStatus(instance) {
    const def = getAgentDef(instance.agentId);
    if (!def || !instance.exists) return { configured: false };
    try {
      const values = {};
      if (instance.format === "toml") {
        const data = readTomlFlat(instance.configFilePath);
        for (const f of def.fields) {
          const key = f.tomlPath || f.name;
          values[f.source] = data[key];
        }
      } else {
        const data = readJson(instance.configFilePath);
        for (const f of def.fields) {
          if (f.jsonPath) {
            const v = f.flat ? data[f.jsonPath] : getByPath(data, f.jsonPath);
            if (v !== void 0) values[f.source] = v;
          }
        }
      }
      const baseVal = values["baseUrl"];
      const providerName = this.store.listProviders().find((p) => normalizedBase(p.baseUrl) === normalizedBase(String(baseVal ?? "")));
      return {
        configured: baseVal != null && String(baseVal).length > 0,
        providerName: providerName ? providerName.name : void 0,
        modelName: values["modelName"] != null ? String(values["modelName"]) : void 0
      };
    } catch {
      return { configured: false };
    }
  }
  /** 切换 agent 到指定 provider，切换前自动备份 */
  switch(agentId, providerId) {
    const def = getAgentDef(agentId);
    const provider = this.store.getProvider(providerId);
    if (!def) return { ok: false, message: `\u672A\u77E5 agent: ${agentId}` };
    if (!provider) return { ok: false, message: `\u672A\u77E5 provider: ${providerId}` };
    const instance = this.detectAgents().find((i) => i.agentId === agentId);
    if (!instance) return { ok: false, message: "\u672A\u627E\u5230 agent \u914D\u7F6E" };
    try {
      let backupPath;
      if (instance.exists) {
        backupPath = backupFile(instance.configFilePath, this.store.getBackupDir());
      }
      this.writeProviderToConfig(def, instance.configFilePath, provider);
      this.store.setActive(agentId, providerId);
      return { ok: true, message: `\u5DF2\u5207\u6362 ${def.name} \u2192 ${provider.name}`, backupPath };
    } catch (e) {
      return { ok: false, message: `\u5207\u6362\u5931\u8D25: ${e.message}` };
    }
  }
};
function normalizedBase(url) {
  return url.trim().replace(/\/+$/, "");
}

// test/flow.test.ts
var dir = (0, import_path3.join)((0, import_os2.tmpdir)(), `asc-test-${Date.now()}`);
(0, import_fs3.mkdirSync)(dir, { recursive: true });
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("OK:", msg);
}
try {
  const store = new Store(dir);
  const provider = {
    id: "p1",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test-123",
    modelName: "deepseek-chat",
    createdAt: 1,
    updatedAt: 2
  };
  store.upsertProvider(provider);
  assert(store.listProviders().length === 1, "Store \u65B0\u589E provider");
  assert(store.getProvider("p1")?.name === "DeepSeek", "Store \u8BFB\u53D6 provider");
  const svc = new AgentService(store);
  const anySvc = svc;
  const jsonFile = (0, import_path3.join)(dir, "settings.json");
  (0, import_fs3.writeFileSync)(jsonFile, JSON.stringify({ "editor.lineNumbers": "on" }), "utf-8");
  anySvc.writeProviderToConfig(codegeexAgent, jsonFile, provider);
  const json = JSON.parse((0, import_fs3.readFileSync)(jsonFile, "utf-8"));
  assert(json["codegeex.apiBase"] === "https://api.deepseek.com", "JSON \u5199\u5165 codegeex.apiBase");
  assert(json["codegeex.apiKey"] === "sk-test-123", "JSON \u5199\u5165 codegeex.apiKey");
  assert(json["codegeex.model"] === "deepseek-chat", "JSON \u5199\u5165 codegeex.model");
  assert(json["editor.lineNumbers"] === "on", "\u4FDD\u7559\u539F\u6709\u65E0\u5173\u914D\u7F6E");
  const tomlFile = (0, import_path3.join)(dir, "config.toml");
  (0, import_fs3.writeFileSync)(tomlFile, '[general]\nname = "foo"\n', "utf-8");
  anySvc.writeProviderToConfig(genericCliAgent, tomlFile, provider);
  const toml = (0, import_fs3.readFileSync)(tomlFile, "utf-8");
  assert(toml.includes('api_base = "https://api.deepseek.com"'), "TOML \u5199\u5165 api_base");
  assert(toml.includes('api_key = "sk-test-123"'), "TOML \u5199\u5165 api_key");
  assert(toml.includes("[general]"), "TOML \u4FDD\u7559\u539F section");
  console.log("\nALL PASSED");
} finally {
  (0, import_fs3.rmSync)(dir, { recursive: true, force: true });
}
