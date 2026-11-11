//! Linux 专用：hidraw 权限检测与 udev 规则安装（与 Electron 版 linux-udev.cjs 相同），
//! 跟随系统深色模式（xdg-desktop-portal），休眠 / 唤醒事件（logind）。

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::process::Command;
use std::thread;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedValue, Value};

const RULES_PATH: &str = "/etc/udev/rules.d/70-incott-mouse.rules";
const SYSTEM_RULES_PATH: &str = "/usr/lib/udev/rules.d/70-incott-mouse.rules";
const RULES: &str = include_str!("../../build/linux/70-incott-mouse.rules");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidrawDev {
    node: String,
    product_id: u32,
    access: bool,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidrawStatus {
    platform: &'static str,
    devices: Vec<HidrawDev>,
    rules_installed: bool,
    rules_system: bool,
    needs_fix: bool,
}

pub fn hidraw_status(vendor_id: u16) -> HidrawStatus {
    let mut devices = Vec::new();
    if let Ok(entries) = fs::read_dir("/sys/class/hidraw") {
        let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let Ok(uevent) = fs::read_to_string(format!("/sys/class/hidraw/{name}/device/uevent")) else { continue };
            let field = |k: &str| uevent.lines().find_map(|l| l.strip_prefix(k)).map(str::trim);
            // HID_ID=0003:0000093A:0000522C
            let Some(id) = field("HID_ID=") else { continue };
            let parts: Vec<&str> = id.split(':').collect();
            if parts.len() != 3 || u32::from_str_radix(parts[1], 16).ok() != Some(vendor_id as u32) {
                continue;
            }
            let node = format!("/dev/{name}");
            // 只是打开再关上，不会向设备发送任何数据
            let access = OpenOptions::new().read(true).write(true).open(&node).is_ok();
            devices.push(HidrawDev {
                product_id: u32::from_str_radix(parts[2], 16).unwrap_or(0),
                access,
                name: field("HID_NAME=").unwrap_or("").to_string(),
                node,
            });
        }
    }
    let needs_fix = !devices.is_empty() && devices.iter().any(|d| !d.access);
    HidrawStatus {
        platform: "linux",
        rules_installed: Path::new(RULES_PATH).exists(),
        // 安装包（deb / rpm）放在这里
        rules_system: Path::new(SYSTEM_RULES_PATH).exists(),
        needs_fix,
        devices,
    }
}

pub fn install_udev() -> serde_json::Value {
    let script = format!(
        "cat > {RULES_PATH} <<'EOF'\n{}\nEOF\nudevadm control --reload-rules\nudevadm trigger --subsystem-match=hidraw",
        RULES.trim_end()
    );
    match Command::new("pkexec").args(["sh", "-c", &script]).output() {
        Ok(o) if o.status.success() => serde_json::json!({ "ok": true, "path": RULES_PATH }),
        Ok(o) => {
            let mut e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if e.is_empty() {
                e = format!("pkexec exited with {}", o.status);
            }
            serde_json::json!({ "ok": false, "error": e, "rules": RULES, "path": RULES_PATH })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string(), "rules": RULES, "path": RULES_PATH }),
    }
}

pub fn os_pretty_name() -> String {
    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.trim().to_string()).unwrap_or_default();
    let name = fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("PRETTY_NAME="))
                .map(|v| v.trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "Linux".into());
    format!("{name} (kernel {kernel})")
}

/* ------------------------------------------------------------ 深色模式 */

// WebKitGTK 的 prefers-color-scheme 只看 GTK 主题（名字带 -dark / gtk-application-prefer-dark-theme），
// 不看 GNOME「外观 → 深色」写入的 portal color-scheme：主题是浅色、外观选了深色时，页面会一直是浅色。
// 这里读 portal，再用 set_theme 告诉 GTK，WebKit 就会跟着变。

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const PORTAL_IFACE: &str = "org.freedesktop.portal.Settings";
const APPEARANCE: &str = "org.freedesktop.appearance";

fn as_u32(v: &Value) -> Option<u32> {
    match v {
        Value::U32(x) => Some(*x),
        Value::Value(inner) => as_u32(inner),
        _ => None,
    }
}

fn portal_proxy(conn: &Connection) -> Option<Proxy<'static>> {
    Proxy::new(conn, PORTAL_DEST, PORTAL_PATH, PORTAL_IFACE).ok()
}

/// Some(true) = 深色，Some(false) = 浅色 / 无偏好，None = 没有 portal
pub fn portal_dark() -> Option<bool> {
    let conn = Connection::session().ok()?;
    let p = portal_proxy(&conn)?;
    let v: OwnedValue = p
        .call("ReadOne", &(APPEARANCE, "color-scheme"))
        .or_else(|_| p.call("Read", &(APPEARANCE, "color-scheme")))
        .ok()?;
    as_u32(&v).map(|x| x == 1)
}

pub fn watch_portal_dark(cb: impl Fn(bool) + Send + 'static) {
    let _ = thread::Builder::new().name("portal-theme".into()).spawn(move || {
        let Ok(conn) = Connection::session() else { return };
        let Some(p) = portal_proxy(&conn) else { return };
        let Ok(signals) = p.receive_signal("SettingChanged") else { return };
        for msg in signals {
            let Ok((ns, key, value)) = msg.body().deserialize::<(String, String, OwnedValue)>() else { continue };
            if ns == APPEARANCE && key == "color-scheme" {
                if let Some(x) = as_u32(&value) {
                    cb(x == 1);
                }
            }
        }
    });
}

/* ------------------------------------------------------------ 休眠 / 唤醒 */

/// logind 的 PrepareForSleep：true = 即将休眠，false = 已唤醒
pub fn watch_sleep(cb: impl Fn(bool) + Send + 'static) {
    let _ = thread::Builder::new().name("logind-sleep".into()).spawn(move || {
        let Ok(conn) = Connection::system() else { return };
        let Ok(p) = Proxy::new(&conn, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager")
        else {
            return;
        };
        let Ok(signals) = p.receive_signal("PrepareForSleep") else { return };
        for msg in signals {
            if let Ok((start,)) = msg.body().deserialize::<(bool,)>() {
                cb(start);
            }
        }
    });
}
