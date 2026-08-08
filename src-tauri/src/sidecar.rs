use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::ports::{find_available_port, DEFAULT_PORT};

const HEALTH_POLL_INTERVAL_MS: u64 = 200;
const HEALTH_TIMEOUT_MS: u64 = 15_000;

/// Phase 1: spawn trực tiếp `node server/src/bootstrap.ts` (chưa đóng gói SEA — xem Phase 2 của
/// plan). Dùng `shell().command("node")` thay vì `.sidecar()` vì `.sidecar()` đòi hỏi binary đã
/// khai trong `tauri.conf.json`'s `externalBin` + đúng naming convention target-triple, chưa có ở
/// giai đoạn này. Khi có SEA binary (Phase 2), thay lời gọi `command("node")` bằng
/// `shell().sidecar("k8sql-server")`, giữ nguyên phần còn lại (health-check/graceful-shutdown).
pub struct SidecarHandle {
    pub child: CommandChild,
    pub port: u16,
}

pub async fn spawn_dev(app: &AppHandle, server_dir: &str) -> Result<SidecarHandle, String> {
    let port = find_available_port(DEFAULT_PORT)
        .ok_or_else(|| "Không tìm được port trống cho sidecar".to_string())?;

    let bootstrap_path = format!("{server_dir}/src/bootstrap.ts");
    let (mut rx, child) = app
        .shell()
        .command("node")
        .args([bootstrap_path.as_str(), "--port", &port.to_string()])
        .current_dir(server_dir)
        .spawn()
        .map_err(|e| format!("Không spawn được sidecar node: {e}"))?;

    // Log stdout/stderr ra console dev — Phase 3+ sẽ ghi ra file xoay vòng (logs/) như k8sctl gốc.
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
