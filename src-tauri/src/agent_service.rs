use crate::agents::{agent_registry, get_agent_def, zcode_kind, AgentDef, AgentField, AgentKind, ZCODE_PROVIDER_PREFIX};
use crate::fsutil::{
    backup_file, detect_format, file_exists, get_by_path, read_json, read_json_object, read_toml_flat,
    resolve_tmpl, set_by_path, write_json, write_toml_flat,
};
use crate::store::{Provider, Store};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstance {
    pub agent_id: String,
    pub agent_name: String,
    pub config_file_path: String,
    pub format: String,
    pub exists: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchStatus {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
}

pub struct AgentService<'a> {
    store: &'a Store,
}

fn normalized_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

impl<'a> AgentService<'a> {
    pub fn new(store: &'a Store) -> Self {
        AgentService { store }
    }

    pub fn list_agents(&self) -> Vec<serde_json::Value> {
        agent_registry()
            .iter()
            .map(|d| {
                json!({
                    "id": d.id,
                    "name": d.name,
                    "description": d.description,
                    "configPaths": d.config_paths,
                    "fields": d.fields,
                    "detection": "first",
                    "kind": if d.kind == AgentKind::Cdp { "cdp" } else { "file" }
                })
            })
            .collect()
    }

    pub fn detect_agents(&self) -> Vec<AgentInstance> {
        let mut instances = Vec::new();
        for def in agent_registry() {
            let resolved: Vec<PathBuf> = def.config_paths.iter().map(|t| resolve_tmpl(t)).collect();
            if def.kind == AgentKind::Cdp {
                let exists = crate::trae::find_trae_executable().is_some();
                instances.push(self.to_instance(&def, String::new(), exists));
            } else {
                let hit = resolved.iter().find(|p| file_exists(p));
                let exists = hit.is_some();
                let file = hit
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| resolved[0].to_string_lossy().to_string());
                instances.push(self.to_instance(&def, file, exists));
            }
        }
        instances
    }

    fn to_instance(&self, def: &AgentDef, file: String, exists: bool) -> AgentInstance {
        let format = detect_format(Path::new(&file)).to_string();
        AgentInstance {
            agent_id: def.id.to_string(),
            agent_name: def.name.to_string(),
            config_file_path: file,
            format,
            exists,
        }
    }

    /// 根据字段定义从 provider 取值（可空）
    fn field_value(&self, f: &AgentField, p: &Provider) -> Option<String> {
        match f.source.as_str() {
            "baseUrl" => Some(p.base_url.clone()),
            "apiKey" => Some(p.api_key.clone()),
            "modelName" => p.model_name.clone(),
            "const" => f.value.clone(),
            s if s.starts_with("header:") => {
                let name = s.strip_prefix("header:").unwrap_or(s);
                p.headers.as_ref().and_then(|h| h.get(name).cloned())
            }
            _ => None,
        }
    }

    /// 将 provider 写入 agent 配置文件
    pub fn write_provider_to_config(&self, def: &AgentDef, file: &Path, p: &Provider) -> Result<(), String> {
        if def.custom_zcode {
            return self.zcode_apply(file, p);
        }
        let format = detect_format(file);
        if format == "toml" {
            let mut data = if file_exists(file) {
                read_toml_flat(file)?
            } else {
                Default::default()
            };
            for f in &def.fields {
                let key = f.toml_path.clone().unwrap_or_else(|| f.name.clone());
                if let Some(v) = self.field_value(f, p) {
                    data.insert(key, v);
                }
            }
            write_toml_flat(file, &data)
        } else {
            let mut data = if file_exists(file) {
                read_json(file)?
            } else {
                json!({})
            };
            for f in &def.fields {
                let Some(path) = &f.json_path else { continue };
                if let Some(v) = self.field_value(f, p) {
                    if f.flat.unwrap_or(false) {
                        data[path.as_str()] = json!(v);
                    } else {
                        set_by_path(&mut data, path, json!(v));
                    }
                }
            }
            write_json(file, &data)
        }
    }

    /// ZCode 整块 provider 写入（非破坏性，仅改目标项并停用其余）
    fn zcode_apply(&self, file: &Path, p: &Provider) -> Result<(), String> {
        let mut data = read_json_object(file);
        if !data.get("provider").map(|v| v.is_object()).unwrap_or(false) {
            data.insert("provider".into(), json!({}));
        }
        // 以 owned map 处理，避免借用冲突
        let mut providers = data
            .get("provider")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();

        let target_key = format!("{ZCODE_PROVIDER_PREFIX}{}", p.id);
        for (key, entry) in providers.iter_mut() {
            if key != &target_key {
                if let Some(obj) = entry.as_object_mut() {
                    if obj.contains_key("enabled") {
                        obj.insert("enabled".into(), json!(false));
                    }
                }
            }
        }

        let mut models = Map::new();
        if let Some(model_name) = &p.model_name {
            models.insert(
                model_name.clone(),
                json!({
                    "limit": { "context": 999999, "output": 32000 },
                    "modalities": { "input": ["text", "image"], "output": ["text"] },
                    "zcode": { "modified": true }
                }),
            );
        }

        let mut entry = json!({
            "name": p.name,
            "kind": zcode_kind(&p.base_url),
            "options": {
                "apiKey": p.api_key,
                "baseURL": p.base_url,
                "apiKeyRequired": true
            },
            "enabled": true,
            "source": "custom"
        });
        if !models.is_empty() {
            entry["models"] = Value::Object(models);
        }
        providers.insert(target_key, entry);
        data.insert("provider".into(), Value::Object(providers));
        write_json(file, &Value::Object(data))
    }

    /// ZCode 当前启用 provider 读取
    fn zcode_read_status(&self, file: &Path) -> SwitchStatus {
        if !file_exists(file) {
            return SwitchStatus { configured: false, provider_name: None, model_name: None };
        }
        let data = match read_json(file) {
            Ok(v) => v,
            Err(_) => return SwitchStatus { configured: false, provider_name: None, model_name: None },
        };
        let providers = data.get("provider").and_then(|v| v.as_object()).cloned().unwrap_or_default();
        let entries: Vec<(String, &Value)> = providers
            .iter()
            .filter(|(_, e)| e.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))
            .map(|(k, e)| (k.clone(), e))
            .collect();
        let entry = entries
            .iter()
            .find(|(k, _)| k.starts_with(ZCODE_PROVIDER_PREFIX))
            .or_else(|| entries.first());
        let Some((_, def)) = entry else {
            return SwitchStatus { configured: false, provider_name: None, model_name: None };
        };
        let base = def
            .pointer("/options/baseURL")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let model_name = def
            .get("models")
            .and_then(|m| m.as_object())
            .and_then(|m| m.keys().next().cloned());
        let provider_name = self
            .store
            .list_providers()
            .into_iter()
            .find(|p| normalized_base(&p.base_url) == normalized_base(&base))
            .map(|p| p.name);
        SwitchStatus {
            configured: !base.is_empty(),
            provider_name,
            model_name,
        }
    }

    /// 检测 agent 当前是否已指向某个已配置的 provider
    pub fn read_status(&self, instance: &AgentInstance) -> SwitchStatus {
        let Some(def) = get_agent_def(&instance.agent_id) else {
            return SwitchStatus { configured: false, provider_name: None, model_name: None };
        };
        if !instance.exists {
            return SwitchStatus { configured: false, provider_name: None, model_name: None };
        }
        if def.kind == AgentKind::Cdp {
            let pid = self.store.get_active(def.id);
            let p = pid.as_deref().and_then(|id| self.store.get_provider(id));
            return SwitchStatus {
                configured: p.is_some(),
                provider_name: p.as_ref().map(|p| p.name.clone()),
                model_name: p.as_ref().and_then(|p| p.model_name.clone()),
            };
        }
        if def.custom_zcode {
            return self.zcode_read_status(Path::new(&instance.config_file_path));
        }
        let file = Path::new(&instance.config_file_path);
        let mut values: Map<String, Value> = Map::new();
        let read = if instance.format == "toml" {
            read_toml_flat(file).map(|data| {
                for f in &def.fields {
                    let key = f.toml_path.clone().unwrap_or_else(|| f.name.clone());
                    if let Some(v) = data.get(&key) {
                        values.insert(f.source.clone(), json!(v));
                    }
                }
            })
        } else {
            read_json(file).map(|data| {
                for f in &def.fields {
                    if let Some(path) = &f.json_path {
                        let v = if f.flat.unwrap_or(false) {
                            data.get(path.as_str()).cloned()
                        } else {
                            get_by_path(&data, path).cloned()
                        };
                        if let Some(v) = v {
                            values.insert(f.source.clone(), v);
                        }
                    }
                }
            })
        };
        let Ok(_) = read else {
            return SwitchStatus { configured: false, provider_name: None, model_name: None };
        };
        let base_val = values.get("baseUrl").cloned().unwrap_or(Value::Null);
        let base_str = base_val.as_str().unwrap_or("");
        let provider_name = self
            .store
            .list_providers()
            .into_iter()
            .find(|p| normalized_base(&p.base_url) == normalized_base(base_str))
            .map(|p| p.name);
        SwitchStatus {
            configured: !base_str.is_empty(),
            provider_name,
            model_name: values
                .get("modelName")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        }
    }

    /// 切换 agent 到指定 provider，切换前自动备份
    pub async fn switch(&self, app: &tauri::AppHandle, agent_id: &str, provider_id: &str) -> SwitchResult {
        let Some(def) = get_agent_def(agent_id) else {
            return SwitchResult { ok: false, message: Some(format!("未知 agent: {agent_id}")), backup_path: None };
        };
        let Some(provider) = self.store.get_provider(provider_id) else {
            return SwitchResult { ok: false, message: Some(format!("未知 provider: {provider_id}")), backup_path: None };
        };

        if def.kind == AgentKind::Cdp {
            let pre = crate::trae::ensure_debug_mode(app).await;
            if !pre.ok {
                return SwitchResult { ok: false, message: Some(pre.message), backup_path: None };
            }
            let r = match crate::trae::switch_to(&provider).await {
                Ok(o) => o,
                Err(e) => {
                    return SwitchResult {
                        ok: false,
                        message: Some(format!("Trae 切换失败: {e}")),
                        backup_path: None,
                    }
                }
            };
            if !r.ok {
                return SwitchResult { ok: false, message: Some(r.message), backup_path: None };
            }
            return SwitchResult { ok: true, message: Some(r.message), backup_path: None };
        }

        let instance = self.detect_agents().into_iter().find(|i| i.agent_id == agent_id);
        let Some(instance) = instance else {
            return SwitchResult { ok: false, message: Some("未找到 agent 配置".into()), backup_path: None };
        };
        let file = PathBuf::from(&instance.config_file_path);
        let mut backup_path: Option<String> = None;
        let result = (|| -> Result<(), String> {
            if instance.exists {
                let bp = backup_file(&file, &self.store.backup_dir())?;
                backup_path = Some(bp.to_string_lossy().to_string());
            }
            self.write_provider_to_config(&def, &file, &provider)
        })();
        match result {
            Ok(()) => {
                // active 状态由命令层写回全局 Store（此处 store 为只读借用）
                SwitchResult {
                    ok: true,
                    message: Some(format!("已切换 {} → {}", def.name, provider.name)),
                    backup_path,
                }
            }
            Err(e) => SwitchResult { ok: false, message: Some(format!("切换失败: {e}")), backup_path: None },
        }
    }
}
