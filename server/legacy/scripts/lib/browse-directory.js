"use strict";

// Tách từ scripts/wizard.js — dùng chung bởi wizard cài đặt gốc (scripts/wizard.js) VÀ endpoint
// "Cấu hình" live của app đang chạy (services/settings.service.js), tránh lặp lại logic gọi dialog
// chọn thư mục OS native ở 2 nơi.
const { execFileSync } = require("child_process");
const path = require("path");
const os = require("os");

// User bấm Cancel/đóng dialog KHÔNG phải lỗi — zenity/kdialog/osascript đều exit non-zero khi đó
// (zenity/kdialog: status 1; osascript: "User canceled." kèm status khác 0), nhưng KHÔNG phải
// ENOENT (đó là dấu hiệu duy nhất của "binary thật sự không tồn tại"). Bug thật đã gặp: trước khi
// có fix DISPLAY/XAUTHORITY, zenity luôn crash "cannot open display" nên chưa ai bấm Cancel được
// dialog thật để lộ ra chỗ này — code cũ coi MỌI lỗi (kể cả Cancel hợp lệ) là "không tìm thấy
// zenity/kdialog", hiện thông báo sai gây hoang mang dù người dùng chỉ đơn giản đổi ý không chọn.
function isMissingBinary(error) {
  return Boolean(error && error.code === "ENOENT");
}

// Nút "Chọn thư mục..." gọi dialog OS THẬT (không dùng showDirectoryPicker() của trình duyệt —
// API đó không bao giờ trả về đường dẫn OS thật, giới hạn bảo mật của trình duyệt). Không có
// zenity/kdialog/osascript → trả lỗi rõ ràng, ô thư mục vẫn gõ tay được bình thường, không chặn cài
// đặt. Trả về `null` (không throw) khi user chủ động Cancel — xem `isMissingBinary()` ở trên.
function browseDirectoryNative() {
  const platform = process.platform;
  if (platform === "linux") {
    // Bug thật đã gặp: chạy qua systemd --user (service nền, xem
    // scripts/relocate-and-recreate.sh::recreate_shortcut_and_service()) không tự kế thừa
    // DISPLAY/XAUTHORITY của session GUI → zenity/kdialog fail "cannot open display" dù binary có
    // sẵn. Vá TẠI ĐÂY (thời điểm gọi lệnh) thay vì chỉ vá lúc sinh unit file — cách này có hiệu lực
    // ngay khi tiến trình Node được khởi động lại, không phụ thuộc unit file phải được ghi lại
    // trước (unit file chỉ được ghi lại khi user bấm "Áp dụng"/chạy lại cài đặt, dễ bị bỏ sót).
    // Ưu tiên giá trị đã có sẵn trong env hiện tại, fallback ":0"/"~/.Xauthority" — đúng cho máy
    // desktop 1 seat thông thường (đã verify khớp session thật qua `loginctl show-session`), máy
    // nhiều seat/DISPLAY khác :0 vẫn phải tự set biến môi trường tương ứng cho service.
    const displayEnv = {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ":0",
      XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), ".Xauthority")
    };
    try {
      return execFileSync("zenity", ["--file-selection", "--directory", "--title=Chọn thư mục cài đặt k8sctl"], {
        encoding: "utf8",
        env: displayEnv
      }).trim();
    } catch (zenityError) {
      if (!isMissingBinary(zenityError)) return null; // zenity chạy được, user Cancel — không phải lỗi.
      try {
        return execFileSync("kdialog", ["--getexistingdirectory", process.env.HOME || "."], {
          encoding: "utf8",
          env: displayEnv
        }).trim();
      } catch (kdialogError) {
        if (!isMissingBinary(kdialogError)) return null; // kdialog chạy được, user Cancel.
        throw new Error("Không tìm thấy zenity/kdialog — tự gõ đường dẫn vào ô bên trên.");
      }
    }
  }
  if (platform === "darwin") {
    try {
      return execFileSync(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "Chọn thư mục cài đặt k8sctl")'],
        { encoding: "utf8" }
      ).trim();
    } catch (osascriptError) {
      if (!isMissingBinary(osascriptError)) return null; // osascript chạy được, user Cancel.
      throw new Error("Không mở được dialog chọn thư mục (osascript) — tự gõ đường dẫn vào ô bên trên.");
    }
  }
  if (platform === "win32") {
    try {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "$f.Description = 'Chọn thư mục cài đặt k8sctl'; " +
        "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }";
      return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("Không mở được dialog chọn thư mục (PowerShell) — tự gõ đường dẫn vào ô bên trên.");
    }
  }
  throw new Error(`Không hỗ trợ dialog chọn thư mục trên platform "${platform}" — tự gõ đường dẫn vào ô bên trên.`);
}

module.exports = { browseDirectoryNative };
