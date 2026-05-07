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
    /// When true, scanner reads EXIF/container metadata for images and videos
    /// to determine the "original" capture date instead of filesystem mtime.
    /// Slower but more accurate when files have been copied/moved.
    pub use_metadata_dates: bool,
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
            use_metadata_dates: false,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_round_trips_via_serde() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.confirm_delete, s.confirm_delete);
        assert_eq!(back.move_to_trash, s.move_to_trash);
        assert_eq!(back.scan_threads, s.scan_threads);
        assert_eq!(back.language, s.language);
        assert_eq!(back.use_metadata_dates, s.use_metadata_dates);
    }

    #[test]
    fn settings_default_values() {
        let s = Settings::default();
        assert!(s.confirm_delete);
        assert!(s.move_to_trash);
        assert!(s.notifications);
        assert!(!s.ignore_hidden);
        assert!(!s.auto_scan);
        assert!(s.minimize_tray);
        assert_eq!(s.language, "English");
        assert!(!s.use_metadata_dates);
        assert_eq!(s.scan_threads, ScanThreads::Auto);
    }

    #[test]
    fn filters_default_values() {
        let f = Filters::default();
        assert!(f.extensions.is_none());
        assert!(f.ignored_extensions.is_empty());
        assert!(f.ignored_folders.is_empty());
        assert!(f.min_size.is_none());
        assert!(f.max_size.is_none());
        assert!(f.include_subdirs);
    }

    #[test]
    fn settings_tolerates_unknown_fields() {
        // Forward-compat: a settings file written by a future version with an
        // extra field should still deserialize — at worst falling back to
        // defaults if any required-shape mismatch occurs.
        let json = r#"{
            "confirmDelete": false,
            "futureUnknownField": 42
        }"#;
        let parsed: Result<Settings, _> = serde_json::from_str(json);
        // serde with serde(default) on the struct allows missing fields; unknown
        // fields are ignored by default. This must not error.
        assert!(parsed.is_ok());
        let s = parsed.unwrap();
        assert!(!s.confirm_delete);
    }

    #[test]
    fn settings_empty_object_yields_all_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        let d = Settings::default();
        assert_eq!(s.confirm_delete, d.confirm_delete);
        assert_eq!(s.language, d.language);
    }

    #[test]
    fn scan_threads_n_serializes_round_trip() {
        let t = ScanThreads::N(4);
        let json = serde_json::to_string(&t).unwrap();
        let back: ScanThreads = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ScanThreads::N(4));
    }

    #[test]
    fn filters_camel_case_round_trip() {
        let mut f = Filters::default();
        f.min_size = Some(1024);
        f.modified_after_ms = Some(123_456_789);
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("minSize"));
        assert!(json.contains("modifiedAfterMs"));
        let back: Filters = serde_json::from_str(&json).unwrap();
        assert_eq!(back.min_size, Some(1024));
        assert_eq!(back.modified_after_ms, Some(123_456_789));
    }
}
