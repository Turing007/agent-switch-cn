use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 与 Electron 版 config.json 完全同构的数据层，保证用户数据无缝沿用。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct StoreData {
    pub providers: Vec<Provider>,
    pub active: HashMap<String, String>,
}

pub struct Store {
    path: PathBuf,
    pub data: StoreData,
}

impl Store {
    pub fn load(dir: &Path) -> Store {
        let path = dir.join("config.json");
        let data = fs::read(&path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<StoreData>(&raw).ok())
            .unwrap_or_default();
        Store { path, data }
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.path.parent().unwrap_or(Path::new(".")).join("backups")
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        fs::write(&self.path, json).map_err(|e| e.to_string())
    }

    pub fn list_providers(&self) -> Vec<Provider> {
        self.data.providers.clone()
    }

    pub fn get_provider(&self, id: &str) -> Option<Provider> {
        self.data.providers.iter().find(|p| p.id == id).cloned()
    }

    pub fn upsert_provider(&mut self, p: Provider) -> Result<(), String> {
        if let Some(slot) = self.data.providers.iter_mut().find(|x| x.id == p.id) {
            *slot = p;
        } else {
            self.data.providers.push(p);
        }
        self.save()
    }

    pub fn delete_provider(&mut self, id: &str) -> Result<(), String> {
        self.data.providers.retain(|p| p.id != id);
        self.data.active.retain(|_, v| v != id);
        self.save()
    }

    pub fn get_active(&self, agent_id: &str) -> Option<String> {
        self.data.active.get(agent_id).cloned()
    }

    pub fn set_active(&mut self, agent_id: &str, provider_id: &str) -> Result<(), String> {
        self.data
            .active
            .insert(agent_id.to_string(), provider_id.to_string());
        self.save()
    }

    pub fn list_backups(&self, limit: usize) -> Vec<String> {
        let dir = self.backup_dir();
        let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        entries.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        entries
            .into_iter()
            .take(limit)
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    }
}
