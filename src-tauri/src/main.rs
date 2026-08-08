// k8sql — Tauri shell. Debug build (`cargo tauri dev`): spawn thẳng `node server/src/bootstrap.ts`
// từ PATH hệ thống (nhanh, đọc source TS trực tiếp). Release build (`cargo tauri build`): spawn
// binary SEA `k8sql-server` qua `.sidecar()` — tự mang Node runtime, không cần Node hệ thống trên
// máy đích. Xem `sidecar.rs` (spawn_dev/spawn_release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_bridge;
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
            // Chỉ dev mode cần server_dir (trỏ tới source TS) — release mode dùng sidecar binary
            // đã tự chứa mọi thứ, không cần biết server/ nằm đâu.
            let server_dir = if cfg!(debug_assertions) {
                Some(resolve_server_dir(app)?)
            } else {
                None
            };
            let data_dir = resolve_data_dir(app)?;

            tauri::async_runtime::spawn(async move {
                let bridge = match native_bridge::start(app_handle.clone()).await {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("[k8sql] Lỗi khởi động native bridge: {e}");
                        return;
                    }
                };

                let spawn_result = if let Some(dir) = server_dir {
                    sidecar::spawn_dev(&app_handle, &dir, &data_dir, &bridge).await
                } else {
                    sidecar::spawn_release(&app_handle, &data_dir, &bridge).await
                };

                match spawn_result {
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

/// Tìm thư mục `server/` cho DEV MODE ONLY (`spawn_dev()` cần source TS thật để chạy
/// `node server/src/bootstrap.ts`). Release mode không gọi hàm này — sidecar binary SEA đã tự
/// chứa toàn bộ code, chỉ resolve `public/` lúc runtime qua `process.execPath`
/// (`server/src/bootstrap.ts::resolvePublicDir()`).
///
/// `server/` nằm cạnh `src-tauri/` trong repo — lấy qua `CARGO_MANIFEST_DIR` (hằng số biên dịch,
/// không phụ thuộc cwd lúc chạy `cargo tauri dev`).
fn resolve_server_dir(_app: &tauri::App) -> Result<String, Box<dyn std::error::Error>> {
    let dev_server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../server");
    if dev_server.is_dir() {
        return Ok(dev_server.to_string_lossy().to_string());
    }

    Err(format!("Không tìm thấy thư mục server/ (đã thử {})", dev_server.display()).into())
}

/// Thư mục chứa SQLite DB (`server/src/config/db.ts`) — dev: `server/.data/` cạnh repo (gitignored);
/// release: app-data dir chuẩn OS do Tauri quản lý (`~/.local/share/com.pvgiang396.k8sql/` trên
/// Linux, tương đương trên macOS/Windows) — tạo nếu chưa có.
fn resolve_data_dir(app: &tauri::App) -> Result<String, Box<dyn std::error::Error>> {
    let dir = if cfg!(debug_assertions) {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/.data")
    } else {
        app.path().app_data_dir()?
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}
