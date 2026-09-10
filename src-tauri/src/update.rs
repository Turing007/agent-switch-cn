use crate::urlguard::{assert_public_http_url, http_client};
use serde_json::Value;
use std::time::Duration;

/// 带一次重试的 GET：掩盖 raw.githubusercontent 等源的偶发网络抖动。
async fn get_with_retry(
    client: &reqwest::Client,
    url: &str,
    accept: &str,
) -> Result<reqwest::Response, String> {
    let mut last_err = String::new();
    for attempt in 0..2 {
        match client.get(url).header("Accept", accept).send().await {
            Ok(r) => return Ok(r),
            Err(e) => last_err = e.to_string(),
        }
        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
    }
    Err(last_err)
}

/// 调 OpenAI 兼容 /models 接口拉取可用模型 id 列表。
/// 出站前经 assert_public_http_url 校验，且禁用重定向。
pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/');
    let url_s = if base.ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    };
    let url = assert_public_http_url(&url_s).await?;
    let client = http_client(15)?;
    let mut req = client.get(url.as_str()).header("Accept", "application/json");
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let res = get_with_retry(&client, url.as_str(), "application/json")
        .await
        .map_err(|e| format!("拉取失败: {e}"))?;
    let status = res.status();
    if status.as_u16() >= 300 && status.as_u16() < 400 {
        return Err("接口返回重定向，已拒绝（仅允许直连清单地址）".into());
    }
    if !status.is_success() {
        let body: String = res.text().await.unwrap_or_default();
        let head = body.chars().take(200).collect::<String>();
        return Err(format!("拉取失败 HTTP {}: {head}", status.as_u16()));
    }
    let json: Value = res.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    let ids: Vec<String> = json
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id"))
                .filter_map(|id| id.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    Ok(ids)
}

/// 比较两个语义化版本号；带预发布后缀的低于同等数值的正式版。
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> (Vec<u64>, Option<String>) {
        let s = v.trim().trim_start_matches(['v', 'V']);
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (s, None),
        };
        let nums = core
            .split('.')
            .map(|n| n.parse::<u64>().unwrap_or(0))
            .collect();
        (nums, pre)
    }
    use std::cmp::Ordering;
    let (na, pa) = parse(a);
    let (nb, pb) = parse(b);
    let len = na.len().max(nb.len());
    for i in 0..len {
        let x = na.get(i).copied().unwrap_or(0);
        let y = nb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    match (pa.is_some(), pb.is_some()) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// 发布者可在此填写更新清单地址；也可通过环境变量
/// AGENT_SWITCH_UPDATE_URL 或 userData/update-url.txt 覆盖。
pub const UPDATE_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/Turing007/agent-switch-cn/master/latest.json";

/// 读取更新清单并比较版本；所有失败都以 message 说明，不抛异常。
pub async fn check_for_update(data_dir: &std::path::Path, current_version: &str) -> UpdateCheckResult {
    let base = |message: String, error: bool| UpdateCheckResult {
        has_update: false,
        current: current_version.to_string(),
        latest: None,
        url: None,
        notes: None,
        message,
        error: Some(error),
    };
    let mut raw = UPDATE_MANIFEST_URL.to_string();
    if raw.is_empty() {
        raw = std::env::var("AGENT_SWITCH_UPDATE_URL").unwrap_or_default();
    }
    if raw.is_empty() {
        raw = std::fs::read(data_dir.join("update-url.txt"))
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .unwrap_or_default();
    }
    if raw.is_empty() {
        return base(
            "未配置更新服务器：请在 src-tauri/src/update.rs 填写 UPDATE_MANIFEST_URL，或将清单地址写入 userData/update-url.txt".into(),
            false,
        );
    }
    let url = match assert_public_http_url(&raw).await {
        Ok(u) => u,
        Err(e) => return base(format!("检查更新失败: {e}"), true),
    };
    let client = match http_client(10) {
        Ok(c) => c,
        Err(e) => return base(format!("检查更新失败: {e}"), true),
    };
    let res = match get_with_retry(&client, url.as_str(), "application/json").await {
        Ok(r) => r,
        Err(e) => return base(format!("检查更新失败: {e}"), true),
    };
    let status = res.status().as_u16();
    if (300..400).contains(&status) {
        return base("更新服务器返回重定向，已拒绝（仅允许直连清单地址）".into(), true);
    }
    if !(200..300).contains(&status) {
        return base(format!("更新服务器返回 HTTP {status}"), true);
    }
    let manifest: Value = match res.json().await {
        Ok(m) => m,
        Err(e) => return base(format!("解析更新清单失败: {e}"), true),
    };
    let Some(latest) = manifest.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
        return base("更新清单格式无效（缺少 version 字段）".into(), true);
    };
    if latest.trim().is_empty() {
        return base("更新清单格式无效（缺少 version 字段）".into(), true);
    }
    let has_update = compare_versions(&latest, current_version) == std::cmp::Ordering::Greater;
    let url = manifest
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let notes = manifest
        .get("notes")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let message = if has_update {
        format!("发现新版本 v{latest}（当前 v{current_version}）")
    } else {
        format!("已是最新版本（v{current_version}）")
    };
    UpdateCheckResult {
        has_update,
        current: current_version.to_string(),
        latest: Some(latest),
        url,
        notes,
        message,
        error: Some(false),
    }
}
