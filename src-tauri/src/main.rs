// k8sql — Tauri shell. Debug build (`cargo tauri dev`): spawn thẳng `node server/src/bootstrap.ts`
// từ PATH hệ thống (nhanh, đọc source TS trực tiếp). Release build (`cargo tauri build`): spawn
// binary SEA `k8sql-server` qua `.sidecar()` — tự mang Node runtime, không cần Node hệ thống trên
// máy đích. Xem `sidecar.rs` (spawn_dev/spawn_release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_bridge;
mod ports;
mod sidecar;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Cờ chạy chế độ nền — chỉ tray icon, không bật cửa sổ. Dùng khi AI cần gọi API k8sql mà app chưa
/// chạy (`k8sql --tray &`), và khi OS tự khởi động app lúc đăng nhập (autostart luôn truyền cờ này,
/// xem `tauri_plugin_autostart::init` bên dưới).
fn wants_tray_only() -> bool {
    std::env::args().any(|a| a == "--tray")
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Thoát THẬT — chỉ gọi từ menu tray "Exit". Đóng cửa sổ (nút X) không đi qua đường này nữa, xem
/// `on_window_event` bên dưới.
fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<std::sync::Mutex<Option<sidecar::SidecarHandle>>>() {
        if let Ok(mut guard) = state.lock() {
            if let Some(handle) = guard.take() {
                tauri::async_runtime::block_on(sidecar::shutdown(handle));
            }
        }
    }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        // Phải là plugin ĐẦU TIÊN (yêu cầu của tauri-plugin-single-instance). Instance thứ 2 khởi
        // chạy (vd bấm icon desktop trong lúc app đã chạy nền do AI mở hoặc do autostart) chỉ show
        // lại cửa sổ instance gốc, KHÔNG spawn thêm sidecar/tranh chấp SQLite — bỏ qua argv của
        // instance thứ 2 (dù nó có --tray hay không, ý định bấm icon luôn là muốn NHÌN THẤY cửa sổ).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let tray_only = wants_tray_only();

            let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &exit_item])?;

            // Dùng lại icon app đã bundle sẵn (icons/32x32.png qua tauri.conf.json) — không có asset
            // tray riêng. Hạn chế đã biết, CHƯA verify: macOS quy ước icon tray/menu-bar nên là ảnh
            // "template" đơn sắc, icon màu hiện tại có thể không đúng chuẩn UX macOS (chỉ tự test
            // được trên Linux, máy dev không có Mac thật).
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "exit" => quit_app(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
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
                        .visible(!tray_only)
                        .build()
                        .expect("Không tạo được cửa sổ chính");
                        if !tray_only {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    Err(e) => {
                        eprintln!("[k8sql] Lỗi khởi động sidecar: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Đóng cửa sổ (nút X) giờ chỉ ẨN, không thoát app — sidecar vẫn chạy nền, tray icon vẫn
            // còn. Thoát THẬT chỉ qua menu tray "Exit" (`quit_app()`).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
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
