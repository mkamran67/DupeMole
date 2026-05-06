use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::scanner::ScanComplete;

fn last_scan_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("last_scan.json"))
        .map_err(|e| format!("failed to resolve app config dir: {e}"))
}

pub fn save_last_scan(app: &AppHandle, scan: &ScanComplete) -> Result<(), String> {
    let path = last_scan_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(scan).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

fn load_last_scan(app: &AppHandle) -> Option<ScanComplete> {
    let path = last_scan_path(app).ok()?;
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub fn get_last_scan(app: AppHandle) -> Option<ScanComplete> {
    load_last_scan(&app)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
}

#[tauri::command]
pub fn delete_files(paths: Vec<String>, permanent: bool) -> DeleteResult {
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        let p = Path::new(&path);
        let result: Result<(), String> = if permanent {
            fs::remove_file(p).map_err(|e| e.to_string())
        } else {
            trash::delete(p).map_err(|e| e.to_string())
        };
        match result {
            Ok(()) => deleted.push(path),
            Err(error) => failed.push(DeleteFailure { path, error }),
        }
    }
    DeleteResult { deleted, failed }
}

fn recompute_summary(scan: &mut ScanComplete) {
    scan.duplicate_files = scan.groups.iter().map(|g| g.files.len() as u64).sum();
    scan.wasted_bytes = scan
        .groups
        .iter()
        .map(|g| g.size * (g.files.len() as u64).saturating_sub(1))
        .sum();
}

#[tauri::command]
pub fn prune_last_scan(app: AppHandle, deleted: Vec<String>) -> Option<ScanComplete> {
    let mut scan = load_last_scan(&app)?;
    let deleted_set: std::collections::HashSet<&str> =
        deleted.iter().map(|s| s.as_str()).collect();
    for group in scan.groups.iter_mut() {
        group.files.retain(|f| {
            f.path
                .to_str()
                .map(|s| !deleted_set.contains(s))
                .unwrap_or(true)
        });
    }
    scan.groups.retain(|g| g.files.len() >= 2);
    recompute_summary(&mut scan);
    let _ = save_last_scan(&app, &scan);
    Some(scan)
}
