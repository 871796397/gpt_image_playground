//! 可选的本地 MCP 服务：让用户自己的 Agent（Claude Code、Codex、Cursor 等）通过 Streamable HTTP 调用应用生图。
//! 默认关闭，只绑定 127.0.0.1，要求 Bearer token，并拒绝带非本机 Origin 的请求（防 DNS 重绑定）。
//! 生图逻辑和历史记录都在前端，所以这里只负责协议：tools/call 通过事件转给主窗口执行，前端用 mcp_respond 回传结果。
//! 设置保存在 meta 表，和代理一样属于本机环境，不进备份
use std::collections::HashMap;
use std::io::Read;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::storage::{Storage, StorageState};

const META_KEY: &str = "mcp";
const DEFAULT_PORT: u16 = 8765;
const MAX_BODY: u64 = 4 * 1024 * 1024;
/// 生图可能要几分钟，超过后向 Agent 返回超时错误；任务本身仍会在应用里继续并进入历史
const CALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const HEARTBEAT_PAD: usize = 8192;
const TOOLS: &str = include_str!("mcp_tools.json");

#[derive(Clone, Serialize, Deserialize)]
struct Setting {
    enabled: bool,
    port: u16,
    token: String,
}

impl Default for Setting {
    fn default() -> Self {
        Setting { enabled: false, port: DEFAULT_PORT, token: String::new() }
    }
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    port: u16,
    token: String,
    running: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct ReplyImage {
    mime: String,
    data: String,
}

#[derive(Deserialize)]
pub struct Reply {
    text: String,
    images: Vec<ReplyImage>,
}

type Pending = Mutex<HashMap<u64, Sender<Result<Reply, String>>>>;

#[derive(Default)]
struct Running {
    server: Option<Arc<Server>>,
    error: Option<String>,
}

/// 托管为 State：当前监听的服务和等待前端回复的调用
#[derive(Default)]
pub struct Mcp {
    running: Mutex<Running>,
    pending: Pending,
    next_id: Mutex<u64>,
}

fn read(storage: &Storage) -> Setting {
    match storage.meta_get(META_KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|err| {
            log::warn!("MCP 设置无法解析，改为默认值：{err}");
            Setting::default()
        }),
        Ok(None) => Setting::default(),
        Err(err) => {
            log::warn!("读取 MCP 设置失败：{err}");
            Setting::default()
        }
    }
}

fn save(storage: &Storage, setting: &Setting) -> Result<(), String> {
    let raw = serde_json::to_string(setting).map_err(|err| err.to_string())?;
    storage.meta_set(META_KEY, &raw).map_err(|err| format!("保存 MCP 设置失败：{}", err.message))
}

fn new_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("系统随机数不可用");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn status(setting: Setting, running: &Running) -> Status {
    Status {
        enabled: setting.enabled,
        port: setting.port,
        token: setting.token,
        running: running.server.is_some(),
        error: running.error.clone(),
    }
}

/// 按设置启动或停止服务；先停掉旧的再启动，端口被占用时记录错误而不是让应用启动失败
fn apply(app: &AppHandle, setting: &Setting) {
    let mcp = app.state::<Mcp>();
    let mut running = mcp.running.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(server) = running.server.take() {
        server.unblock();
    }
    running.error = None;
    if !setting.enabled {
        return;
    }
    match Server::http(("127.0.0.1", setting.port)) {
        Ok(server) => {
            let server = Arc::new(server);
            running.server = Some(server.clone());
            let app = app.clone();
            let token = setting.token.clone();
            std::thread::spawn(move || {
                for request in server.incoming_requests() {
                    let app = app.clone();
                    let token = token.clone();
                    std::thread::spawn(move || handle(&app, &token, request));
                }
            });
        }
        Err(err) => {
            log::warn!("启动 MCP 服务失败：{err}");
            running.error = Some(format!("无法监听 127.0.0.1:{}，端口可能已被占用（{err}）", setting.port));
        }
    }
}

/// 启动时调用：按保存的设置恢复服务，存储不可用时保持关闭
pub fn start_saved(app: &AppHandle) {
    let state = app.state::<StorageState>();
    let Ok(storage) = state.0.as_deref() else {
        return;
    };
    let mut setting = read(storage);
    if setting.enabled && setting.token.is_empty() {
        setting.token = new_token();
        if let Err(err) = save(storage, &setting) {
            log::warn!("{err}");
            return;
        }
    }
    apply(app, &setting);
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_local_origin(origin: &str) -> bool {
    let rest = origin.split("://").nth(1).unwrap_or("");
    let authority = rest.split('/').next().unwrap_or("");
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => authority,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn handle(app: &AppHandle, token: &str, mut request: Request) {
    let header = |name: &str| {
        request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
    };
    let origin = header("Origin");
    let authorization = header("Authorization");
    let accepts_sse = header("Accept").is_some_and(|a| a.contains("text/event-stream"));
    if origin.is_some_and(|origin| !is_local_origin(&origin)) {
        let _ = request.respond(json_response(403, &json!({ "error": "Origin 不被允许" })));
        return;
    }
    let authorized = authorization
        .as_deref()
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|given| constant_time_eq(given.as_bytes(), token.as_bytes()));
    if !authorized {
        let _ = request.respond(json_response(401, &json!({ "error": "缺少或错误的 Bearer token" })));
        return;
    }
    if request.url().split('?').next() != Some("/mcp") {
        let _ = request.respond(json_response(404, &json!({ "error": "只提供 /mcp" })));
        return;
    }
    // 无状态模式：只接受 POST，不提供服务端推送流
    if *request.method() != Method::Post {
        let _ = request.respond(json_response(405, &json!({ "error": "只支持 POST" })));
        return;
    }
    let mut body = Vec::new();
    if request.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        let _ = request.respond(json_response(413, &json!({ "error": "请求体过大或读取失败" })));
        return;
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        let _ = request.respond(json_response(400, &rpc_error(&Value::Null, -32700, "JSON 解析失败")));
        return;
    };
    // 通知（没有 id）不需要响应内容
    let Some(id) = message.get("id").cloned() else {
        let _ = request.respond(Response::empty(202));
        return;
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    // 生图要几分钟：客户端接受 SSE 时用流式响应，期间定时发送进度通知（没有 progressToken 时发注释行），避免客户端或中间层因长时间无数据而超时
    if method == "tools/call" && accepts_sse {
        let app = app.clone();
        let (tx, rx) = mpsc::channel();
        let token = params.pointer("/_meta/progressToken").cloned();
        std::thread::spawn(move || {
            let result = call_tool(&app, &params);
            let _ = tx.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        });
        let headers = vec![
            Header::from_bytes("Content-Type", "text/event-stream").unwrap(),
            Header::from_bytes("Cache-Control", "no-cache").unwrap(),
        ];
        let stream = EventStream { rx, token, ticks: 0, buf: Vec::new(), pos: 0, done: false };
        let _ = request.respond(Response::new(tiny_http::StatusCode(200), headers, stream, None, None));
        return;
    }
    let reply = match method {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-03-26");
            json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "gpt-image-playground", "version": env!("CARGO_PKG_VERSION") },
            } })
        }
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => {
            let tools: Value = serde_json::from_str(TOOLS).unwrap_or(Value::Null);
            json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })
        }
        "tools/call" => json!({ "jsonrpc": "2.0", "id": id, "result": call_tool(app, &params) }),
        _ => rpc_error(&id, -32601, "不支持的方法"),
    };
    let _ = request.respond(json_response(200, &reply));
}

/// tools/call 的 SSE 响应体：等待最终结果期间每 10 秒产出一条心跳，结果到达后写出消息并结束
struct EventStream {
    rx: mpsc::Receiver<Value>,
    token: Option<Value>,
    ticks: u64,
    buf: Vec<u8>,
    pos: usize,
    done: bool,
}

impl Read for EventStream {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            if self.done {
                return Ok(0);
            }
            self.pos = 0;
            self.buf = match self.rx.recv_timeout(Duration::from_secs(10)) {
                Ok(message) => {
                    self.done = true;
                    format!("event: message
data: {message}

").into_bytes()
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.ticks += 1;
                    let mut beat = match &self.token {
                        Some(token) => {
                            let note = json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {
                                "progressToken": token, "progress": self.ticks, "message": "应用正在生成图片" } });
                            format!("event: message
data: {note}

").into_bytes()
                        }
                        None => b": keepalive

".to_vec(),
                    };
                    // tiny_http 内部缓冲约 8KB，不足时心跳会攒到响应结束才发出，用注释行补满使其立即发出
                    beat.extend_from_slice(format!(": {}

", " ".repeat(HEARTBEAT_PAD)).as_bytes());
                    beat
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            };
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn tool_error(text: impl Into<String>) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": text.into() }] })
}

/// 把调用转给主窗口并等待结果；工具执行失败按 MCP 约定以 isError 返回，而不是协议错误
fn call_tool(app: &AppHandle, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let mut arguments = arguments;
    if let Err(message) = resolve_reference_images(&mut arguments) {
        return tool_error(message);
    }
    let mcp = app.state::<Mcp>();
    let id = {
        let mut next = mcp.next_id.lock().unwrap_or_else(|err| err.into_inner());
        *next += 1;
        *next
    };
    let (tx, rx) = mpsc::channel();
    mcp.pending.lock().unwrap_or_else(|err| err.into_inner()).insert(id, tx);
    let sent = app.emit_to("main", "mcp-request", json!({ "id": id, "tool": name, "arguments": arguments }));
    let result = match sent {
        Ok(()) => rx
            .recv_timeout(CALL_TIMEOUT)
            .map_err(|_| "等待应用执行超时，任务可能仍在应用中进行，请到历史记录查看".to_string())
            .and_then(|reply| reply),
        Err(err) => Err(format!("无法联系应用主窗口：{err}")),
    };
    mcp.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&id);
    match result {
        Ok(reply) => build_result(reply, arguments.get("output_dir").and_then(Value::as_str)),
        Err(message) => tool_error(message),
    }
}

/// 参考图可以传本机路径：读成 data URL 再交给前端，前端只处理 data URL
fn resolve_reference_images(arguments: &mut Value) -> Result<(), String> {
    let Some(items) = arguments.get_mut("reference_images").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    if items.len() > 8 {
        return Err("reference_images 最多 8 张".into());
    }
    for item in items {
        let Some(text) = item.as_str().filter(|t| !t.starts_with("data:")) else {
            continue;
        };
        let path = std::path::Path::new(text);
        let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("png") => "image/png",
            _ => return Err(format!("不支持的参考图格式（需要 png/jpg/webp）：{text}")),
        };
        if !path.is_absolute() {
            return Err(format!("参考图路径必须是绝对路径：{text}"));
        }
        let bytes = std::fs::read(path).map_err(|err| format!("读取参考图失败 {text}：{err}"))?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err(format!("参考图超过 20MB：{text}"));
        }
        *item = Value::String(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
    }
    Ok(())
}

/// 图片以 MCP image 内容返回；指定 output_dir 时同时写入文件并在文本中列出路径，方便 Agent 直接引用到工程里
fn build_result(reply: Reply, output_dir: Option<&str>) -> Value {
    let mut text = reply.text;
    if let Some(dir) = output_dir.filter(|d| !d.trim().is_empty()) {
        let dir = std::path::Path::new(dir);
        if !dir.is_absolute() {
            return tool_error("output_dir 必须是绝对路径");
        }
        if let Err(err) = std::fs::create_dir_all(dir) {
            return tool_error(format!("无法创建目录 {}：{err}", dir.display()));
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        for (index, image) in reply.images.iter().enumerate() {
            let ext = match image.mime.as_str() {
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let path = dir.join(format!("gpt-image-{stamp}-{}.{ext}", index + 1));
            let written = base64::engine::general_purpose::STANDARD
                .decode(&image.data)
                .map_err(|err| err.to_string())
                .and_then(|bytes| std::fs::write(&path, bytes).map_err(|err| err.to_string()));
            match written {
                Ok(()) => text.push_str(&format!("\n已保存：{}", path.display())),
                Err(err) => text.push_str(&format!("\n保存 {} 失败：{err}", path.display())),
            }
        }
    }
    let mut content = vec![json!({ "type": "text", "text": text })];
    content.extend(reply.images.into_iter().map(|i| json!({ "type": "image", "data": i.data, "mimeType": i.mime })));
    json!({ "content": content })
}

#[tauri::command]
pub async fn mcp_get(storage: State<'_, StorageState>, mcp: State<'_, Mcp>) -> Result<Status, String> {
    let storage = storage.0.as_deref().map_err(|err| err.message.clone())?;
    let mut setting = tokio::task::block_in_place(|| read(storage));
    if setting.token.is_empty() {
        setting.token = new_token();
        tokio::task::block_in_place(|| save(storage, &setting))?;
    }
    let running = mcp.running.lock().unwrap_or_else(|err| err.into_inner());
    Ok(status(setting, &running))
}

/// 保存设置并立即应用；regenerate_token 为 true 时换新 token，旧 token 马上失效
#[tauri::command]
pub async fn mcp_set(
    app: AppHandle,
    enabled: bool,
    port: u16,
    regenerate_token: bool,
    storage: State<'_, StorageState>,
    mcp: State<'_, Mcp>,
) -> Result<Status, String> {
    if port < 1024 {
        return Err("端口需在 1024–65535 之间".into());
    }
    let storage = storage.0.as_deref().map_err(|err| err.message.clone())?;
    let mut setting = tokio::task::block_in_place(|| read(storage));
    if setting.token.is_empty() || regenerate_token {
        setting.token = new_token();
    }
    setting.enabled = enabled;
    setting.port = port;
    tokio::task::block_in_place(|| save(storage, &setting))?;
    apply(&app, &setting);
    let running = mcp.running.lock().unwrap_or_else(|err| err.into_inner());
    Ok(status(setting, &running))
}

/// 前端执行完 mcp-request 后回传结果；error 非空表示工具执行失败
#[tauri::command]
pub fn mcp_respond(id: u64, result: Option<Reply>, error: Option<String>, mcp: State<'_, Mcp>) {
    let sender = mcp.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(match (result, error) {
            (Some(reply), None) => Ok(reply),
            (_, error) => Err(error.unwrap_or_else(|| "前端未返回结果".into())),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_origins_pass() {
        assert!(is_local_origin("http://localhost:3000"));
        assert!(is_local_origin("http://127.0.0.1"));
        assert!(is_local_origin("http://[::1]:8080"));
        assert!(!is_local_origin("https://evil.example.com"));
        assert!(!is_local_origin("http://127.0.0.1.evil.com:80"));
    }

    #[test]
    fn token_compare_checks_length_and_content() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn tools_json_is_valid() {
        let tools: Value = serde_json::from_str(TOOLS).unwrap();
        assert!(tools.as_array().unwrap().iter().all(|t| t["name"].is_string() && t["inputSchema"].is_object()));
    }
}
