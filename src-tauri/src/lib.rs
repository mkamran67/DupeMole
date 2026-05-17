mod analysis;
mod cli_paths;
mod debug;
mod media_date;
mod metadata_writer;
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

use analysis::{AnalysisProgress, AnalysisReport, AnalyzeSettings};
use scanner::{CancelToken, ScanComplete, ScanProgress};
use settings::{Filters, Settings, SettingsState};
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

/// Directory paths the user passed on the command line (e.g. `dmole .`),
/// resolved to absolute paths at app startup. Returned once on first mount
/// so the frontend can seed the scan list.
pub struct CliPaths(pub Vec<PathBuf>);

#[tauri::command]
fn get_cli_paths(state: State<CliPaths>) -> Vec<String> {
    state
        .0
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
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

        let on_checkpoint = {
            let app = app_handle.clone();
            let id = scan_id_thread.clone();
            move |snapshot: &ScanComplete| {
                if let Err(e) = results::save_last_scan(&app, snapshot) {
                    debug::log(
                        &app,
                        "error",
                        "scan",
                        format!("save_last_scan (checkpoint) failed: {e}"),
                    );
                    return;
                }
                let _ = app.emit(
                    "scan://checkpoint",
                    serde_json::json!({
                        "scanId": id,
                        "groups": snapshot.groups.len(),
                        "duplicateFiles": snapshot.duplicate_files,
                        "wastedBytes": snapshot.wasted_bytes,
                    }),
                );
            }
        };

        let result: ScanComplete =
            scanner::run_scan(path_bufs, &settings, &cancel, on_progress, on_checkpoint);

        let was_cancelled = cancel.0.load(std::sync::atomic::Ordering::SeqCst);

        if let Err(e) = results::save_last_scan(&app_handle, &result) {
            debug::log(
                &app_handle,
                "error",
                "scan",
                format!("save_last_scan failed: {e}"),
            );
        }

        if !was_cancelled {
            if let Some(stats_state) = app_handle.try_state::<StatsState>() {
                let snapshot = {
                    let mut s = stats_state.0.lock().unwrap();
                    s.total_scans_run = s.total_scans_run.saturating_add(1);
                    *s
                };
                if let Err(e) = stats::save(&app_handle, &snapshot) {
                    debug::log(
                        &app_handle,
                        "error",
                        "stats",
                        format!("stats::save failed: {e}"),
                    );
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

#[derive(Default)]
pub struct ActiveAnalyses(pub Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>);

fn filters_to_analyze_settings(filters: &Filters, global_ignore_hidden: bool) -> AnalyzeSettings {
    AnalyzeSettings {
        ignore_hidden: filters.ignore_hidden.unwrap_or(global_ignore_hidden),
        ignore_macos_files: filters.ignore_macos_files,
        include_subdirs: filters.include_subdirs,
        extensions: filters.extensions.clone(),
        ignored_extensions: filters.ignored_extensions.clone(),
        ignored_folders: filters.ignored_folders.clone(),
        min_size: filters.min_size,
        max_size: filters.max_size,
        modified_after_ms: filters.modified_after_ms,
        modified_before_ms: filters.modified_before_ms,
    }
}

#[tauri::command]
fn start_analysis(
    paths: Vec<String>,
    analysis_id: Option<String>,
    app: AppHandle,
    settings_state: State<SettingsState>,
    analyses: State<ActiveAnalyses>,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("no paths provided".into());
    }
    let settings = settings_state.0.lock().unwrap().clone();
    let analyze_settings = filters_to_analyze_settings(&settings.analysis_filters, settings.ignore_hidden);
    let id = analysis_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let cancel = analysis::CancelToken::new();
    analyses.0.lock().unwrap().insert(id.clone(), cancel.0.clone());

    let app_handle = app.clone();
    let id_thread = id.clone();
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    thread::spawn(move || {
        let on_progress = {
            let app = app_handle.clone();
            let id = id_thread.clone();
            move |p: AnalysisProgress| {
                let _ = app.emit(
                    "analysis://progress",
                    serde_json::json!({ "analysisId": id, "progress": p }),
                );
            }
        };

        let report: AnalysisReport =
            analysis::run_analysis(path_bufs, &analyze_settings, &cancel, on_progress);

        let _ = app_handle.emit(
            "analysis://complete",
            serde_json::json!({ "analysisId": id_thread, "report": report }),
        );

        if let Some(active) = app_handle.try_state::<ActiveAnalyses>() {
            active.0.lock().unwrap().remove(&id_thread);
        }
    });

    Ok(id)
}

#[tauri::command]
fn cancel_analysis(analysis_id: String, analyses: State<ActiveAnalyses>) {
    if let Some(flag) = analyses.0.lock().unwrap().get(&analysis_id) {
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
            app.manage(ActiveAnalyses::default());
            app.manage(organize::ActiveOrganizes::default());
            app.manage(debug::LogState::default());
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
            let cli = cli_paths::parse_paths(std::env::args(), &cwd);
            app.manage(CliPaths(cli));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_stats,
            get_cli_paths,
            start_scan,
            cancel_scan,
            start_analysis,
            cancel_analysis,
            organize::start_organize,
            organize::cancel_organize,
            organize::respond_to_collision,
            results::get_last_scan,
            results::delete_files,
            results::prune_last_scan,
            thumbnails::get_thumbnail,
            debug::get_logs,
            debug::clear_logs,
            debug::push_log,
            debug::parse_filename_date_test
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
