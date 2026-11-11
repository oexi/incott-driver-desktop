//! 诊断日志（与 Electron 版 main.cjs 相同）：应用事件与控制台错误同时写入本机文件，
//! 软件重启或崩溃后，诊断信息里仍能看到上一次运行的记录。只保存在本机，不会上传。

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_MAX: u64 = 1024 * 1024;
const PREV_TAIL: usize = 150;

#[derive(Default)]
struct Inner {
    dir: Option<PathBuf>,
    file: Option<PathBuf>,
    size: u64,
}

pub struct AppLog(Mutex<Inner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrevLog {
    modified: String,
    total: usize,
    clean_exit: bool,
    lines: Vec<String>,
}

/// 2026-11-11T03:51:12.181Z
pub fn iso(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let ms = d.subsec_millis();
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Howard Hinnant 的 civil_from_days
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

impl AppLog {
    pub fn new() -> Self {
        AppLog(Mutex::new(Inner::default()))
    }

    pub fn init(&self, dir: PathBuf, header: &str) {
        let mut g = self.0.lock().unwrap();
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let file = dir.join("diag.log");
        if file.exists() {
            let _ = fs::rename(&file, dir.join("diag.prev.log"));
        }
        g.dir = Some(dir);
        g.file = Some(file);
        g.size = 0;
        drop(g);
        self.append(header, false);
    }

    /// force：超过大小上限后仍然写入（用于"正常退出"标记，否则写满的日志会被误判为异常退出）
    pub fn append(&self, line: &str, force: bool) {
        let mut g = self.0.lock().unwrap();
        let Some(file) = g.file.clone() else { return };
        if g.size > LOG_MAX && !force {
            return;
        }
        let line: String = line.chars().take(1000).collect();
        let mut s = format!("{} {}\n", iso(SystemTime::now()), line);
        g.size += s.len() as u64;
        if g.size > LOG_MAX {
            s.push_str("=== log size limit reached, later lines dropped\n");
        }
        // 同步写：崩溃前的最后几行也能落盘；事件很少，不影响性能
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
            let _ = f.write_all(s.as_bytes());
        }
    }

    pub fn previous(&self) -> Option<PrevLog> {
        let dir = self.0.lock().unwrap().dir.clone()?;
        let file = dir.join("diag.prev.log");
        let modified = fs::metadata(&file).ok()?.modified().ok()?;
        let text = fs::read_to_string(&file).ok()?;
        let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
        let last = lines.last().copied().unwrap_or("");
        Some(PrevLog {
            modified: iso(modified),
            total: lines.len(),
            clean_exit: last.contains("=== session end"),
            lines: lines[lines.len().saturating_sub(PREV_TAIL)..].iter().map(|s| s.to_string()).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn iso_format() {
        let t = UNIX_EPOCH + Duration::from_millis(1_794_369_072_181);
        assert_eq!(iso(t), "2026-11-11T03:51:12.181Z");
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }
}
