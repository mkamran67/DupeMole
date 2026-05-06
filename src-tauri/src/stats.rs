use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LifetimeStats {
    pub total_bytes_freed: u64,
    pub total_files_deleted: u64,
    pub total_scans_run: u64,
}

pub struct StatsState(pub Mutex<LifetimeStats>);

fn stats_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("stats.json"))
        .map_err(|e| format!("failed to resolve app config dir: {e}"))
}

pub fn load(app: &AppHandle) -> LifetimeStats {
    let Ok(path) = stats_path(app) else {
        return LifetimeStats::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return LifetimeStats::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(app: &AppHandle, s: &LifetimeStats) -> Result<(), String> {
    let path = stats_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(s).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
