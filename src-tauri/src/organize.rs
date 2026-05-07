use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::scanner::CancelToken;

#[derive(Default)]
pub struct ActiveOrganizes(pub Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>);

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum OrganizeOp {
    Copy,
    Move,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct Granularity {
    pub year: bool,
    pub month: bool,
    pub day: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeProgress {
    pub processed: u64,
    pub total: u64,
    pub current_path: Option<PathBuf>,
    pub phase: &'static str,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeError {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeComplete {
    pub processed: u64,
    pub copied: u64,
    pub moved: u64,
    pub skipped: u64,
    pub errors: Vec<OrganizeError>,
    pub cancelled: bool,
    pub target: String,
}

const MONTH_NAMES: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];

/// Inverse of civil_to_unix_ms. Returns (year, month [1..=12], day [1..=31]).
fn unix_ms_to_civil(ms: u64) -> (i32, u32, u32) {
    // days since unix epoch (1970-01-01)
    let secs = (ms / 1000) as i64;
    let mut days = secs.div_euclid(86_400);
    // Hinnant: convert to days from 0000-03-01
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn modified_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as u64)
}

fn resolved_date_ms(path: &Path) -> Option<u64> {
    crate::media_date::read_metadata_ms(path).or_else(|| modified_ms(path))
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

fn extension_allowed(path: &Path, allow: &Option<Vec<String>>) -> bool {
    let Some(allow) = allow else { return true };
    let Some(ext) = ext_lower(path) else { return false };
    allow.iter().any(|a| a.eq_ignore_ascii_case(&ext))
}

fn build_subdir(target: &Path, ms: u64, g: &Granularity) -> PathBuf {
    let mut out = target.to_path_buf();
    if !g.year {
        return out;
    }
    let (y, m, d) = unix_ms_to_civil(ms);
    out.push(format!("{:04}", y));
    if g.month {
        let name = MONTH_NAMES[(m as usize - 1).min(11)];
        out.push(format!("{:02}-{}", m, name));
        if g.day {
            out.push(format!("{:02}", d));
        }
    }
    out
}

/// Decide a non-conflicting destination path. If a file with the same name
/// already exists at `desired` and is byte-identical (same size + matching
/// BLAKE3 head/tail), return Ok(None) to signal "skip". Otherwise return a
/// unique path with " (1)", " (2)", … suffix.
fn resolve_destination(source: &Path, desired: PathBuf) -> std::io::Result<Option<PathBuf>> {
    if !desired.exists() {
        return Ok(Some(desired));
    }
    if files_byte_identical(source, &desired)? {
        return Ok(None);
    }
    let stem = desired
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = desired
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{}", s))
        .unwrap_or_default();
    let parent = desired.parent().unwrap_or_else(|| Path::new(""));
    for n in 1..u32::MAX {
        let candidate = parent.join(format!("{} ({}){}", stem, n, ext));
        if !candidate.exists() {
            return Ok(Some(candidate));
        }
        if files_byte_identical(source, &candidate)? {
            return Ok(None);
        }
    }
    Ok(Some(desired)) // unreachable in practice
}

fn files_byte_identical(a: &Path, b: &Path) -> std::io::Result<bool> {
    let am = std::fs::metadata(a)?;
    let bm = std::fs::metadata(b)?;
    if am.len() != bm.len() {
        return Ok(false);
    }
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 64 * 1024;
    let size = am.len();
    let mut fa = File::open(a)?;
    let mut fb = File::open(b)?;

    let head_len = CHUNK.min(size) as usize;
    let mut ha = vec![0u8; head_len];
    let mut hb = vec![0u8; head_len];
    fa.read_exact(&mut ha)?;
    fb.read_exact(&mut hb)?;
    if ha != hb {
        return Ok(false);
    }
    if size > CHUNK * 2 {
        let tail_start = size - CHUNK;
        fa.seek(SeekFrom::Start(tail_start))?;
        fb.seek(SeekFrom::Start(tail_start))?;
        let mut ta = vec![0u8; CHUNK as usize];
        let mut tb = vec![0u8; CHUNK as usize];
        fa.read_exact(&mut ta)?;
        fb.read_exact(&mut tb)?;
        if ta != tb {
            return Ok(false);
        }
    }
    Ok(true)
}

fn move_file(source: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(source, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Cross-device (or other rename failure) — fall back to copy + remove.
            std::fs::copy(source, dest)?;
            std::fs::remove_file(source)?;
            Ok(())
        }
    }
}

#[tauri::command]
pub fn start_organize(
    organize_id: Option<String>,
    sources: Vec<String>,
    target: String,
    op: OrganizeOp,
    granularity: Granularity,
    extensions: Option<Vec<String>>,
    app: AppHandle,
    organizes: State<ActiveOrganizes>,
) -> Result<String, String> {
    if sources.is_empty() {
        return Err("no source folders provided".into());
    }
    if target.trim().is_empty() {
        return Err("no target folder provided".into());
    }
    let target_path = PathBuf::from(&target);
    if !target_path.exists() {
        std::fs::create_dir_all(&target_path).map_err(|e| format!("create target: {e}"))?;
    }

    let organize_id = organize_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let cancel = CancelToken::new();
    organizes
        .0
        .lock()
        .unwrap()
        .insert(organize_id.clone(), cancel.0.clone());

    let app_handle = app.clone();
    let id_thread = organize_id.clone();
    let source_paths: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();

    std::thread::spawn(move || {
        let emit_progress = |p: OrganizeProgress| {
            let _ = app_handle.emit(
                "organize://progress",
                serde_json::json!({ "organizeId": id_thread, "progress": p }),
            );
        };

        emit_progress(OrganizeProgress {
            processed: 0,
            total: 0,
            current_path: None,
            phase: "walking",
        });

        // Phase 1: walk
        let mut files: Vec<PathBuf> = Vec::new();
        let mut last_emit = std::time::Instant::now();
        const EMIT_EVERY_FILES: usize = 256;
        const EMIT_EVERY_MS: u128 = 120;
        'outer: for root in &source_paths {
            for entry in WalkDir::new(root).follow_links(false) {
                if cancel.0.load(Ordering::SeqCst) {
                    break 'outer;
                }
                let Ok(entry) = entry else { continue };
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.into_path();
                if !extension_allowed(&path, &extensions) {
                    continue;
                }
                files.push(path.clone());
                let now = std::time::Instant::now();
                if files.len() % EMIT_EVERY_FILES == 0
                    || now.duration_since(last_emit).as_millis() >= EMIT_EVERY_MS
                {
                    last_emit = now;
                    emit_progress(OrganizeProgress {
                        processed: files.len() as u64,
                        total: 0,
                        current_path: Some(path),
                        phase: "walking",
                    });
                }
            }
        }

        let total = files.len() as u64;
        let cancelled_during_walk = cancel.0.load(Ordering::SeqCst);

        emit_progress(OrganizeProgress {
            processed: 0,
            total,
            current_path: None,
            phase: "organizing",
        });

        let processed = AtomicU64::new(0);
        let copied = AtomicU64::new(0);
        let moved = AtomicU64::new(0);
        let skipped = AtomicU64::new(0);
        let errors = Mutex::new(Vec::<OrganizeError>::new());

        if !cancelled_during_walk {
            files.par_iter().for_each(|src| {
                if cancel.0.load(Ordering::SeqCst) {
                    return;
                }
                let ms = resolved_date_ms(src).unwrap_or(0);
                let dir = build_subdir(&target_path, ms, &granularity);
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    errors.lock().unwrap().push(OrganizeError {
                        path: src.display().to_string(),
                        reason: format!("create dir: {e}"),
                    });
                    return;
                }
                let filename = match src.file_name() {
                    Some(n) => n.to_owned(),
                    None => return,
                };
                let desired = dir.join(&filename);
                let dest = match resolve_destination(src, desired) {
                    Ok(Some(p)) => p,
                    Ok(None) => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                        let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                        if done % 25 == 0 || done == total {
                            let _ = app_handle.emit(
                                "organize://progress",
                                serde_json::json!({
                                    "organizeId": id_thread,
                                    "progress": OrganizeProgress {
                                        processed: done,
                                        total,
                                        current_path: Some(src.clone()),
                                        phase: "organizing",
                                    }
                                }),
                            );
                        }
                        return;
                    }
                    Err(e) => {
                        errors.lock().unwrap().push(OrganizeError {
                            path: src.display().to_string(),
                            reason: format!("resolve dest: {e}"),
                        });
                        return;
                    }
                };

                let result = match op {
                    OrganizeOp::Copy => std::fs::copy(src, &dest).map(|_| ()),
                    OrganizeOp::Move => move_file(src, &dest),
                };

                match result {
                    Ok(()) => match op {
                        OrganizeOp::Copy => {
                            copied.fetch_add(1, Ordering::Relaxed);
                        }
                        OrganizeOp::Move => {
                            moved.fetch_add(1, Ordering::Relaxed);
                        }
                    },
                    Err(e) => errors.lock().unwrap().push(OrganizeError {
                        path: src.display().to_string(),
                        reason: e.to_string(),
                    }),
                }

                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if done % 25 == 0 || done == total {
                    let _ = app_handle.emit(
                        "organize://progress",
                        serde_json::json!({
                            "organizeId": id_thread,
                            "progress": OrganizeProgress {
                                processed: done,
                                total,
                                current_path: Some(src.clone()),
                                phase: "organizing",
                            }
                        }),
                    );
                }
            });
        }

        let was_cancelled = cancel.0.load(Ordering::SeqCst);
        let complete = OrganizeComplete {
            processed: processed.load(Ordering::Relaxed),
            copied: copied.load(Ordering::Relaxed),
            moved: moved.load(Ordering::Relaxed),
            skipped: skipped.load(Ordering::Relaxed),
            errors: errors.into_inner().unwrap(),
            cancelled: was_cancelled,
            target: target_path.display().to_string(),
        };

        let _ = app_handle.emit(
            "organize://complete",
            serde_json::json!({ "organizeId": id_thread, "result": complete }),
        );

        if let Some(map) = app_handle.try_state::<ActiveOrganizes>() {
            map.0.lock().unwrap().remove(&id_thread);
        }
    });

    Ok(organize_id)
}

#[tauri::command]
pub fn cancel_organize(organize_id: String, organizes: State<ActiveOrganizes>) {
    if let Some(flag) = organizes.0.lock().unwrap().get(&organize_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_ms_to_civil_known_dates() {
        // 2024-03-15 12:00:00 UTC = 1710504000 sec
        let (y, m, d) = unix_ms_to_civil(1_710_504_000_000);
        assert_eq!((y, m, d), (2024, 3, 15));
        // 1970-01-01
        let (y, m, d) = unix_ms_to_civil(0);
        assert_eq!((y, m, d), (1970, 1, 1));
        // 2000-02-29 (leap day)
        let (y, m, d) = unix_ms_to_civil(951_782_400_000);
        assert_eq!((y, m, d), (2000, 2, 29));
    }

    #[test]
    fn build_subdir_respects_granularity() {
        let target = PathBuf::from("/tmp/x");
        let ms = 1_710_504_000_000; // 2024-03-15
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(build_subdir(&target, ms, &g), PathBuf::from("/tmp/x/2024/03-March/15"));
        let g = Granularity { year: true, month: true, day: false };
        assert_eq!(build_subdir(&target, ms, &g), PathBuf::from("/tmp/x/2024/03-March"));
        let g = Granularity { year: true, month: false, day: false };
        assert_eq!(build_subdir(&target, ms, &g), PathBuf::from("/tmp/x/2024"));
        let g = Granularity { year: false, month: false, day: false };
        assert_eq!(build_subdir(&target, ms, &g), target);
    }

    use std::io::Write;

    fn tempdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!("dupemole-org-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn unix_ms_to_civil_year_boundaries() {
        // 1999-12-31 23:59:59 UTC = 946_684_799 sec
        let (y, m, d) = unix_ms_to_civil(946_684_799_000);
        assert_eq!((y, m, d), (1999, 12, 31));
        // 2000-01-01 00:00:00 UTC
        let (y, m, d) = unix_ms_to_civil(946_684_800_000);
        assert_eq!((y, m, d), (2000, 1, 1));
    }

    #[test]
    fn unix_ms_to_civil_2024_leap_day() {
        // 2024-02-29 00:00:00 UTC = 1_709_164_800 sec
        let (y, m, d) = unix_ms_to_civil(1_709_164_800_000);
        assert_eq!((y, m, d), (2024, 2, 29));
    }

    #[test]
    fn build_subdir_uses_month_name_format() {
        let target = PathBuf::from("/tmp/x");
        // 2024-01-15
        let ms = 1_705_276_800_000;
        let g = Granularity { year: true, month: true, day: false };
        assert_eq!(build_subdir(&target, ms, &g), PathBuf::from("/tmp/x/2024/01-January"));
    }

    #[test]
    fn build_subdir_zero_ms_is_epoch() {
        let target = PathBuf::from("/t");
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(build_subdir(&target, 0, &g), PathBuf::from("/t/1970/01-January/01"));
    }

    #[test]
    fn extension_allowed_with_no_filter_passes_all() {
        assert!(extension_allowed(Path::new("/x/file.foo"), &None));
        assert!(extension_allowed(Path::new("/x/no_ext"), &None));
    }

    #[test]
    fn extension_allowed_filter_is_case_insensitive() {
        let allow = Some(vec!["jpg".into(), "png".into()]);
        assert!(extension_allowed(Path::new("/x/photo.JPG"), &allow));
        assert!(extension_allowed(Path::new("/x/photo.png"), &allow));
        assert!(!extension_allowed(Path::new("/x/doc.pdf"), &allow));
    }

    #[test]
    fn extension_allowed_rejects_extensionless_when_filter_present() {
        let allow = Some(vec!["jpg".into()]);
        assert!(!extension_allowed(Path::new("/x/no_ext"), &allow));
    }

    #[test]
    fn files_byte_identical_detects_match() {
        let dir = tempdir();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        write_file(&a, b"identical-content");
        write_file(&b, b"identical-content");
        assert!(files_byte_identical(&a, &b).unwrap());
    }

    #[test]
    fn files_byte_identical_detects_different_size() {
        let dir = tempdir();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        write_file(&a, b"short");
        write_file(&b, b"longer-content");
        assert!(!files_byte_identical(&a, &b).unwrap());
    }

    #[test]
    fn files_byte_identical_detects_same_size_different_bytes() {
        let dir = tempdir();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        write_file(&a, b"AAAAAAAAAA");
        write_file(&b, b"BBBBBBBBBB");
        assert!(!files_byte_identical(&a, &b).unwrap());
    }

    #[test]
    fn resolve_destination_returns_desired_when_free() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        write_file(&src, b"data");
        let desired = dir.join("dest").join("src.txt");
        let result = resolve_destination(&src, desired.clone()).unwrap();
        assert_eq!(result, Some(desired));
    }

    #[test]
    fn resolve_destination_skips_when_identical_already_at_desired() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"same");
        write_file(&dest, b"same");
        let result = resolve_destination(&src, dest).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn resolve_destination_appends_suffix_on_collision() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"new-content");
        write_file(&dest, b"existing-different-content");
        let result = resolve_destination(&src, dest.clone()).unwrap();
        let resolved = result.unwrap();
        assert_ne!(resolved, dest);
        assert!(resolved.file_name().unwrap().to_str().unwrap().contains("(1)"));
    }

    #[test]
    fn move_file_within_same_dir_succeeds() {
        let dir = tempdir();
        let src = dir.join("a.txt");
        let dest = dir.join("b.txt");
        write_file(&src, b"hello");
        move_file(&src, &dest).unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }
}
