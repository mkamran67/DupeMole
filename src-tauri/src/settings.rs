use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Frontend distinguishes variants by exact PascalCase name (`'Auto'` and
/// `{ N: number }`), so this enum must serialize that way. Do not add a
/// `rename_all = "camelCase"` here — it would lowercase the variants and
/// silently break the scan-threads dropdown round-trip.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
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
    pub ignore_macos_files: bool,
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
            ignore_macos_files: false,
        }
    }
}

/// User-defined named file type: a label + a list of extensions, rendered
/// alongside the built-in presets (Images, Videos, …) in the UI.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CustomFileType {
    pub id: String,
    pub label: String,
    pub formats: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub confirm_delete: bool,
    pub scan_threads: ScanThreads,
    pub notifications: bool,
    pub ignore_hidden: bool,
    pub auto_scan: bool,
    pub minimize_tray: bool,
    pub language: String,
    pub scan_filters: Filters,
    pub organize_filters: Filters,
    #[serde(default)]
    pub custom_file_types: Vec<CustomFileType>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            confirm_delete: true,
            scan_threads: ScanThreads::Auto,
            notifications: true,
            ignore_hidden: false,
            auto_scan: false,
            minimize_tray: true,
            language: "English".to_string(),
            scan_filters: Filters::default(),
            organize_filters: Filters::default(),
            custom_file_types: Vec::new(),
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
    parse_settings(&bytes).unwrap_or_default()
}

/// Parse settings JSON, migrating the legacy single `filters` field into both
/// `scanFilters` and `organizeFilters` when the new fields are absent.
fn parse_settings(bytes: &[u8]) -> Option<Settings> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if let Some(obj) = value.as_object_mut() {
        let has_scan = obj.contains_key("scanFilters");
        let has_org = obj.contains_key("organizeFilters");
        if !has_scan || !has_org {
            if let Some(legacy) = obj.get("filters").cloned() {
                if !has_scan {
                    obj.insert("scanFilters".into(), legacy.clone());
                }
                if !has_org {
                    obj.insert("organizeFilters".into(), legacy);
                }
            }
        }
    }
    serde_json::from_value(value).ok()
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
        assert_eq!(back.scan_threads, s.scan_threads);
        assert_eq!(back.language, s.language);
    }

    #[test]
    fn settings_default_values() {
        let s = Settings::default();
        assert!(s.confirm_delete);
        assert!(s.notifications);
        assert!(!s.ignore_hidden);
        assert!(!s.auto_scan);
        assert!(s.minimize_tray);
        assert_eq!(s.language, "English");
        assert_eq!(s.scan_threads, ScanThreads::Auto);
    }

    #[test]
    fn settings_ignores_legacy_move_to_trash_and_metadata_fields() {
        let json = r#"{
            "moveToTrash": false,
            "useMetadataDates": true
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        // Both fields removed from struct; deserialization must succeed and
        // produce defaults for everything else.
        assert!(s.confirm_delete);
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
        assert!(!f.ignore_macos_files);
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
    fn scan_threads_serializes_in_pascal_case() {
        // The frontend distinguishes variants by exact name `Auto` / `N`, so
        // the wire format must keep PascalCase even though sibling structs
        // use camelCase. Regression: rename_all camelCase here used to break
        // the scan-threads dropdown round-trip.
        let auto = serde_json::to_string(&ScanThreads::Auto).unwrap();
        assert_eq!(auto, "\"Auto\"");
        let n = serde_json::to_string(&ScanThreads::N(4)).unwrap();
        assert_eq!(n, "{\"N\":4}");
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

    #[test]
    fn legacy_filters_field_migrates_into_both_new_fields() {
        let json = br#"{
            "filters": { "minSize": 4096, "ignoredFolders": ["node_modules"] }
        }"#;
        let s = parse_settings(json).unwrap();
        assert_eq!(s.scan_filters.min_size, Some(4096));
        assert_eq!(s.scan_filters.ignored_folders, vec!["node_modules".to_string()]);
        assert_eq!(s.organize_filters.min_size, Some(4096));
        assert_eq!(s.organize_filters.ignored_folders, vec!["node_modules".to_string()]);
    }

    #[test]
    fn explicit_new_fields_take_precedence_over_legacy() {
        let json = br#"{
            "filters":         { "minSize": 1 },
            "scanFilters":     { "minSize": 2 },
            "organizeFilters": { "minSize": 3 }
        }"#;
        let s = parse_settings(json).unwrap();
        assert_eq!(s.scan_filters.min_size, Some(2));
        assert_eq!(s.organize_filters.min_size, Some(3));
    }

    #[test]
    fn legacy_only_one_new_field_present_migrates_other() {
        let json = br#"{
            "filters":     { "minSize": 1 },
            "scanFilters": { "minSize": 9 }
        }"#;
        let s = parse_settings(json).unwrap();
        assert_eq!(s.scan_filters.min_size, Some(9));
        assert_eq!(s.organize_filters.min_size, Some(1));
    }

    #[test]
    fn settings_round_trip_keeps_filters_independent() {
        let mut s = Settings::default();
        s.scan_filters.min_size = Some(100);
        s.organize_filters.min_size = Some(200);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("scanFilters"));
        assert!(json.contains("organizeFilters"));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.scan_filters.min_size, Some(100));
        assert_eq!(back.organize_filters.min_size, Some(200));
    }
}
