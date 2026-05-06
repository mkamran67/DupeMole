use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScanThreads {
    Auto,
    N(u8),
}

impl Default for ScanThreads {
    fn default() -> Self {
        ScanThreads::Auto
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Filters {
    pub extensions: Option<Vec<String>>,
    pub ignored_extensions: Vec<String>,
    pub ignored_folders: Vec<String>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub modified_after_ms: Option<u64>,
    pub modified_before_ms: Option<u64>,
    pub include_subdirs: bool,
}

impl Default for Filters {
    fn default() -> Self {
        Self {
            extensions: None,
            ignored_extensions: Vec::new(),
            ignored_folders: Vec::new(),
            min_size: None,
            max_size: None,
            modified_after_ms: None,
            modified_before_ms: None,
            include_subdirs: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub confirm_delete: bool,
    pub move_to_trash: bool,
    pub scan_threads: ScanThreads,
    pub notifications: bool,
    pub ignore_hidden: bool,
    pub auto_scan: bool,
    pub minimize_tray: bool,
    pub language: String,
    pub filters: Filters,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            confirm_delete: true,
            move_to_trash: true,
            scan_threads: ScanThreads::Auto,
            notifications: true,
            ignore_hidden: false,
            auto_scan: false,
            minimize_tray: true,
            language: "English".to_string(),
            filters: Filters::default(),
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| format!("failed to resolve app config dir: {e}"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return Settings::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(s).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
