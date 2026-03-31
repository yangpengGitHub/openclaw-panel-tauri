use tauri::Manager;

#[cfg(not(target_os = "android"))]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder.setup(|app| {
        let handle = app.handle();

        // --- System Tray (Desktop only) ---
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

    #[cfg(not(target_os = "android"))]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Minimize to tray instead of closing
            let _ = window.hide();
            api.prevent_close();
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
