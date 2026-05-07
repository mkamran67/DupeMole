use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::scanner::ScanComplete;
use crate::stats::{self, StatsState};

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
    pub freed_bytes: u64,
}

#[tauri::command]
pub fn delete_files(
    paths: Vec<String>,
    permanent: bool,
    app: AppHandle,
    stats_state: State<StatsState>,
) -> DeleteResult {
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    let mut freed_bytes: u64 = 0;
    for path in paths {
        let p = Path::new(&path);
        let size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let result: Result<(), String> = if permanent {
            fs::remove_file(p).map_err(|e| e.to_string())
        } else {
            trash::delete(p).map_err(|e| e.to_string())
        };
        match result {
            Ok(()) => {
                freed_bytes = freed_bytes.saturating_add(size);
                deleted.push(path);
            }
            Err(error) => failed.push(DeleteFailure { path, error }),
        }
    }

    if !deleted.is_empty() {
        let snapshot = {
            let mut s = stats_state.0.lock().unwrap();
            s.total_bytes_freed = s.total_bytes_freed.saturating_add(freed_bytes);
            s.total_files_deleted = s.total_files_deleted.saturating_add(deleted.len() as u64);
            *s
        };
        if let Err(e) = stats::save(&app, &snapshot) {
            eprintln!("stats::save failed: {e}");
        }
    }

    DeleteResult { deleted, failed, freed_bytes }
}

fn recompute_summary(scan: &mut ScanComplete) {
    scan.duplicate_files = scan.groups.iter().map(|g| g.files.len() as u64).sum();
    scan.wasted_bytes = scan
        .groups
        .iter()
        .map(|g| g.size * (g.files.len() as u64).saturating_sub(1))
        .sum();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{DuplicateFile, DuplicateGroup, HashKind};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn make_group(id: &str, size: u64, paths: &[&str]) -> DuplicateGroup {
        DuplicateGroup {
            id: id.into(),
            hash: format!("hash-{id}"),
            size,
            hash_kind: HashKind::Full,
            files: paths
                .iter()
                .map(|p| DuplicateFile {
                    path: PathBuf::from(p),
                    size,
                    modified_ms: None,
                })
                .collect(),
        }
    }

    fn make_scan(groups: Vec<DuplicateGroup>) -> ScanComplete {
        ScanComplete {
            groups,
            total_files: 0,
            duplicate_files: 0,
            wasted_bytes: 0,
            extension_counts: HashMap::new(),
        }
    }

    #[test]
    fn recompute_summary_sets_duplicate_files_and_wasted_bytes() {
        let mut scan = make_scan(vec![
            make_group("1", 100, &["/a", "/b", "/c"]), // 3 files, 100 bytes → wasted 200
            make_group("2", 50, &["/d", "/e"]),        // 2 files, 50 bytes → wasted 50
        ]);
        recompute_summary(&mut scan);
        assert_eq!(scan.duplicate_files, 5);
        assert_eq!(scan.wasted_bytes, 250);
    }

    #[test]
    fn recompute_summary_handles_empty_groups() {
        let mut scan = make_scan(vec![]);
        recompute_summary(&mut scan);
        assert_eq!(scan.duplicate_files, 0);
        assert_eq!(scan.wasted_bytes, 0);
    }

    #[test]
    fn recompute_summary_handles_singleton_group_without_underflow() {
        // Defense against (count - 1) underflow when a group somehow has 1 file.
        let mut scan = make_scan(vec![make_group("solo", 100, &["/a"])]);
        recompute_summary(&mut scan);
        assert_eq!(scan.duplicate_files, 1);
        assert_eq!(scan.wasted_bytes, 0);
    }

    #[test]
    fn delete_result_serializes_with_camel_case() {
        let r = DeleteResult {
            deleted: vec!["/a".into()],
            failed: vec![DeleteFailure {
                path: "/b".into(),
                error: "boom".into(),
            }],
            freed_bytes: 1024,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("freedBytes"));
        assert!(json.contains("\"deleted\""));
        assert!(json.contains("\"failed\""));
    }

    #[test]
    fn scan_complete_round_trips_via_serde() {
        let scan = make_scan(vec![make_group("1", 10, &["/a", "/b"])]);
        let json = serde_json::to_vec(&scan).unwrap();
        let back: ScanComplete = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.groups.len(), 1);
        assert_eq!(back.groups[0].files.len(), 2);
    }

    #[test]
    fn scan_complete_corrupt_json_fails_gracefully() {
        let result: Result<ScanComplete, _> = serde_json::from_slice(b"not valid json");
        assert!(result.is_err());
    }
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
