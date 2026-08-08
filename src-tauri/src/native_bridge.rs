// 1 HTTP loopback server (127.0.0.1, port ephemeral) do Rust sở hữu, sidecar Node gọi vào để làm
// những việc chỉ Rust làm được (OS keychain, đăng ký autostart) — thiết kế "keychain bridge" đã
// chốt trong plan k8sql, mở rộng thêm route /autostart cho tính năng "Khởi động cùng hệ thống".
// Token xác thực random/session, truyền cho sidecar qua CLI arg lúc spawn — không ghi đĩa.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

const KEYCHAIN_SERVICE_NAME: &str = "k8sql";

struct BridgeState {
    app: AppHandle,
    token: String,
}

pub struct NativeBridge {
    pub port: u16,
    pub token: String,
}

pub async fn start(app: AppHandle) -> Result<NativeBridge, String> {
    let token = generate_token();
    let state = Arc::new(BridgeState { app, token: token.clone() });

    let router = Router::new()
        .route(
            "/secret/:secret_ref",
            get(get_secret).put(put_secret).delete(delete_secret),
        )
        .route("/autostart", get(get_autostart).post(post_autostart))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Không bind được native bridge: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Không đọc được port native bridge: {e}"))?
        .port();

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[k8sql] native bridge lỗi: {e}");
        }
    });

    Ok(NativeBridge { port, token })
}

fn generate_token() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

async fn auth_middleware(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let expected = format!("Bearer {}", state.token);
    match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some(v) if v == expected => next.run(request).await,
        _ => (StatusCode::FORBIDDEN, "invalid or missing bearer token").into_response(),
    }
}

#[derive(Serialize)]
struct SecretResponse {
    value: Option<String>,
}

#[derive(Deserialize)]
struct SetSecretBody {
    value: String,
}

async fn get_secret(Path(secret_ref): Path<String>) -> Response {
    match keyring::Entry::new(KEYCHAIN_SERVICE_NAME, &secret_ref) {
        Ok(entry) => match entry.get_password() {
            Ok(v) => Json(SecretResponse { value: Some(v) }).into_response(),
            Err(keyring::Error::NoEntry) => Json(SecretResponse { value: None }).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn put_secret(Path(secret_ref): Path<String>, Json(body): Json<SetSecretBody>) -> Response {
    match keyring::Entry::new(KEYCHAIN_SERVICE_NAME, &secret_ref) {
        Ok(entry) => match entry.set_password(&body.value) {
            Ok(_) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn delete_secret(Path(secret_ref): Path<String>) -> Response {
    match keyring::Entry::new(KEYCHAIN_SERVICE_NAME, &secret_ref) {
        Ok(entry) => match entry.delete_credential() {
            Ok(_) => StatusCode::NO_CONTENT.into_response(),
            Err(keyring::Error::NoEntry) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Serialize)]
struct AutostartResponse {
    enabled: bool,
}

#[derive(Deserialize)]
struct SetAutostartBody {
    enabled: bool,
}

async fn get_autostart(State(state): State<Arc<BridgeState>>) -> Response {
    match state.app.autolaunch().is_enabled() {
        Ok(enabled) => Json(AutostartResponse { enabled }).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn post_autostart(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<SetAutostartBody>,
) -> Response {
    let toggle_result = if body.enabled {
        state.app.autolaunch().enable()
    } else {
        state.app.autolaunch().disable()
    };

    if let Err(e) = toggle_result {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }

    match state.app.autolaunch().is_enabled() {
        Ok(enabled) => Json(AutostartResponse { enabled }).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}
