use std::net::TcpListener;

/// k8sctl mặc định hardcode port 3210 — k8sql dùng port khác để 2 app chạy song song trên cùng máy
/// không xung đột (xem plan "AI-tooling compatibility" + "Port"). 4210 chỉ là điểm khởi đầu dò;
/// nếu bị chiếm (kể cả bởi 1 phiên k8sql khác đang chạy) thì tăng dần tới khi bind được.
pub const DEFAULT_PORT: u16 = 4210;
const MAX_PROBE_ATTEMPTS: u16 = 50;

/// Trả về port trống đầu tiên bắt đầu từ `preferred` (thường là port đã dùng thành công lần trước,
/// đọc từ SQLite app_settings ở Phase 3 — Phase 1 luôn truyền DEFAULT_PORT).
pub fn find_available_port(preferred: u16) -> Option<u16> {
    for offset in 0..MAX_PROBE_ATTEMPTS {
        let candidate = preferred.wrapping_add(offset);
        if candidate == 0 {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Some(candidate);
        }
    }
    None
}
