use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// 简单工具：读写 JSON / TOML 配置文件，支持备份（与 Electron 版 fsutil 语义一致）。

pub fn read_json(file: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(file).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn write_json(file: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(file, pretty).map_err(|e| e.to_string())
}

pub fn file_exists(p: &Path) -> bool {
    p.exists()
}

/// TOML 极简解析：仅支持扁平 `key = value` 与 `[section]`，值为字符串。
pub fn read_toml_flat(file: &Path) -> Result<std::collections::HashMap<String, String>, String> {
    let raw = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut result = std::collections::HashMap::new();
    let mut section = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].trim().to_string();
            continue;
        }
        let eq = match trimmed.find('=') {
            Some(i) if i > 0 => i,
            _ => continue,
        };
        let key = trimmed[..eq].trim().to_string();
        let value = strip_toml_quotes(trimmed[eq + 1..].trim());
        let full_key = if section.is_empty() {
            key
        } else {
            format!("{section}.{key}")
        };
        result.insert(full_key, value);
    }
    Ok(result)
}

pub fn write_toml_flat(file: &Path, data: &std::collections::HashMap<String, String>) -> Result<(), String> {
    // 按 section 分组，重写为规范 TOML
    let mut order: Vec<String> = Vec::new();
    let mut sections: std::collections::HashMap<String, Vec<(String, String)>> =
        std::collections::HashMap::new();
    for (key, value) in data {
        let (sec, k) = match key.find('.') {
            Some(i) if i > 0 => (key[..i].to_string(), key[i + 1..].to_string()),
            _ => (String::new(), key.clone()),
        };
        if !sections.contains_key(&sec) {
            order.push(sec.clone());
        }
        sections.entry(sec).or_default().push((k, value.clone()));
    }
    let mut lines: Vec<String> = Vec::new();
    for sec in &order {
        if !sec.is_empty() {
            lines.push(String::new());
            lines.push(format!("[{sec}]"));
        }
        if let Some(kv) = sections.get(sec) {
            for (k, v) in kv {
                lines.push(format!("{k} = {}", quote_toml(v)));
            }
        }
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file, format!("{}\n", lines.join("\n"))).map_err(|e| e.to_string())
}

fn strip_toml_quotes(v: &str) -> String {
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

fn quote_toml(v: &str) -> String {
    let is_number = !v.is_empty()
        && (v.parse::<i64>().is_ok()
            || v.parse::<f64>().is_ok()
            && v.contains('.')
            && !v.contains(|c: char| c.is_alphabetic()));
    if v == "true" || v == "false" || is_number {
        return v.to_string();
    }
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 带时间戳的备份，返回备份文件路径。`backup_dir` 即备份目录本身
pub fn backup_file(file: &Path, backup_dir: &Path) -> Result<PathBuf, String> {
    if !file.exists() {
        return Err(format!("配置文件不存在: {}", file.display()));
    }
    let ts = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S-%3f");
    let dir_name = file
        .parent()
        .map(|p| p.to_string_lossy().replace(['\\', '/', ':'], "_"))
        .unwrap_or_default();
    let file_name = file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
    let backup_path = backup_dir.join(format!("{dir_name}_{file_name}.{ts}"));
    fs::copy(file, &backup_path).map_err(|e| e.to_string())?;
    Ok(backup_path)
}

/// 按点分路径读取嵌套 JSON 值（support.a.b）
pub fn get_by_path<'a>(obj: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = obj;
    for key in path.split('.') {
        cur = cur.get(key)?;
    }
    Some(cur)
}

/// 按点分路径写入嵌套 JSON 值，自动创建中间对象
pub fn set_by_path(obj: &mut Value, path: &str, value: Value) {
    if !obj.is_object() {
        *obj = json!({});
    }
    let keys: Vec<&str> = path.split('.').collect();
    let mut cur = obj;
    for key in &keys[..keys.len() - 1] {
        if !cur.get(*key).map(|v| v.is_object()).unwrap_or(false) {
            cur[*key] = json!({});
        }
        cur = cur.get_mut(*key).unwrap();
    }
    cur[keys[keys.len() - 1]] = value;
}

/// 平台相关路径模板 → 绝对路径：支持 ~、{home}、{appdata}、{config} 占位
pub fn resolve_tmpl(tmpl: &str) -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| String::from("/"));
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
        PathBuf::from(&home)
            .join(".config")
            .to_string_lossy()
            .to_string()
    });
    let config = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
        PathBuf::from(&home)
            .join(".config")
            .to_string_lossy()
            .to_string()
    });
    let out = tmpl
        .replace("{appdata}", &appdata)
        .replace("{config}", &config)
        .replace("{home}", &home);
    if out == "~" {
        return PathBuf::from(&home);
    }
    if let Some(rest) = out.strip_prefix("~/").or_else(|| out.strip_prefix("~\\")) {
        return PathBuf::from(&home).join(rest);
    }
    PathBuf::from(out)
}

pub fn detect_format(file: &Path) -> &'static str {
    let lower = file.to_string_lossy().to_lowercase();
    if lower.ends_with(".toml") || lower.ends_with(".tml") {
        "toml"
    } else {
        "json"
    }
}

/// 便捷读取 JSON 对象（不存在返回空对象）
pub fn read_json_object(file: &Path) -> Map<String, Value> {
    read_json(file)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 备份必须直接落在传入的备份目录里，不能再嵌套一层 backups/
    #[test]
    fn backup_file_writes_into_given_dir() {
        let root = std::env::temp_dir().join("agent-switch-test-backup-path");
        let _ = fs::remove_dir_all(&root);
        let cfg_dir = root.join("cfg");
        fs::create_dir_all(&cfg_dir).unwrap();
        let file = cfg_dir.join("settings.json");
        fs::write(&file, "{}").unwrap();

        let backup_dir = root.join("backups");
        let bp = backup_file(&file, &backup_dir).unwrap();

        assert_eq!(bp.parent().unwrap(), backup_dir);
        assert!(bp.exists());
        assert!(!backup_dir.join("backups").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
