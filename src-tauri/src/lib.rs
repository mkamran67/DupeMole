mod media_date;
mod organize;
mod results;
mod scanner;
mod settings;
mod stats;
mod thumbnails;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use scanner::{CancelToken, ScanComplete, ScanProgress};
use settings::{Settings, SettingsState};
use stats::{LifetimeStats, StatsState};

#[tauri::command]
fn get_settings(state: State<SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    new: Settings,
    app: AppHandle,
    state: State<SettingsState>,
) -> Result<(), String> {
    settings::save(&app, &new)?;
    *state.0.lock().unwrap() = new;
    Ok(())
}

#[tauri::command]
fn get_stats(state: State<StatsState>) -> LifetimeStats {
    *state.0.lock().unwrap()
}

#[derive(Default)]
pub struct ActiveScans(pub Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>);

#[tauri::command]
fn start_scan(
    paths: Vec<String>,
    scan_id: Option<String>,
    app: AppHandle,
    settings_state: State<SettingsState>,
    scans: State<ActiveScans>,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("no paths provided".into());
    }
    let settings = settings_state.0.lock().unwrap().clone();
    let scan_id = scan_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let cancel = CancelToken::new();
    scans
        .0
        .lock()
        .unwrap()
        .insert(scan_id.clone(), cancel.0.clone());

    let app_handle = app.clone();
    let scan_id_thread = scan_id.clone();
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    thread::spawn(move || {
        let on_progress = {
            let app = app_handle.clone();
            let id = scan_id_thread.clone();
            move |p: ScanProgress| {
                let _ = app.emit(
                    "scan://progress",
                    serde_json::json!({ "scanId": id, "progress": p }),
                );
            }
        };

        let result: ScanComplete = scanner::run_scan(path_bufs, &settings, &cancel, on_progress);

        let was_cancelled = cancel.0.load(std::sync::atomic::Ordering::SeqCst);

        if let Err(e) = results::save_last_scan(&app_handle, &result) {
            eprintln!("save_last_scan failed: {e}");
        }

        if !was_cancelled {
            if let Some(stats_state) = app_handle.try_state::<StatsState>() {
                let snapshot = {
                    let mut s = stats_state.0.lock().unwrap();
                    s.total_scans_run = s.total_scans_run.saturating_add(1);
                    *s
                };
                if let Err(e) = stats::save(&app_handle, &snapshot) {
                    eprintln!("stats::save failed: {e}");
                }
            }
        }

        let _ = app_handle.emit(
            "scan://complete",
            serde_json::json!({ "scanId": scan_id_thread, "result": result }),
        );

        if let Some(scans) = app_handle.try_state::<ActiveScans>() {
            scans.0.lock().unwrap().remove(&scan_id_thread);
        }
    });

    Ok(scan_id)
}

#[tauri::command]
fn cancel_scan(scan_id: String, scans: State<ActiveScans>) {
    if let Some(flag) = scans.0.lock().unwrap().get(&scan_id) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let loaded = settings::load(app.handle());
            app.manage(SettingsState(Mutex::new(loaded)));
            let loaded_stats = stats::load(app.handle());
            app.manage(StatsState(Mutex::new(loaded_stats)));
            app.manage(ActiveScans::default());
            app.manage(organize::ActiveOrganizes::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_stats,
            start_scan,
            cancel_scan,
            organize::start_organize,
            organize::cancel_organize,
            results::get_last_scan,
            results::delete_files,
            results::prune_last_scan,
            thumbnails::get_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
