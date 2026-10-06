// Esports Data desktop app: a window around the bundled frontend (dist/tauri, the shared 9.3.0 UI).
// No credentials are compiled in. The app talks to https://esportsdata.online like the website; its session token is
// obtained at sign-in and kept in the app's own WebView2 profile (per Windows user), never in this binary.
// Plugins: opener (links in the default browser), notification (new-match notifications), process + updater
// (signed updates from the per-user NSIS channel; see TAURI-BUILD.md).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .run(tauri::generate_context!())
        .expect("error while running the Esports Data desktop app");
}
