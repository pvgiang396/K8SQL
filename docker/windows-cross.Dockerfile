# Cross-compile Tauri/Rust cho Windows TỪ Linux — hướng KHÔNG CHÍNH THỨC (Tauri khuyến nghị build
# native trên Windows thật hoặc CI runner Windows), dùng target GNU (`x86_64-pc-windows-gnu`) thay
# vì MSVC (target MSVC không cross-compile được từ Linux — cần Visual Studio Build Tools thật).
# Rủi ro đã biết trước, CHƯA verify: tương tác WebView2/COM bindings hoặc script NSIS có thể lỗi khi
# build bằng GNU toolchain thay vì MSVC — xem k8sql/CLAUDE.md mục ghi chú build đa nền tảng.
FROM rust:1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-mingw-w64-x86-64 \
    nsis \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-pc-windows-gnu

# Node.js — cần cho `cargo tauri build` (Tauri CLI gọi tới 1 số bước liên quan frontendDist dù
# k8sql không có build step frontend thật, và cho các hook build tương lai nếu phát sinh).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN cargo install tauri-cli --locked --version "^2"

WORKDIR /work
