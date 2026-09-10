use serde::{Deserialize, Serialize};

/// 内置 Agent 适配器注册表（与 Electron 版 agents.ts 同构，数据驱动）。
/// 结构特殊的 agent（ZCode 整块 provider 写入）在 agent_service 中按 id 分派。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    File,
    Cdp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentField {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toml_path: Option<String>,
    /// baseUrl | apiKey | modelName | const | header:xxx
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flat: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct AgentDef {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub config_paths: Vec<&'static str>,
    pub fields: Vec<AgentField>,
    pub kind: AgentKind,
    /// ZCode 需要整块 provider 写入/读取
    pub custom_zcode: bool,
}

pub const ZCODE_PROVIDER_PREFIX: &str = "agent-switch:";

pub fn zcode_kind(base_url: &str) -> &'static str {
    if base_url.contains("anthropic") || base_url.contains("#fh") {
        "anthropic"
    } else {
        "openai-compatible"
    }
}

pub fn codegeex_agent() -> AgentDef {
    AgentDef {
        id: "codegeex-vscode",
        name: "CodeGeeX (VSCode 插件)",
        description: "智谱 CodeGeeX 插件，通过 VSCode settings.json 的 codegeex.* 扁平键接入任意 OpenAI 兼容 API",
        config_paths: vec!["{appdata}/Code/User/settings.json"],
        fields: vec![
            AgentField {
                name: "baseUrl".into(),
                json_path: Some("codegeex.apiBase".into()),
                toml_path: None,
                source: "baseUrl".into(),
                value: None,
                flat: Some(true),
            },
            AgentField {
                name: "apiKey".into(),
                json_path: Some("codegeex.apiKey".into()),
                toml_path: None,
                source: "apiKey".into(),
                value: None,
                flat: Some(true),
            },
            AgentField {
                name: "modelName".into(),
                json_path: Some("codegeex.model".into()),
                toml_path: None,
                source: "modelName".into(),
                value: None,
                flat: Some(true),
            },
        ],
        kind: AgentKind::File,
        custom_zcode: false,
    }
}

pub fn generic_cli_agent() -> AgentDef {
    AgentDef {
        id: "generic-cli",
        name: "通用 CLI Agent（JSON 约定）",
        description: "面向以 config.json + api_base/api_key/model 为约定的国产 CLI agent，属试配用的兜底适配器",
        config_paths: vec!["{config}/agent-switch-cn/custom.json", "{home}/.agent-switch-cn/custom.json"],
        fields: vec![
            AgentField {
                name: "baseUrl".into(),
                json_path: Some("api_base".into()),
                toml_path: Some("api_base".into()),
                source: "baseUrl".into(),
                value: None,
                flat: None,
            },
            AgentField {
                name: "apiKey".into(),
                json_path: Some("api_key".into()),
                toml_path: Some("api_key".into()),
                source: "apiKey".into(),
                value: None,
                flat: None,
            },
            AgentField {
                name: "modelName".into(),
                json_path: Some("model".into()),
                toml_path: Some("model".into()),
                source: "modelName".into(),
                value: None,
                flat: None,
            },
        ],
        kind: AgentKind::File,
        custom_zcode: false,
    }
}

pub fn zcode_agent() -> AgentDef {
    AgentDef {
        id: "zcode",
        name: "ZCode (Z.ai 桌面 Agent)",
        description: "智谱 ZCode，通过改写 ~/.zcode/v2/config.json 的 provider 区块接入任意 API（非破坏性写入）",
        config_paths: vec!["{home}/.zcode/v2/config.json"],
        fields: vec![],
        kind: AgentKind::File,
        custom_zcode: true,
    }
}

pub fn trae_agent() -> AgentDef {
    AgentDef {
        id: "trae",
        name: "Trae (桌面版)",
        description: "通过 Chrome DevTools Protocol 驱动 Trae 桌面版的模型选择器（需以调试模式运行）",
        config_paths: vec!["{home}/.trae/.keep"],
        fields: vec![],
        kind: AgentKind::Cdp,
        custom_zcode: false,
    }
}

pub fn agent_registry() -> Vec<AgentDef> {
    vec![
        codegeex_agent(),
        zcode_agent(),
        trae_agent(),
        generic_cli_agent(),
    ]
}

pub fn get_agent_def(id: &str) -> Option<AgentDef> {
    agent_registry().into_iter().find(|a| a.id == id)
}
