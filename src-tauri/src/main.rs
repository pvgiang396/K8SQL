// k8sql — Tauri shell. Phase 1: chỉ spawn sidecar Node (server/) ở dev mode + trỏ WebView vào đó,
// chưa có SQLite/keychain/wizard (xem docs/plan các phase kế tiếp).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ports;
mod sidecar;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Phase 1: thư mục server/ nằm cạnh src-tauri/ trong lúc dev (repo monorepo layout).
            // Từ Phase 2 trở đi, đường dẫn này đổi thành resource dir của gói SEA (Tauri quản lý).
            let server_dir = app
                .path()
                .resolve("../server", tauri::path::BaseDirectory::Resource)
                .ok()
                .and_then(|p| p.to_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "../server".to_string());

            tauri::async_runtime::spawn(async move {
                match sidecar::spawn_dev(&app_handle, &server_dir).await {
                    Ok(handle) => {
                        let port = handle.port;
                        app_handle.manage(std::sync::Mutex::new(Some(handle)));

                        let url = format!("http://127.0.0.1:{port}/")
                            .parse()
                            .expect("URL sidecar không hợp lệ");

                        let window = WebviewWindowBuilder::new(
                            &app_handle,
                            "main",
                            WebviewUrl::External(url),
                        )
                        .title("k8sql")
                        .inner_size(1280.0, 800.0)
                        .build()
                        .expect("Không tạo được cửa sổ chính");
                        let _ = window.show();
                    }
                    Err(e) => {
                        eprintln!("[k8sql] Lỗi khởi động sidecar: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window
                    .app_handle()
                    .try_state::<std::sync::Mutex<Option<sidecar::SidecarHandle>>>()
                {
                    if let Ok(mut guard) = state.lock() {
                        if let Some(handle) = guard.take() {
                            tauri::async_runtime::block_on(sidecar::shutdown(handle));
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Lỗi khi chạy k8sql");
}
