#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_service;
mod agents;
mod fsutil;
mod store;
mod trae;
mod update;
mod urlguard;

use agent_service::{AgentInstance, AgentService, SwitchResult, SwitchStatus};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use store::{Provider, Store};
use tauri::State;
use update::UpdateCheckResult;

/// 应用共享状态：Store + 数据目录。
/// 数据目录隔离（与 Electron 版一致）：安装版用 agent-switch-cn，开发态用 agent-switch-cn-dev。
struct AppState {
    store: Mutex<Store>,
    data_dir: PathBuf,
}

fn data_dir() -> PathBuf {
    let name = if cfg!(debug_assertions) {
        "agent-switch-cn-dev"
    } else {
        "agent-switch-cn"
    };
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| String::from("."));
            PathBuf::from(home).join("AppData").join("Roaming")
        });
    base.join(name)
}

// ---- Provider CRUD ----

#[tauri::command]
fn providers_list(state: State<AppState>) -> Vec<Provider> {
    state.store.lock().unwrap().list_providers()
}

#[tauri::command]
fn providers_save(state: State<AppState>, p: Provider) -> Result<Provider, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut provider = p;
    if provider.id.is_empty() {
        provider.id = uuid();
    }
    provider.name = provider.name.trim().to_string();
    provider.base_url = provider.base_url.trim().to_string();
    provider.api_key = provider.api_key.trim().to_string();
    provider.model_name = provider
        .model_name
        .take()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    provider.website = provider
        .website
        .take()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"));
    if let Some(models) = provider.models.take() {
        let mut seen = std::collections::HashSet::new();
        let cleaned: Vec<String> = models
            .into_iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .filter(|m| seen.insert(m.clone()))
            .take(500)
            .collect();
        provider.models = if cleaned.is_empty() { None } else { Some(cleaned) };
    }
    provider.updated_at = now;
    if provider.created_at == 0 {
        provider.created_at = now;
    }
    state.store.lock().unwrap().upsert_provider(provider.clone())?;
    Ok(provider)
}

#[tauri::command]
fn providers_delete(state: State<AppState>, id: String) -> Result<bool, String> {
    state.store.lock().unwrap().delete_provider(&id)?;
    Ok(true)
}

// ---- 模型拉取 ----

#[tauri::command]
async fn models_fetch(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    update::fetch_models(&base_url, &api_key).await
}

// ---- Agent 探测与切换 ----

#[tauri::command]
fn agents_list(state: State<AppState>) -> Vec<Value> {
    let store = state.store.lock().unwrap();
    AgentService::new(&store).list_agents()
}

#[tauri::command]
fn agents_detect(state: State<AppState>) -> Vec<AgentInstance> {
    let store = state.store.lock().unwrap();
    AgentService::new(&store).detect_agents()
}

#[tauri::command]
fn agents_status(state: State<AppState>, i: AgentInstance) -> SwitchStatus {
    let store = state.store.lock().unwrap();
    AgentService::new(&store).read_status(&i)
}

#[tauri::command]
async fn agents_switch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    provider_id: String,
) -> Result<SwitchResult, String> {
    // 切换可能耗时（CDP / 文件 IO）：使用配置快照，避免跨 await 持锁
    let snapshot = Store::load(&state.data_dir);
    let svc = AgentService::new(&snapshot);
    let result = svc.switch(&app, &agent_id, &provider_id).await;
    if result.ok {
        state
            .store
            .lock()
            .unwrap()
            .set_active(&agent_id, &provider_id)?;
    }
    Ok(result)
}

// ---- 备份 ----

#[tauri::command]
fn backups_list(state: State<AppState>) -> Vec<String> {
    state.store.lock().unwrap().list_backups(20)
}

// ---- 应用工具 ----

#[tauri::command]
async fn app_open_external(url: String) -> Result<bool, String> {
    let u = urlguard::assert_public_http_url(&url).await?;
    open::that(u.as_str()).map_err(|e| format!("打开失败: {e}"))?;
    Ok(true)
}

#[tauri::command]
fn app_copy_text(text: String) -> bool {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if cb.set_text(text).is_ok() {
            return true;
        }
    }
    false
}

#[tauri::command]
async fn app_check_update(state: State<'_, AppState>) -> Result<UpdateCheckResult, String> {
    let dir = state.data_dir.clone();
    let current = app_version().to_string();
    Ok(update::check_for_update(&dir, &current).await)
}

fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn uuid() -> String {
    // 简易 UUID v4：来自进程随机源
    let mut buf = [0u8; 16];
    getrandom_fallback(&mut buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    let h = buf.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn getrandom_fallback(buf: &mut [u8]) {
    // 用系统时间 + 地址熵的简单混合；仅用于本地标识，无安全要求
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut seed = t as u64 ^ (buf.as_ptr() as u64);
    for b in buf.iter_mut() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *b = (seed >> 33) as u8;
    }
}

// ---- Trae ----

#[tauri::command]
async fn trae_preflight(app: tauri::AppHandle) -> trae::TraePreflight {
    trae::preflight(&app).await
}

#[tauri::command]
async fn trae_read_model() -> Result<serde_json::Value, String> {
    let models = tauri::async_runtime::spawn_blocking(|| trae::read_current_model_sync(trae::TRAE_DEBUG_PORT))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))??;
    Ok(serde_json::json!({ "candidates": models }))
}

fn main() {
    let dir = data_dir();
    let store = store::Store::load(&dir);
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            store: Mutex::new(store),
            data_dir: dir,
        })
        .invoke_handler(tauri::generate_handler![
            providers_list,
            providers_save,
            providers_delete,
            models_fetch,
            agents_list,
            agents_detect,
            agents_status,
            agents_switch,
            backups_list,
            app_open_external,
            app_copy_text,
            app_check_update,
            trae_preflight,
            trae_read_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
