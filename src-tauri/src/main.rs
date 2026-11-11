// Release 版在 Windows 上不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod applog;
mod hid;
mod hiddesc;
#[cfg(target_os = "linux")]
mod linux;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
const TRAY_ID: &str = "main-tray";
const BG_DARK: Color = Color(0x0e, 0x0f, 0x13, 0xff);
const BG_LIGHT: Color = Color(0xf4, 0xf5, 0xf8, 0xff);

struct AppState {
    hid: Result<Arc<hid::HidManager>, String>,
    log: Arc<applog::AppLog>,
    quitting: AtomicBool,
    close_to_tray: AtomicBool,
    maximized: AtomicBool,
    /// 启动时窗口内容已经露出来（见 reveal）
    revealed: AtomicBool,
    theme_source: Mutex<String>,
    /// 系统深色模式（Linux 从 portal 读取；其它平台交给 webview 自己判断，为 None）
    system_dark: Mutex<Option<bool>>,
}

impl AppState {
    fn hid(&self) -> Result<Arc<hid::HidManager>, String> {
        self.hid.clone()
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/* --------------------------------------------------------------- 平台信息 */

/// 前端沿用 Node / Electron 的平台名
fn node_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        a => a,
    }
}

fn os_name() -> String {
    #[cfg(target_os = "linux")]
    return linux::os_pretty_name();
    #[cfg(not(target_os = "linux"))]
    return os_info::get().to_string();
}

fn install_kind() -> &'static str {
    if cfg!(debug_assertions) {
        return "dev";
    }
    if std::env::var_os("APPIMAGE").is_some() {
        return "AppImage";
    }
    if cfg!(target_os = "linux") && std::env::current_exe().is_ok_and(|p| p.starts_with("/usr/")) {
        return "system package";
    }
    "packaged"
}

#[derive(Serialize)]
struct Info {
    version: String,
    platform: &'static str,
    arch: &'static str,
    tauri: &'static str,
    webview: String,
    // 以下仅用于诊断信息（不含用户名、路径等个人信息）
    os: String,
    locale: String,
    install: &'static str,
    session: String,
    desktop: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> Info {
    Info {
        version: app.package_info().version.to_string(),
        platform: node_platform(),
        arch: node_arch(),
        tauri: tauri::VERSION,
        webview: tauri::webview_version().unwrap_or_default(),
        os: os_name(),
        locale: sys_locale::get_locale().unwrap_or_default(),
        install: install_kind(),
        session: std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
    }
}

/* ------------------------------------------------------------------- 窗口 */

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn win_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_maximize(window: WebviewWindow) {
    let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
}

#[tauri::command]
fn win_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn win_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn win_start_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

/* ------------------------------------------------------------------- 主题 */

fn apply_theme(app: &AppHandle) {
    let st = app.state::<AppState>();
    let source = st.theme_source.lock().unwrap().clone();
    let theme = match source.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => st.system_dark.lock().unwrap().map(|d| if d { Theme::Dark } else { Theme::Light }),
    };
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_theme(theme);
        let dark = match theme {
            Some(t) => t == Theme::Dark,
            None => w.theme().map(|t| t == Theme::Dark).unwrap_or(true),
        };
        // Linux 自己画窗口边框：窗口背景必须保持透明（阴影区）
        if !cfg!(target_os = "linux") {
            let _ = w.set_background_color(Some(if dark { BG_DARK } else { BG_LIGHT }));
        }
    }
}

/* ---------------------------------------------------------- Linux 窗口边框 */

// Linux 上 Electron（Chromium）给无边框窗口画了圆角、细边框和阴影；GTK 的无边框窗口什么都没有。
// 这里改成透明窗口，由页面画边框和阴影（src/styles/base.css 的 html.csd），四周留出 CSD_MARGIN 的阴影区，
// 并告诉合成器阴影区有多宽：贴边、分屏、窗口位置都按可见的边框算。最大化时不留阴影区。
#[cfg(target_os = "linux")]
const CSD_MARGIN: i32 = 12;

#[cfg(target_os = "linux")]
fn set_csd_margin(w: &WebviewWindow, maximized: bool) {
    use gtk::prelude::*;
    if let Ok(gw) = w.gtk_window() {
        if let Some(gdk) = gw.window() {
            let m = if maximized { 0 } else { CSD_MARGIN };
            gdk.set_shadow_width(m, m, m, m);
        }
    }
}

/// 窗口是否处于激活状态（深阴影 / 浅阴影）。不用 tao 的 Focused：它跟的是 GTK 键盘焦点，
/// 拖动标题栏时系统临时接管指针和键盘，会报一次失去焦点，阴影就变浅了。
/// 这里看合成器给的激活状态（Wayland xdg_toplevel activated），与 Chromium 一致，拖动时不变
#[cfg(target_os = "linux")]
fn watch_active(w: &WebviewWindow) {
    use gtk::prelude::*;
    let Ok(gw) = w.gtk_window() else { return };
    let w2 = w.clone();
    let last = std::cell::Cell::new(None::<bool>);
    gw.connect_window_state_event(move |_, ev| {
        let active = ev.new_window_state().contains(gtk::gdk::WindowState::FOCUSED);
        if last.replace(Some(active)) != Some(active) {
            let _ = w2.emit("win:focus", active);
        }
        gtk::glib::Propagation::Proceed
    });
}

#[tauri::command]
fn set_theme(app: AppHandle, st: State<'_, AppState>, source: String) {
    if !["system", "light", "dark"].contains(&source.as_str()) {
        return;
    }
    {
        let mut cur = st.theme_source.lock().unwrap();
        if *cur == source {
            return;
        }
        *cur = source;
    }
    apply_theme(&app);
}

/* ------------------------------------------------------------------- 托盘 */

fn ensure_tray(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "show", "显示主窗口 / Show", true, None::<&str>).map_err(err)?;
    let sep = PredefinedMenuItem::separator(app).map_err(err)?;
    let quit = MenuItem::with_id(app, "quit", "退出 / Quit", true, None::<&str>).map_err(err)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit]).map_err(err)?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../build/tray.png")).map_err(err)?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Incott Driver")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    // Linux 上系统没装 libayatana-appindicator 时 tray-icon 会 panic：当作托盘不可用
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| builder.build(app))) {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(err(e)),
        Err(_) => Err("system tray is not available".into()),
    }
}

#[tauri::command]
fn set_tray(app: AppHandle, st: State<'_, AppState>, enabled: bool) {
    if enabled {
        let ok = ensure_tray(&app);
        if let Err(e) = &ok {
            st.log.append(&format!("[main] tray unavailable: {e}"), false);
        }
        st.close_to_tray.store(ok.is_ok(), Ordering::SeqCst);
    } else {
        st.close_to_tray.store(false, Ordering::SeqCst);
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
}

/* ------------------------------------------------------------- 文件 / 链接 */

#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveOpts {
    default_name: Option<String>,
    content: String,
    filters: Option<Vec<Filter>>,
}

#[derive(Deserialize)]
struct OpenOpts {
    filters: Option<Vec<Filter>>,
}

fn file_dialog(window: &WebviewWindow, filters: &Option<Vec<Filter>>) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut d = window.dialog().file().set_parent(window);
    for f in filters.iter().flatten() {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).filter(|e| *e != "*").collect();
        if !exts.is_empty() {
            d = d.add_filter(&f.name, &exts);
        }
    }
    d
}

#[tauri::command]
async fn save_text(window: WebviewWindow, opts: SaveOpts) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = file_dialog(&window, &opts.filters);
        if let Some(n) = &opts.default_name {
            d = d.set_file_name(n);
        }
        let Some(p) = d.blocking_save_file() else { return Ok(json!({ "ok": false, "canceled": true })) };
        let path = p.into_path().map_err(err)?;
        std::fs::write(&path, opts.content.as_bytes()).map_err(err)?;
        Ok(json!({ "ok": true, "path": path }))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn open_text(window: WebviewWindow, opts: OpenOpts) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(p) = file_dialog(&window, &opts.filters).blocking_pick_file() else {
            return Ok(json!({ "ok": false, "canceled": true }));
        };
        let path = p.into_path().map_err(err)?;
        let content = std::fs::read_to_string(&path).map_err(err)?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(json!({ "ok": true, "path": path, "name": name, "content": content }))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<bool, String> {
    app.clipboard().write_text(text).map_err(err)?;
    Ok(true)
}

/* ------------------------------------------------------------------- 日志 */

#[tauri::command]
fn log_append(st: State<'_, AppState>, line: String) {
    st.log.append(&line, false);
}

#[tauri::command]
fn log_previous(st: State<'_, AppState>) -> Option<applog::PrevLog> {
    st.log.previous()
}

/// 主进程事件（休眠 / 唤醒……）：写入日志，并转给页面记入事件列表
fn main_event(app: &AppHandle, msg: &str) {
    app.state::<AppState>().log.append(&format!("[main] {msg}"), false);
    let _ = app.emit("diag:main-event", msg);
}

/* -------------------------------------------------------------------- HID */

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[tauri::command]
async fn hid_list(st: State<'_, AppState>) -> Result<Vec<hid::DevInfo>, String> {
    let h = st.hid()?;
    blocking(move || h.list()).await
}

#[tauri::command]
async fn hid_list_all(st: State<'_, AppState>) -> Result<Vec<hid::ScanInfo>, String> {
    let h = st.hid()?;
    blocking(move || h.enumerate_all()).await
}

#[tauri::command]
async fn hid_open(st: State<'_, AppState>, id: String) -> Result<(), String> {
    let h = st.hid()?;
    blocking(move || h.open_device(&id)).await
}

#[tauri::command]
async fn hid_close(st: State<'_, AppState>, id: String) -> Result<(), String> {
    let h = st.hid()?;
    blocking(move || {
        h.close_device(&id);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn hid_send_feature(st: State<'_, AppState>, id: String, report_id: u8, data: Vec<u8>) -> Result<(), String> {
    let h = st.hid()?;
    blocking(move || h.send_feature(&id, report_id, &data)).await
}

#[tauri::command]
async fn hid_send_output(st: State<'_, AppState>, id: String, report_id: u8, data: Vec<u8>) -> Result<(), String> {
    let h = st.hid()?;
    blocking(move || h.send_output(&id, report_id, &data)).await
}

#[tauri::command]
async fn hid_receive_feature(st: State<'_, AppState>, id: String, report_id: u8) -> Result<Vec<u8>, String> {
    let h = st.hid()?;
    blocking(move || h.receive_feature(&id, report_id)).await
}

/* ------------------------------------------------------------------ Linux */

#[tauri::command]
async fn linux_hidraw_status() -> Value {
    #[cfg(target_os = "linux")]
    return serde_json::to_value(linux::hidraw_status(hid::INCOTT_VID)).unwrap_or(Value::Null);
    #[cfg(not(target_os = "linux"))]
    return json!({ "platform": node_platform(), "devices": [], "needsFix": false });
}

#[tauri::command]
async fn linux_install_udev() -> Value {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(linux::install_udev).await.unwrap_or(Value::Null);
    #[cfg(not(target_os = "linux"))]
    return json!({ "ok": false, "error": "not linux" });
}

/* ------------------------------------------------------------------ 启动 */

/// 应用只有一个页面，不会自己跳转：其它导航一律拦下，http(s) 链接交给系统浏览器
fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    let local = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
    let dev = cfg!(debug_assertions) && url.host_str() == Some("localhost");
    if local || dev {
        return true;
    }
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let dark = app.state::<AppState>().system_dark.lock().unwrap().unwrap_or(true);
    let init = format!("window.__INCOTT__ = Object.freeze({{ platform: {:?}, shell: 'tauri' }});", node_platform());
    // Linux 的窗口四周多出阴影区（见 CSD_MARGIN），可见部分保持原来的大小
    #[cfg(target_os = "linux")]
    let pad = 2.0 * CSD_MARGIN as f64;
    #[cfg(not(target_os = "linux"))]
    let pad = 0.0;
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Incott Driver")
        .inner_size(1280.0 + pad, 820.0 + pad)
        .min_inner_size(1080.0 + pad, 700.0 + pad)
        .center()
        .background_color(if cfg!(target_os = "linux") {
            Color(0, 0, 0, 0)
        } else if dark {
            BG_DARK
        } else {
            BG_LIGHT
        })
        .initialization_script(init)
        // 不用 Tauri 的文件拖放事件：页面自己拦下拖放（main.js），导航也会被下面拦住
        .disable_drag_drop_handler()
        .on_navigation(move |url| allow_navigation(&nav_app, url));
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 18.0));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    // 启动时不要露出 webview 画出第一帧之前的样子（黑一下）：
    // - Windows / macOS：Tauri 官方做法，窗口先隐藏，界面挂载好后由页面调用 win_reveal 显示；底色已按主题设好
    // - Linux：WebKitGTK 在 NVIDIA 上要约 1 秒才能出第一帧，而隐藏的页面拿不到「画好了」的信号（rAF 不触发）。
    //   所以窗口照常显示，只把装 webview 的容器设成几乎全透明，页面真正画出界面后（两次 rAF）再调用 win_reveal
    // 两边都有 2 秒保底
    #[cfg(not(target_os = "linux"))]
    let builder = builder.visible(false);
    #[cfg(target_os = "linux")]
    let builder = builder.transparent(true);
    let w = builder.build()?;
    #[cfg(target_os = "linux")]
    {
        set_csd_margin(&w, false);
        watch_active(&w);
        set_content_opacity(&w, HIDDEN_OPACITY);
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            if let Some(w) = app3.get_webview_window(MAIN) {
                reveal(&app3, &w, "fallback");
            }
        });
    });
    Ok(w)
}

/// 不用 0：完全透明时 GTK 不再绘制 webview，WebKit 收不到帧完成，页面的 rAF 会停住
#[cfg(target_os = "linux")]
const HIDDEN_OPACITY: f64 = 0.004;

#[cfg(target_os = "linux")]
fn set_content_opacity(w: &WebviewWindow, opacity: f64) {
    use gtk::prelude::*;
    if let Ok(vbox) = w.default_vbox() {
        vbox.set_opacity(opacity);
    }
}

/// 启动时把窗口内容露出来，只做一次；by 记入日志（page = 页面准备好后调用，fallback = 2 秒保底）
fn reveal(app: &AppHandle, w: &WebviewWindow, by: &str) {
    let st = app.state::<AppState>();
    if st.revealed.swap(true, Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "linux")]
    set_content_opacity(w, 1.0);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = w.show();
        let _ = w.set_focus();
    }
    st.log.append(&format!("[main] window revealed by {by}"), false);
}

#[tauri::command]
fn win_reveal(app: AppHandle, window: WebviewWindow) {
    reveal(&app, &window, "page");
}

fn main() {
    // 注意：不要默认设置 WEBKIT_DISABLE_DMABUF_RENDERER=1（常见的 NVIDIA 白屏绕过办法）。
    // 实测 GNOME Wayland + NVIDIA：关掉 DMA-BUF 渲染器后页面的定时器和 IPC 都被拖到约 200 ms 一次，连接鼠标要 20 多秒。
    let log = Arc::new(applog::AppLog::new());
    let state = AppState {
        hid: hid::HidManager::new(),
        log: Arc::clone(&log),
        quitting: AtomicBool::new(false),
        close_to_tray: AtomicBool::new(false),
        maximized: AtomicBool::new(false),
        revealed: AtomicBool::new(false),
        theme_source: Mutex::new("system".into()),
        #[cfg(target_os = "linux")]
        system_dark: Mutex::new(linux::portal_dark()),
        #[cfg(not(target_os = "linux"))]
        system_dark: Mutex::new(None),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            app_info,
            win_minimize,
            win_toggle_maximize,
            win_close,
            win_is_maximized,
            win_start_drag,
            win_reveal,
            set_theme,
            set_tray,
            open_external,
            save_text,
            open_text,
            copy_text,
            log_append,
            log_previous,
            hid_list,
            hid_list_all,
            hid_open,
            hid_close,
            hid_send_feature,
            hid_send_output,
            hid_receive_feature,
            linux_hidraw_status,
            linux_install_udev,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let st = app.state::<AppState>();
            if let Ok(dir) = app.path().app_log_dir() {
                let v = app.package_info().version.to_string();
                st.log.init(dir, &format!("=== session start v{v} {}-{} {} (tauri {})", node_platform(), node_arch(), os_name(), tauri::VERSION));
            }
            match &st.hid {
                Ok(h) => h.start(handle.clone()),
                Err(e) => st.log.append(&format!("[main] hidapi init failed: {e}"), false),
            }
            create_main_window(&handle)?;
            apply_theme(&handle);

            #[cfg(target_os = "linux")]
            {
                let h = handle.clone();
                linux::watch_portal_dark(move |dark| {
                    *h.state::<AppState>().system_dark.lock().unwrap() = Some(dark);
                    apply_theme(&h);
                });
                let h = handle.clone();
                linux::watch_sleep(move |start| main_event(&h, if start { "system suspend" } else { "system resume" }));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let st = app.state::<AppState>();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if !st.quitting.load(Ordering::SeqCst) && st.close_to_tray.load(Ordering::SeqCst) && app.tray_by_id(TRAY_ID).is_some() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                WindowEvent::Resized(_) => {
                    let m = window.is_maximized().unwrap_or(false);
                    if st.maximized.swap(m, Ordering::SeqCst) != m {
                        #[cfg(target_os = "linux")]
                        if let Some(w) = app.get_webview_window(MAIN) {
                            set_csd_margin(&w, m);
                        }
                        let _ = window.emit("win:state", json!({ "maximized": m }));
                    }
                }
                // Linux 的激活状态见 watch_active
                #[cfg(not(target_os = "linux"))]
                WindowEvent::Focused(f) => {
                    let _ = window.emit("win:focus", *f);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(move |app, event| match event {
        RunEvent::ExitRequested { .. } => app.state::<AppState>().quitting.store(true, Ordering::SeqCst),
        RunEvent::Exit => log.append("=== session end", true),
        _ => {}
    });
}
