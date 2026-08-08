use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::ports::{find_available_port, DEFAULT_PORT};

const HEALTH_POLL_INTERVAL_MS: u64 = 200;
const HEALTH_TIMEOUT_MS: u64 = 15_000;

/// 2 chế độ spawn sidecar:
///   - `spawn_dev()`: gọi thẳng `node server/src/bootstrap.ts` từ PATH hệ thống — dùng cho
///     `cargo tauri dev`, đọc trực tiếp source TS, không cần build lại SEA mỗi lần sửa 1 dòng.
///   - `spawn_release()`: dùng `shell().sidecar("k8sql-server")` — binary SEA đã khai trong
///     `tauri.conf.json`'s `bundle.externalBin`, tự mang Node runtime, không cần Node hệ thống
///     trên máy đích. Dùng cho bản đóng gói thật (`cargo tauri build`).
/// `main.rs` chọn hàm nào theo `cfg!(debug_assertions)`.
pub struct SidecarHandle {
    pub child: CommandChild,
    pub port: u16,
}

// Log stdout/stderr ra console dev — Phase 3+ sẽ ghi ra file xoay vòng (logs/) như k8sctl gốc.
// Nhân bản logic giữa spawn_dev/spawn_release thay vì tách hàm chung — kiểu Receiver trả về từ
// `.command()`/`.sidecar()` không public rõ ràng để khai type tường minh cho 1 hàm helper, tách ra
// dễ đoán sai type hơn là lợi ích giảm trùng lặp vài dòng.
macro_rules! log_sidecar_events {
    ($mut_rx:expr) => {
        let mut rx = $mut_rx;
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        println!("[k8sql-server] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Stderr(line) => {
                        eprintln!("[k8sql-server:err] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Terminated(payload) => {
                        println!("[k8sql-server] terminated: {:?}", payload);
                    }
                    _ => {}
                }
            }
        });
    };
}

pub async fn spawn_dev(app: &AppHandle, server_dir: &str) -> Result<SidecarHandle, String> {
    let port = find_available_port(DEFAULT_PORT)
        .ok_or_else(|| "Không tìm được port trống cho sidecar".to_string())?;

    let bootstrap_path = format!("{server_dir}/src/bootstrap.ts");
    let (rx, child) = app
        .shell()
        .command("node")
        .args([bootstrap_path.as_str(), "--port", &port.to_string()])
        .current_dir(server_dir)
        .spawn()
        .map_err(|e| format!("Không spawn được sidecar node: {e}"))?;

    log_sidecar_events!(rx);
    wait_until_healthy(port).await?;

    Ok(SidecarHandle { child, port })
}

pub async fn spawn_release(app: &AppHandle) -> Result<SidecarHandle, String> {
    let port = find_available_port(DEFAULT_PORT)
        .ok_or_else(|| "Không tìm được port trống cho sidecar".to_string())?;

    // KHÔNG để Node tự đoán vị trí public/ qua process.execPath — đã verify thật trên .deb: Tauri
    // đặt externalBin ở /usr/bin/k8sql-server nhưng resource `public` (khai trong
    // tauri.conf.json's bundle.resources) lại ở /usr/lib/k8sql/public/, 2 nơi không liên quan theo
    // đường dẫn tương đối. Dùng đúng API resolve resource của Tauri (đúng cho mọi loại bundle
    // .deb/.AppImage/.msi/.dmg, không phải tự đoán layout từng loại) rồi truyền qua --public-dir.
    use tauri::Manager;
    let public_dir = app
        .path()
        .resolve("public", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Không resolve được resource dir 'public': {e}"))?;
    let public_dir = public_dir.to_string_lossy().to_string();

    let (rx, child) = app
        .shell()
        .sidecar("k8sql-server")
        .map_err(|e| format!("Không resolve được sidecar binary k8sql-server: {e}"))?
        .args(["--port", &port.to_string(), "--public-dir", &public_dir])
        .spawn()
        .map_err(|e| format!("Không spawn được sidecar k8sql-server: {e}"))?;

    log_sidecar_events!(rx);
    wait_until_healthy(port).await?;

    Ok(SidecarHandle { child, port })
}

async fn wait_until_healthy(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = std::time::Instant::now() + Duration::from_millis(HEALTH_TIMEOUT_MS);
    let client = reqwest::Client::new();

    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
    }

    Err(format!("Sidecar không sẵn sàng sau {HEALTH_TIMEOUT_MS}ms (health-check {url} thất bại)"))
}

/// Đóng sidecar khi app thoát — thử graceful shutdown qua route nội bộ trước, hard-kill nếu không
/// phản hồi kịp (xem "Sidecar lifecycle" trong plan).
pub async fn shutdown(handle: SidecarHandle) {
    let url = format!("http://127.0.0.1:{}/internal/shutdown", handle.port);
    let client = reqwest::Client::new();
    let graceful = tokio::time::timeout(Duration::from_secs(3), client.post(&url).send()).await;

    if graceful.is_err() {
        let _ = handle.child.kill();
    }
}
