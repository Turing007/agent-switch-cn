use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Trae (TraeWork / Trae CN 桌面版) 的 CDP 自动化驱动（与 Electron 版 trae.ts 语义一致）。
/// Trae 是 Electron(VSCode 分支)，聊天/模型 UI 不对 Windows UIA 开放，
/// 因此必须通过 Chromium DevTools Protocol 驱动 DOM。
/// 前置条件：Trae 需以 `--remote-debugging-port=9333` 运行（或由本应用代为重启）。
///
/// 进程操作安全约定：进程枚举/结束/启动统一通过 tauri-plugin-shell（框架治理通道）；
/// Trae 可执行文件只允许命中本文件内固定白名单候选路径，调试端口固定 9333。

pub const TRAE_DEBUG_PORT: u16 = 9333;
const READ_TIMEOUT: Duration = Duration::from_secs(15);

/// 本机控制通道地址校验：host 固定 127.0.0.1、端口固定 9333（非用户可控输入）。
fn local_cdp_base(port: u16) -> Result<String, String> {
    if port != TRAE_DEBUG_PORT {
        return Err("仅允许使用固定调试端口 9333".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

fn executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local).join("Programs");
        candidates.push(local.join("TRAE SOLO CN").join("TRAE SOLO CN.exe"));
        candidates.push(local.join("Trae CN").join("Trae.exe"));
        candidates.push(local.join("Trae CN").join("Trae CN.exe"));
        candidates.push(local.join("Trae CN").join("Trae Code.exe"));
    }
    candidates
}

pub fn find_trae_executable() -> Option<PathBuf> {
    executable_candidates().into_iter().find(|p| p.exists())
}

/// 是否有 Trae 进程在运行（通过 shell 插件执行只读的 tasklist）
pub async fn is_trae_process_running(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_shell::ShellExt;
    let Ok(out) = app.shell().command("tasklist").output().await else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout).to_uppercase();
    for img in ["TRAE SOLO CN.EXE", "TRAE.EXE", "TRAE CN.EXE", "TRAE CODE.EXE"] {
        if text.contains(img) {
            return true;
        }
    }
    false
}

/// 结束 Trae 进程（字面量参数列表）
async fn kill_trae_processes(app: &tauri::AppHandle) {
    use tauri_plugin_shell::ShellExt;
    for img in ["TRAE SOLO CN.exe", "Trae.exe", "Trae CN.exe", "Trae Code.exe"] {
        let _ = app.shell().command("taskkill").args(["/IM", img, "/F"]).output().await;
    }
}

struct Target {
    ttype: String,
    url: String,
    #[allow(dead_code)]
    title: String,
    ws_url: String,
}

/// 手写极简 HTTP GET（仅访问 127.0.0.1 固定调试端口），返回 JSON 值。
fn http_get_json(url: &str, timeout: Duration) -> Result<Value, String> {
    let rest = url.strip_prefix("http://").ok_or("仅支持 http")?;
    let (hostport, path) = rest.split_once('/').ok_or("URL 缺少路径")?;
    let mut stream = TcpStream::connect(hostport).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let req = format!(
        "GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&buf);
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or(raw.to_string());
    serde_json::from_str(body.trim()).map_err(|e| format!("解析调试目标失败: {e}"))
}

fn fetch_targets(port: u16) -> Vec<Target> {
    let base = match local_cdp_base(port) {
        Ok(b) => b,
        Err(_) => return vec![],
    };
    let json = match http_get_json(&format!("{base}/json/list"), Duration::from_secs(4)) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    json.as_array()
        .map(|arr| {
            arr.iter()
                .filter(|t| t.get("type").is_some())
                .map(|t| Target {
                    ttype: t.get("type").and_then(|v| v.as_str()).unwrap_or("").into(),
                    url: t.get("url").and_then(|v| v.as_str()).unwrap_or("").into(),
                    title: t.get("title").and_then(|v| v.as_str()).unwrap_or("").into(),
                    ws_url: t
                        .get("webSocketDebuggerUrl")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .into(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn is_debug_up(port: u16) -> bool {
    !fetch_targets(port).is_empty()
}

/// 优先 webview（VSCode 工作台），否则工作台/聊天 page
fn pick_target_index(targets: &[Target]) -> usize {
    if let Some(i) = targets.iter().position(|t| t.ttype == "webview") {
        return i;
    }
    targets
        .iter()
        .position(|t| {
            ["workbench", "index.html", "trae", "chat"]
                .iter()
                .any(|kw| t.url.to_lowercase().contains(&kw.to_lowercase()))
        })
        .unwrap_or(0)
}

struct CdpSession {
    ws: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    seq: u64,
}

impl CdpSession {
    fn connect(port: u16) -> Result<CdpSession, String> {
        let targets = fetch_targets(port);
        let target = targets.get(pick_target_index(&targets));
        let target = target.ok_or_else(|| {
            "未发现 Trae 可调试页面，请确认已用 --remote-debugging-port 启动".to_string()
        })?;
        if target.ws_url.is_empty() {
            return Err("无法获取调试 WebSocket 地址".into());
        }
        let (ws, _resp) = tungstenite::client::connect(target.ws_url.as_str())
            .map_err(|e| format!("连接调试端口失败: {e}"))?;
        let mut session = CdpSession { ws, seq: 0 };
        if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = session.ws.get_ref() {
            let _ = tcp.set_read_timeout(Some(READ_TIMEOUT));
            let _ = tcp.set_write_timeout(Some(READ_TIMEOUT));
        }
        session.request("Runtime.enable", None)?;
        session.request("Page.enable", None)?;
        Ok(session)
    }

    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.seq += 1;
        let id = self.seq;
        let mut frame = json!({ "id": id, "method": method });
        if let Some(p) = params {
            frame["params"] = p;
        }
        self.ws
            .send(tungstenite::Message::Text(frame.to_string()))
            .map_err(|e| format!("调试连接已断开: {e}"))?;
        loop {
            let msg = self
                .ws
                .read()
                .map_err(|e| format!("调试连接读取失败: {e}"))?;
            let tungstenite::Message::Text(text) = msg else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("未知调试错误")
                        .to_string());
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let result = self.request(
            "Runtime.evaluate",
            Some(json!({ "expression": expression, "returnByValue": true, "awaitPromise": true })),
        )?;
        if result.get("exceptionDetails").is_some() {
            return Err("页面脚本异常".into());
        }
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    fn dispatch_mouse(&mut self, x: f64, y: f64, mtype: &str) -> Result<(), String> {
        self.request(
            "Input.dispatchMouseEvent",
            Some(json!({
                "type": mtype,
                "x": x.round(),
                "y": y.round(),
                "button": "left",
                "clickCount": 1
            })),
        )
        .map(|_| ())
    }
}

fn sessions() -> &'static Mutex<HashMap<u16, CdpSession>> {
    static SESS: OnceLock<Mutex<HashMap<u16, CdpSession>>> = OnceLock::new();
    SESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_session<T>(port: u16, f: impl FnOnce(&mut CdpSession) -> Result<T, String>) -> Result<T, String> {
    let mut guard = sessions().lock().map_err(|_| "会话锁异常".to_string())?;
    if !guard.contains_key(&port) {
        guard.insert(port, CdpSession::connect(port)?);
    }
    f(guard.get_mut(&port).unwrap())
}

#[allow(dead_code)]
pub fn disconnect(port: u16) {
    if let Ok(mut guard) = sessions().lock() {
        guard.remove(&port);
    }
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

// ===== 状态探测 =====

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraePreflight {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    pub running: bool,
    pub debug_up: bool,
    pub message: String,
}

pub async fn preflight(app: &tauri::AppHandle) -> TraePreflight {
    let port = TRAE_DEBUG_PORT;
    let executable = find_trae_executable().map(|p| p.to_string_lossy().to_string());
    let debug_up = is_debug_up(port);
    let running = is_trae_process_running(app).await;
    let message = if debug_up {
        "Trae 已以调试模式运行，可直接切换。".to_string()
    } else if running {
        "Trae 正在运行但未开调试端口。切换时将先退出 Trae，再以调试模式重启。".to_string()
    } else {
        "Trae 未在运行，切换时将自动以调试模式启动。".to_string()
    };
    TraePreflight { executable, running, debug_up, message }
}

/// 读取当前聊天模型选择器上的模型文本（尽量）
pub fn read_current_model_sync(port: u16) -> Result<Vec<String>, String> {
    let raw = with_session(port, |s| {
        s.evaluate(
            "(() => { const texts = Array.from(document.querySelectorAll('*')).filter(e => e.children.length === 0 && e.innerText && e.innerText.trim().length <= 40).map(e => e.innerText.trim()).filter((t, i, a) => a.indexOf(t) === i).slice(-80); return JSON.stringify(texts); })()",
        )
    })?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureResult {
    pub ok: bool,
    pub message: String,
}

/// 一次性接管：以调试模式确保 Trae 就绪。
/// 可执行文件仅允许命中上方固定白名单候选路径（显式校验），杜绝路径注入；
/// 进程结束与启动均通过 tauri-plugin-shell 通道（参数列表形式，不使用 shell 拼接）。
pub async fn ensure_debug_mode(app: &tauri::AppHandle) -> EnsureResult {
    use tauri_plugin_shell::ShellExt;
    if is_debug_up(TRAE_DEBUG_PORT) {
        return EnsureResult { ok: true, message: "调试就绪".into() };
    }
    let candidates = executable_candidates();
    let Some(exe) = candidates.iter().find(|p| p.exists()).cloned() else {
        return EnsureResult {
            ok: false,
            message: "未找到 Trae 可执行文件，请在“设置”中指定路径".into(),
        };
    };
    // 显式白名单校验：路径必须来自固定候选列表
    if !candidates.iter().any(|c| c == &exe) {
        return EnsureResult { ok: false, message: "Trae 路径不在白名单内，已拒绝启动".into() };
    }
    if is_trae_process_running(app).await {
        kill_trae_processes(app).await;
        sleep_ms(1200);
    }
    // 端口为固定常量，参数为列表形式
    let port_arg = format!("--remote-debugging-port={TRAE_DEBUG_PORT}");
    let spawn = app.shell().command(exe.to_string_lossy().to_string()).arg(port_arg).spawn();
    if spawn.is_err() {
        return EnsureResult { ok: false, message: "启动 Trae 失败（进程创建被拒绝）".into() };
    }
    sleep_ms(1500);
    if is_debug_up(TRAE_DEBUG_PORT) {
        return EnsureResult { ok: true, message: "Trae 已以调试模式启动".into() };
    }
    EnsureResult {
        ok: false,
        message: "Trae 已尝试重启，但调试端口未就绪，请稍候重试".into(),
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct Candidate {
    why: String,
    tag: String,
    #[allow(dead_code)]
    cls: String,
    text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOutcome {
    pub ok: bool,
    pub message: String,
}

/// 把聊天面板模型选择器切到目标 provider 对应的模型。
/// 采用「几何定位 + 文本选择」半自动策略；若目标模型未预先存在于 Trae 列表，
/// 返回可操作的诊断信息。
pub async fn switch_to(provider: &crate::store::Provider) -> Result<SwitchOutcome, String> {
    let provider = provider.clone();
    tauri::async_runtime::spawn_blocking(move || switch_to_sync(&provider))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))?
}

fn switch_to_sync(provider: &crate::store::Provider) -> Result<SwitchOutcome, String> {
    let port = TRAE_DEBUG_PORT;
    let Some(model_label) = provider.default_model() else {
        return Ok(SwitchOutcome {
            ok: false,
            message: "Trae 切换需要先填写“模型 ID”".into(),
        });
    };
    let cand_json = with_session(port, |s| {
        s.evaluate(
            r#"(() => {
      const out = [];
      const push = (e, why) => {
        const r = e.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) return;
        out.push({ why, tag: e.tagName, cls: (e.className||'').toString().slice(0,80),
          text: ((e.innerText||'').trim().replace(/\s+/g,' ')).slice(0,60),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      };
      const inp = document.querySelector('textarea[contenteditable], [role="textbox"], textarea, [class*="input"][contenteditable], [class*="composer"] textarea');
      let inputRect = null;
      if (inp) { inputRect = inp.getBoundingClientRect(); push(inp, 'inputbox'); }
      Array.from(document.querySelectorAll('button, [role="button"], [class*="model"], [class*="select"], [class*="toggle"], [aria-haspopup]'))
        .forEach(e => {
          const r = e.getBoundingClientRect();
          if (r.width < 5 || r.height < 5) return;
          const text = (e.innerText||'').trim().replace(/\s+/g,' ');
          const isShort = text.length > 0 && text.length <= 40 && e.children.length <= 2;
          const nearInput = !inputRect || (Math.abs(r.bottom - inputRect.bottom) < 40 && r.left > inputRect.left - 40);
          if (isShort && nearInput) push(e, 'modelish');
        });
      return JSON.stringify(out.slice(-60));
    })()"#,
        )
    })?;
    let candidates: Vec<Candidate> = serde_json::from_str(cand_json.as_str().unwrap_or("[]"))
        .unwrap_or_default();

    let selector = candidates
        .iter()
        .filter(|c| c.why != "inputbox" && !c.text.is_empty() && c.y > 50.0)
        .cloned()
        .max_by_key(|c| (c.x * 1000.0) as i64);

    let Some(selector) = selector else {
        let list = candidates
            .iter()
            .map(|c| format!("  {} {} \"{}\" @{},{}", c.why, c.tag, c.text, c.x, c.y))
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(SwitchOutcome {
            ok: false,
            message: format!(
                "未能自动定位 Trae 的模型选择器。候选元素：\n{list}\n\n提示：请先在 Trae 的设置→模型里手动添加目标模型一次，然后告诉我校准定位。"
            ),
        });
    };

    // 点击模型选择器，展开列表
    let cx = selector.x + selector.w / 2.0;
    let cy = selector.y + selector.h / 2.0;
    with_session(port, |s| {
        s.dispatch_mouse(cx, cy, "press")?;
        s.dispatch_mouse(cx, cy, "release")
    })?;
    sleep_ms(450);

    // 在弹出列表里按文本选择目标模型
    let want = json!(model_label).to_string();
    let picked = with_session(port, |s| {
        s.evaluate(&format!(
            r#"(() => {{
      const want = {want};
      const items = Array.from(document.querySelectorAll('div, li, button, [role="option"], [role="menuitem"]'))
        .map(e => ({{ text: (e.innerText||'').trim().replace(/\s+/g,' '), el: e }}))
        .filter(x => x.text && x.text.length <= 60);
      const hit = items.find(x => x.text === want || x.text.includes(want) || want.includes(x.text));
      if (!hit) return null;
      const r = hit.el.getBoundingClientRect();
      return JSON.stringify({{ x: r.x + r.width/2, y: r.y + r.height/2, text: hit.text }});
    }})()"#
        ))
    })?;
    let pick: Option<(f64, f64, String)> = picked
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| {
            Some((
                v.get("x")?.as_f64()?,
                v.get("y")?.as_f64()?,
                v.get("text")?.as_str()?.to_string(),
            ))
        });
    if let Some((px, py, text)) = pick {
        with_session(port, |s| {
            s.dispatch_mouse(px, py, "press")?;
            s.dispatch_mouse(px, py, "release")
        })?;
        sleep_ms(200);
        return Ok(SwitchOutcome {
            ok: true,
            message: format!("已在 Trae 中选择模型「{text}」"),
        });
    }

    Ok(SwitchOutcome {
        ok: false,
        message: format!(
            "已打开模型列表，但未找到目标模型「{model_label}」。请先在 Trae 设置→模型中手动添加该模型（或告诉我做“自动添加”）。\n\n用于校准：已将模型选择器定位在 {},{}。",
            selector.x.round(),
            selector.y.round()
        ),
    })
}
