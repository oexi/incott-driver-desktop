//! HID 访问：替代 Electron/Chromium 的 WebHID。前端的 navigator.hid 适配层（src/platform/tauri.js）调用这里的命令。
//!
//! - 只列出 / 打开 INCOTT（Pixart 093A）的配置接口（usage page 0xFF05），收发只允许报告 ID 9：
//!   接收器另一个接口上的报告 3 会让芯片进入升级模式，这里根本打不开那个接口。
//! - Windows 上每个顶层集合是一条单独的路径：部分接收器（如 1K）配置接口的两个 FF05 集合（报告 8 / 报告 9）分成两个设备，
//!   只有带特性报告 9 的那个能打开（issue #33）。Linux（hidraw）和 macOS 一个接口一条路径，两个集合在一起。
//! - hidapi 没有热插拔通知：每秒枚举一次，按路径比对，发 hid:connect / hid:disconnect 事件。
//! - 每个打开的设备有一个读线程，把输入报告（状态包）作为 hid:input 事件发给页面。

use crate::hiddesc::{self, Kind, Parsed};
use hidapi::{HidApi, HidDevice};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const INCOTT_VID: u16 = 0x093a;
const CONFIG_USAGE_PAGE: u16 = 0xff05;
const ALLOWED_REPORT_IDS: [u8; 1] = [9];
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
const FALLBACK_REPORT_LEN: usize = 64;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevInfo {
    pub id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub collections: Vec<hiddesc::CollectionInfo>,
}

/// 诊断用的系统 HID 设备摘要（与 Electron 版 summarizeHid 相同）：其它厂商的设备名可能是用户自己起的，只保留 093A 的
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub usages: Vec<[u16; 2]>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InputEvent<'a> {
    id: &'a str,
    report_id: u8,
    data: &'a [u8],
}

#[derive(Serialize, Clone)]
struct IdEvent<'a> {
    id: &'a str,
}

struct OpenDev {
    dev: Mutex<HidDevice>,
    desc: Arc<Parsed>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct Known {
    devices: BTreeMap<String, DevInfo>,
}

pub struct HidManager {
    api: Mutex<HidApi>,
    open: Mutex<HashMap<String, Arc<OpenDev>>>,
    descs: Mutex<HashMap<String, Arc<Parsed>>>,
    known: Mutex<Known>,
    app: Mutex<Option<AppHandle>>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// 有能收发命令的 FF05 集合（带特性报告 9）
fn is_config_interface(desc: &Parsed) -> bool {
    desc.collections.iter().any(|c| {
        c.usage_page == CONFIG_USAGE_PAGE && c.feature_reports.iter().any(|r| ALLOWED_REPORT_IDS.contains(&r.report_id))
    })
}

impl HidManager {
    pub fn new() -> Result<Arc<Self>, String> {
        let api = HidApi::new().map_err(err)?;
        Ok(Arc::new(Self {
            api: Mutex::new(api),
            open: Mutex::new(HashMap::new()),
            descs: Mutex::new(HashMap::new()),
            known: Mutex::new(Known::default()),
            app: Mutex::new(None),
        }))
    }

    /// 启动热插拔轮询
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
        let me = Arc::clone(self);
        thread::Builder::new()
            .name("hid-hotplug".into())
            .spawn(move || loop {
                me.poll_once();
                thread::sleep(POLL_INTERVAL);
            })
            .ok();
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit(event, payload);
        }
    }

    fn poll_once(&self) {
        let Ok(list) = self.scan() else { return };
        let mut fresh: BTreeMap<String, DevInfo> = list.into_iter().map(|d| (d.id.clone(), d)).collect();
        let (removed, added) = {
            let mut known = self.known.lock().unwrap();
            let removed: Vec<String> = known.devices.keys().filter(|k| !fresh.contains_key(*k)).cloned().collect();
            let added: Vec<DevInfo> =
                fresh.values().filter(|d| !known.devices.contains_key(&d.id)).cloned().collect();
            known.devices = std::mem::take(&mut fresh);
            (removed, added)
        };
        for id in removed {
            self.forget(&id);
            self.emit("hid:disconnect", IdEvent { id: &id });
        }
        for d in added {
            self.emit("hid:connect", d);
        }
    }

    /// 设备拔掉：关闭句柄、丢掉描述符缓存（同一路径下次可能是另一个设备）
    fn forget(&self, id: &str) {
        if let Some(o) = self.open.lock().unwrap().remove(id) {
            o.stop.store(true, Ordering::SeqCst);
        }
        self.descs.lock().unwrap().remove(id);
    }

    /// 读线程发现设备没了（拔掉后又插上，路径可能不变，轮询看不出来）：立即发 disconnect，并让下次轮询重新发 connect
    fn device_lost(&self, id: &str) {
        let was_known = self.known.lock().unwrap().devices.remove(id).is_some();
        self.forget(id);
        if was_known {
            self.emit("hid:disconnect", IdEvent { id });
        }
    }

    fn descriptor(&self, api: &HidApi, path: &str) -> Option<Arc<Parsed>> {
        if let Some(p) = self.descs.lock().unwrap().get(path) {
            return Some(Arc::clone(p));
        }
        let raw = read_descriptor(api, path)?;
        let parsed = Arc::new(hiddesc::parse(&raw));
        self.descs.lock().unwrap().insert(path.to_string(), Arc::clone(&parsed));
        Some(parsed)
    }

    /// 页面调用 getDevices：同时记入已知设备，轮询不会再为它们发 connect
    pub fn list(&self) -> Result<Vec<DevInfo>, String> {
        let out = self.scan()?;
        let mut known = self.known.lock().unwrap();
        for d in &out {
            known.devices.entry(d.id.clone()).or_insert_with(|| d.clone());
        }
        Ok(out)
    }

    /// 当前插着的 093A 接口（每个路径一项，相当于 WebHID 的一个 HIDDevice）
    fn scan(&self) -> Result<Vec<DevInfo>, String> {
        let mut api = self.api.lock().unwrap();
        api.reset_devices().map_err(err)?;
        api.add_devices(INCOTT_VID, 0).map_err(err)?;
        let mut by_path: BTreeMap<String, (u16, u16, String, Vec<[u16; 2]>)> = BTreeMap::new();
        for d in api.device_list() {
            let path = d.path().to_string_lossy().into_owned();
            let e = by_path.entry(path).or_insert_with(|| {
                (d.vendor_id(), d.product_id(), d.product_string().unwrap_or("").to_string(), Vec::new())
            });
            let u = [d.usage_page(), d.usage()];
            if !e.3.contains(&u) {
                e.3.push(u);
            }
        }
        let mut out = Vec::new();
        for (path, (vid, pid, name, usages)) in by_path {
            let collections = match self.descriptor(&api, &path) {
                Some(p) if !p.collections.is_empty() => p.collections.clone(),
                _ => usages
                    .iter()
                    .map(|u| hiddesc::CollectionInfo { usage_page: u[0], usage: u[1], kind: 1, ..Default::default() })
                    .collect(),
            };
            out.push(DevInfo { id: path, vendor_id: vid, product_id: pid, product_name: name, collections });
        }
        Ok(out)
    }

    /// 诊断：系统里全部 HID 设备（不打开任何设备）
    pub fn enumerate_all(&self) -> Result<Vec<ScanInfo>, String> {
        let mut api = self.api.lock().unwrap();
        api.refresh_devices().map_err(err)?;
        let mut by_path: BTreeMap<String, ScanInfo> = BTreeMap::new();
        for d in api.device_list() {
            let path = d.path().to_string_lossy().into_owned();
            let e = by_path.entry(path).or_insert_with(|| ScanInfo {
                vendor_id: d.vendor_id(),
                product_id: d.product_id(),
                name: (d.vendor_id() == INCOTT_VID).then(|| d.product_string().unwrap_or("").to_string()),
                usages: Vec::new(),
            });
            let u = [d.usage_page(), d.usage()];
            if !e.usages.contains(&u) {
                e.usages.push(u);
            }
        }
        Ok(by_path.into_values().collect())
    }

    pub fn open_device(self: &Arc<Self>, id: &str) -> Result<(), String> {
        if self.open.lock().unwrap().contains_key(id) {
            return Ok(());
        }
        let api = self.api.lock().unwrap();
        let desc = self.descriptor(&api, id).ok_or("cannot read the report descriptor")?;
        let info = self.known.lock().unwrap().devices.get(id).cloned();
        let vid_ok = info.as_ref().is_some_and(|d| d.vendor_id == INCOTT_VID);
        if !vid_ok || !is_config_interface(&desc) {
            return Err("not an INCOTT configuration interface".into());
        }
        let cpath = CString::new(id).map_err(err)?;
        let dev = api.open_path(&cpath).map_err(err)?;
        // 读线程用自己的句柄阻塞读，不跟命令抢锁；打不开第二个句柄时退回共用句柄轮询
        let reader = api.open_path(&cpath).ok();
        drop(api);

        let stop = Arc::new(AtomicBool::new(false));
        let od = Arc::new(OpenDev { dev: Mutex::new(dev), desc: Arc::clone(&desc), stop: Arc::clone(&stop) });
        self.open.lock().unwrap().insert(id.to_string(), Arc::clone(&od));

        let me = Arc::clone(self);
        let id_owned = id.to_string();
        let len = desc.max_size(Kind::Input).unwrap_or(FALLBACK_REPORT_LEN) + 1;
        thread::Builder::new()
            .name("hid-reader".into())
            .spawn(move || me.reader_loop(id_owned, od, reader, len))
            .map_err(err)?;
        Ok(())
    }

    fn reader_loop(&self, id: String, od: Arc<OpenDev>, reader: Option<HidDevice>, len: usize) {
        let mut buf = vec![0u8; len.max(2)];
        loop {
            if od.stop.load(Ordering::SeqCst) {
                return;
            }
            let r = match &reader {
                Some(h) => h.read_timeout(&mut buf, 200),
                None => {
                    let r = od.dev.lock().unwrap().read_timeout(&mut buf, 0);
                    if matches!(r, Ok(0)) {
                        thread::sleep(Duration::from_millis(4));
                    }
                    r
                }
            };
            match r {
                Ok(0) => {}
                Ok(n) => {
                    if od.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let (report_id, data) = if od.desc.numbered { (buf[0], &buf[1..n]) } else { (0, &buf[..n]) };
                    self.emit("hid:input", InputEvent { id: &id, report_id, data });
                }
                Err(_) => {
                    if !od.stop.load(Ordering::SeqCst) {
                        self.device_lost(&id);
                    }
                    return;
                }
            }
        }
    }

    pub fn close_device(&self, id: &str) {
        if let Some(o) = self.open.lock().unwrap().remove(id) {
            o.stop.store(true, Ordering::SeqCst);
        }
    }

    fn get(&self, id: &str) -> Result<Arc<OpenDev>, String> {
        self.open.lock().unwrap().get(id).cloned().ok_or_else(|| "device is not open".to_string())
    }

    fn check_id(report_id: u8) -> Result<(), String> {
        if ALLOWED_REPORT_IDS.contains(&report_id) {
            Ok(())
        } else {
            Err(format!("report id {report_id} is not allowed"))
        }
    }

    fn frame(od: &OpenDev, kind: Kind, report_id: u8, data: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = Vec::with_capacity(data.len() + 1);
        buf.push(report_id);
        buf.extend_from_slice(data);
        // 与 Chromium 一样按原样发送、不补齐（Windows 上 hidapi 会自己补到报告长度）
        if let Some(n) = od.desc.size(kind, report_id) {
            if data.len() > n {
                return Err(format!("report {report_id} is {n} bytes, got {}", data.len()));
            }
        }
        Ok(buf)
    }

    pub fn send_feature(&self, id: &str, report_id: u8, data: &[u8]) -> Result<(), String> {
        Self::check_id(report_id)?;
        let od = self.get(id)?;
        let buf = Self::frame(&od, Kind::Feature, report_id, data)?;
        let dev = od.dev.lock().unwrap();
        dev.send_feature_report(&buf).map_err(err)
    }

    pub fn send_output(&self, id: &str, report_id: u8, data: &[u8]) -> Result<(), String> {
        Self::check_id(report_id)?;
        let od = self.get(id)?;
        let buf = Self::frame(&od, Kind::Output, report_id, data)?;
        let dev = od.dev.lock().unwrap();
        dev.write(&buf).map(|_| ()).map_err(err)
    }

    /// 返回值与 WebHID 一致：第 0 字节是报告 ID
    pub fn receive_feature(&self, id: &str, report_id: u8) -> Result<Vec<u8>, String> {
        Self::check_id(report_id)?;
        let od = self.get(id)?;
        let len = od.desc.size(Kind::Feature, report_id).unwrap_or(FALLBACK_REPORT_LEN) + 1;
        let mut buf = vec![0u8; len];
        buf[0] = report_id;
        let n = {
            let dev = od.dev.lock().unwrap();
            dev.get_feature_report(&mut buf).map_err(err)?
        };
        buf.truncate(n.min(len));
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 按 issue #33（1K 接收器）诊断里列出的集合构造，不是实物描述符：两个 FF05:0001 集合，
    // 报告 8 只有 32 字节输入 / 输出，报告 9 另有 8 字节特性报告
    const TLC_8: [u8; 22] = [
        0x06, 0x05, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x08, 0x75, 0x08, 0x95, 0x20, 0x09, 0x01, 0x81, 0x02, 0x09, 0x01,
        0x91, 0x02, 0xc0,
    ];
    const TLC_9: [u8; 28] = [
        0x06, 0x05, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x09, 0x75, 0x08, 0x95, 0x20, 0x09, 0x01, 0x81, 0x02, 0x09, 0x01,
        0x91, 0x02, 0x95, 0x08, 0x09, 0x01, 0xb1, 0x02, 0xc0,
    ];

    #[test]
    fn config_interface_needs_feature_report_9() {
        // Linux / macOS：一个接口一条路径，两个集合都在
        assert!(is_config_interface(&hiddesc::parse(&[TLC_8.as_slice(), &TLC_9].concat())));
        // Windows：每个集合一条路径，只有报告 8 的那个打不开
        assert!(!is_config_interface(&hiddesc::parse(&TLC_8)));
        let p = hiddesc::parse(&TLC_9);
        assert!(is_config_interface(&p));
        assert_eq!(p.size(Kind::Feature, 9), Some(8));
        assert_eq!(p.size(Kind::Input, 9), Some(32));
    }
}

#[cfg(target_os = "linux")]
fn read_descriptor(_api: &HidApi, path: &str) -> Option<Vec<u8>> {
    // sysfs 里的描述符人人可读，不需要 hidraw 读写权限（没装 udev 规则时也能识别出设备）
    let node = std::path::Path::new(path).file_name()?.to_str()?;
    std::fs::read(format!("/sys/class/hidraw/{node}/device/report_descriptor")).ok()
}

#[cfg(not(target_os = "linux"))]
fn read_descriptor(api: &HidApi, path: &str) -> Option<Vec<u8>> {
    let dev = api.open_path(&CString::new(path).ok()?).ok()?;
    let mut buf = vec![0u8; 4096];
    let n = dev.get_report_descriptor(&mut buf).ok()?;
    buf.truncate(n);
    Some(buf)
}
