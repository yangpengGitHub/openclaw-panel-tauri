use tauri::Manager;
use tauri::WebviewUrl;

#[cfg(not(target_os = "android"))]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
};

const REMOTE_SERVER: &str = "http://192.168.1.48:19800";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    // --- Desktop: create window pointing to remote server + system tray ---
    #[cfg(not(target_os = "android"))]
    let builder = builder.setup(|app| {
        let handle = app.handle();

        let _window = tauri::WebviewWindowBuilder::new(
            handle,
            "main",
            WebviewUrl::External(REMOTE_SERVER.parse().unwrap()),
        )
        .title("OpenClaw Panel")
        .inner_size(1200.0, 800.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .fullscreen(false)
        .center()
        .build()?;

        // --- System Tray ---
        let show = MenuItemBuilder::with_id("show", "Show Panel").build(handle)?;
        let separator = MenuItemBuilder::with_id("sep", "---").build(handle)?;
        let quit = MenuItemBuilder::with_id("quit", "Quit").build(handle)?;

        let menu = MenuBuilder::new(handle)
            .item(&show)
            .item(&separator)
            .item(&quit)
            .build()?;

        let _tray = TrayIconBuilder::new()
            .icon(handle.default_window_icon().unwrap().clone())
            .menu(&menu)
            .tooltip("OpenClaw Panel")
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            })
            .build(handle)?;

        Ok(())
    });

    // --- Desktop: minimize to tray on close ---
    #[cfg(not(target_os = "android"))]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let _ = window.hide();
            api.prevent_close();
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
