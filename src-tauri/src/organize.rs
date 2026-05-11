use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::scanner::{is_macos_metadata_dir, is_macos_metadata_file, CancelToken};

/// What to do when a real (non-identical) destination collision happens.
/// `*All` variants stick for the remainder of the organize run.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CollisionDecision {
    Overwrite,
    Skip,
    KeepBoth,
    OverwriteAll,
    SkipAll,
    KeepBothAll,
    Cancel,
}

impl CollisionDecision {
    fn is_apply_to_all(self) -> bool {
        matches!(self, Self::OverwriteAll | Self::SkipAll | Self::KeepBothAll)
    }
}

/// Per-organize shared state for resolving collisions via a modal prompt.
/// Workers consult `apply_to_all` first; if unset, they serialize on
/// `prompt_lock`, emit a `collision` event, and wait on `inner`/`cond` for
/// the frontend to call `respond_to_collision`. While a prompt is open,
/// `inner.paused` is set so other rayon workers stall at `wait_if_paused`
/// instead of organizing files behind the user's back.
#[derive(Default)]
pub struct CollisionState {
    prompt_lock: Mutex<()>,
    inner: Mutex<PromptInner>,
    cond: Condvar,
    apply_to_all: Mutex<Option<CollisionDecision>>,
}

#[derive(Default)]
struct PromptInner {
    paused: bool,
    pending: Option<CollisionDecision>,
}

impl CollisionState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Block until a decision is available, emitting the prompt event only
    /// when no sticky decision exists. Pauses all workers via the gate while
    /// the prompt is open. Returns `None` if cancellation kicked in.
    fn await_decision<F: FnOnce()>(
        &self,
        cancel: &CancelToken,
        emit_event: F,
    ) -> Option<CollisionDecision> {
        if let Some(d) = *self.apply_to_all.lock().unwrap() {
            return Some(d);
        }
        // Serialize prompts: only one collision modal in flight at a time.
        let _guard = self.prompt_lock.lock().unwrap();
        // Re-check under the lock — another worker may have set apply_to_all
        // while we were queuing.
        if let Some(d) = *self.apply_to_all.lock().unwrap() {
            return Some(d);
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.paused = true;
            inner.pending = None;
        }
        emit_event();
        let mut inner = self.inner.lock().unwrap();
        loop {
            if cancel.0.load(Ordering::SeqCst) {
                inner.paused = false;
                self.cond.notify_all();
                return None;
            }
            if let Some(d) = inner.pending {
                inner.paused = false;
                if d.is_apply_to_all() {
                    *self.apply_to_all.lock().unwrap() = Some(d);
                }
                self.cond.notify_all();
                return Some(d);
            }
            let (g, _) = self
                .cond
                .wait_timeout(inner, Duration::from_millis(100))
                .unwrap();
            inner = g;
        }
    }

    /// Gate that other workers check before starting their next file. Blocks
    /// while a prompt is open. Returns `false` if cancellation fires while
    /// waiting (caller should bail out cleanly).
    pub fn wait_if_paused(&self, cancel: &CancelToken) -> bool {
        let mut inner = self.inner.lock().unwrap();
        while inner.paused {
            if cancel.0.load(Ordering::SeqCst) {
                return false;
            }
            let (g, _) = self
                .cond
                .wait_timeout(inner, Duration::from_millis(100))
                .unwrap();
            inner = g;
        }
        true
    }

    /// Frontend response: store the decision and wake the waiting worker.
    fn respond(&self, decision: CollisionDecision) {
        self.inner.lock().unwrap().pending = Some(decision);
        self.cond.notify_all();
    }
}

/// Outcome of resolving a destination path for one source file.
#[derive(Debug)]
enum Resolution {
    /// No collision; copy/move to this path normally.
    Use(PathBuf),
    /// Collision resolved by overwriting the existing file at this path.
    Overwrite(PathBuf),
    /// Collision resolved by keeping both under a numbered suffix.
    Renamed(PathBuf),
    /// Existing file is byte-identical; nothing to do.
    SkipIdentical,
    /// User chose Skip/Skip All for this collision.
    SkippedByUser,
    /// User cancelled, or cancellation was already in flight.
    Cancelled,
}

/// One active organize: cancel signal + collision state, looked up by
/// `organize_id` in `ActiveOrganizes`.
pub struct OrganizeHandle {
    pub cancel: Arc<AtomicBool>,
    pub collision: Arc<CollisionState>,
}

#[derive(Default)]
pub struct ActiveOrganizes(pub Mutex<HashMap<String, OrganizeHandle>>);

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum OrganizeOp {
    Copy,
    Move,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Granularity {
    pub year: bool,
    pub month: bool,
    pub day: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DateSource {
    Metadata,
    Filename,
    Fallback,
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
    /// Byte-identical destinations — silent skips (existing behavior).
    pub skipped_identical: u64,
    /// User chose Skip / Skip All in the collision prompt.
    pub skipped_by_user: u64,
    /// User chose Overwrite / Overwrite All.
    pub overwritten: u64,
    /// User chose Keep Both / Keep Both All — written to a numbered path.
    pub renamed: u64,
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

/// Older of created/modified, falling back to whichever is available.
/// `Metadata::created()` is not supported on every platform / filesystem —
/// the `.ok()` chain degrades gracefully to modified-only.
fn fallback_ms(path: &Path) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let m = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let c = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    match (m, c) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => 0,
    }
}

fn resolved_date(path: &Path) -> (u64, DateSource) {
    if let Some(ms) = crate::media_date::read_metadata_ms(path) {
        return (ms, DateSource::Metadata);
    }
    if let Some(ms) = crate::media_date::read_filename_date_ms(path) {
        return (ms, DateSource::Filename);
    }
    (fallback_ms(path), DateSource::Fallback)
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

fn build_subdir(
    target: &Path,
    ms: u64,
    category: crate::media_date::FileCategory,
    src: DateSource,
    g: &Granularity,
    unknown_subfolder: &str,
) -> PathBuf {
    use crate::media_date::{category_folder_name, FileCategory};
    let mut out = target.to_path_buf();
    out.push(category_folder_name(category));

    match category {
        FileCategory::Image | FileCategory::Video => {
            // No reliable date → flat <Category>/Unknown/, no Y/M/D below.
            if src == DateSource::Fallback {
                out.push("Unknown");
                return out;
            }
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
        FileCategory::Pdf | FileCategory::Audio | FileCategory::Doc | FileCategory::Archive => out,
        FileCategory::Unknown => {
            out.push(unknown_subfolder);
            out
        }
    }
}

/// Find the next free numbered-suffix path for `desired`, treating any
/// byte-identical existing candidate along the way as a skip. Used by the
/// `KeepBoth` decision branch and as a building block for tests.
fn next_keep_both_path(source: &Path, desired: &Path) -> std::io::Result<Resolution> {
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
            return Ok(Resolution::Renamed(candidate));
        }
        if files_byte_identical(source, &candidate)? {
            return Ok(Resolution::SkipIdentical);
        }
    }
    Ok(Resolution::SkipIdentical) // unreachable in practice
}

/// Decide the destination outcome for one source file. Every collision
/// (including byte-identical destinations) consults `CollisionState` for a
/// user decision so that Overwrite All / Skip All / Keep Both All / Cancel
/// govern the whole run uniformly — no silent skips the user can't see.
fn resolve_with_collision_state<F: FnOnce()>(
    source: &Path,
    desired: PathBuf,
    state: &CollisionState,
    cancel: &CancelToken,
    emit_event: F,
) -> std::io::Result<Resolution> {
    if !desired.exists() {
        return Ok(Resolution::Use(desired));
    }
    let Some(decision) = state.await_decision(cancel, emit_event) else {
        return Ok(Resolution::Cancelled);
    };
    match decision {
        CollisionDecision::Skip | CollisionDecision::SkipAll => Ok(Resolution::SkippedByUser),
        CollisionDecision::Overwrite | CollisionDecision::OverwriteAll => {
            Ok(Resolution::Overwrite(desired))
        }
        CollisionDecision::KeepBoth | CollisionDecision::KeepBothAll => {
            next_keep_both_path(source, &desired)
        }
        CollisionDecision::Cancel => {
            cancel.0.store(true, Ordering::SeqCst);
            Ok(Resolution::Cancelled)
        }
    }
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

/// Outcome category used to drive counters in the par_iter body.
enum ResolutionKind {
    Normal,
    Overwrite,
    Renamed,
}

fn emit_organizing_progress(
    app: &AppHandle,
    id: &str,
    processed: &AtomicU64,
    total: u64,
    src: &Path,
) {
    let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
    if done % 25 == 0 || done == total {
        let _ = app.emit(
            "organize://progress",
            serde_json::json!({
                "organizeId": id,
                "progress": OrganizeProgress {
                    processed: done,
                    total,
                    current_path: Some(src.to_path_buf()),
                    phase: "organizing",
                }
            }),
        );
    }
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
    min_size: Option<u64>,
    ignore_macos_files: Option<bool>,
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
    let collision_state = Arc::new(CollisionState::new());
    organizes.0.lock().unwrap().insert(
        organize_id.clone(),
        OrganizeHandle {
            cancel: cancel.0.clone(),
            collision: collision_state.clone(),
        },
    );

    let app_handle = app.clone();
    let id_thread = organize_id.clone();
    let collision_thread = collision_state.clone();
    let source_paths: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    let ignore_macos = ignore_macos_files.unwrap_or(false);
    let min_size_bytes = min_size.unwrap_or(0);

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
            let walker = WalkDir::new(root)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| {
                    if !ignore_macos {
                        return true;
                    }
                    if !e.file_type().is_dir() {
                        return true;
                    }
                    let name = e.file_name().to_str().unwrap_or("");
                    !is_macos_metadata_dir(name)
                });
            for entry in walker {
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
                if ignore_macos {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if is_macos_metadata_file(name) {
                            continue;
                        }
                    }
                }
                if min_size_bytes > 0 {
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    if size < min_size_bytes {
                        continue;
                    }
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
        let skipped_identical = AtomicU64::new(0);
        let skipped_by_user = AtomicU64::new(0);
        let overwritten = AtomicU64::new(0);
        let renamed = AtomicU64::new(0);
        let errors = Mutex::new(Vec::<OrganizeError>::new());

        if !cancelled_during_walk {
            files.par_iter().for_each(|src| {
                if cancel.0.load(Ordering::SeqCst) {
                    return;
                }
                // Stall here while any collision prompt is open — we don't
                // want this worker organizing files behind the user's back.
                if !collision_thread.wait_if_paused(&cancel) {
                    return;
                }
                if cancel.0.load(Ordering::SeqCst) {
                    return;
                }
                let (ms, date_src) = resolved_date(src);
                let category = crate::media_date::file_category(src);
                let unknown_sub = crate::media_date::unknown_subfolder_name(src);
                let dir = build_subdir(&target_path, ms, category, date_src, &granularity, &unknown_sub);
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

                let source_size = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
                let existing_size = std::fs::metadata(&desired).map(|m| m.len()).unwrap_or(0);
                let app_for_emit = app_handle.clone();
                let id_for_emit = id_thread.clone();
                let src_for_emit = src.clone();
                let desired_for_emit = desired.clone();
                let emit_collision = move || {
                    let _ = app_for_emit.emit(
                        "organize://collision",
                        serde_json::json!({
                            "organizeId": id_for_emit,
                            "sourcePath": src_for_emit,
                            "desiredPath": desired_for_emit,
                            "sourceSize": source_size,
                            "existingSize": existing_size,
                        }),
                    );
                };

                let resolution =
                    match resolve_with_collision_state(src, desired, &collision_thread, &cancel, emit_collision) {
                        Ok(r) => r,
                        Err(e) => {
                            errors.lock().unwrap().push(OrganizeError {
                                path: src.display().to_string(),
                                reason: format!("resolve dest: {e}"),
                            });
                            return;
                        }
                    };

                let (dest_opt, kind) = match resolution {
                    Resolution::Use(p) => (Some(p), ResolutionKind::Normal),
                    Resolution::Overwrite(p) => (Some(p), ResolutionKind::Overwrite),
                    Resolution::Renamed(p) => (Some(p), ResolutionKind::Renamed),
                    Resolution::SkipIdentical => {
                        skipped_identical.fetch_add(1, Ordering::Relaxed);
                        emit_organizing_progress(
                            &app_handle,
                            &id_thread,
                            &processed,
                            total,
                            src,
                        );
                        return;
                    }
                    Resolution::SkippedByUser => {
                        skipped_by_user.fetch_add(1, Ordering::Relaxed);
                        emit_organizing_progress(
                            &app_handle,
                            &id_thread,
                            &processed,
                            total,
                            src,
                        );
                        return;
                    }
                    Resolution::Cancelled => return,
                };

                let dest = match dest_opt {
                    Some(p) => p,
                    None => return,
                };

                // Overwrite path: rename() on Windows won't replace; remove first.
                if matches!(kind, ResolutionKind::Overwrite) && dest.exists() {
                    if let Err(e) = std::fs::remove_file(&dest) {
                        errors.lock().unwrap().push(OrganizeError {
                            path: src.display().to_string(),
                            reason: format!("remove existing: {e}"),
                        });
                        return;
                    }
                }

                let result = match op {
                    OrganizeOp::Copy => std::fs::copy(src, &dest).map(|_| ()),
                    OrganizeOp::Move => move_file(src, &dest),
                };

                match result {
                    Ok(()) => match kind {
                        ResolutionKind::Overwrite => {
                            overwritten.fetch_add(1, Ordering::Relaxed);
                        }
                        ResolutionKind::Renamed => {
                            renamed.fetch_add(1, Ordering::Relaxed);
                        }
                        ResolutionKind::Normal => match op {
                            OrganizeOp::Copy => {
                                copied.fetch_add(1, Ordering::Relaxed);
                            }
                            OrganizeOp::Move => {
                                moved.fetch_add(1, Ordering::Relaxed);
                            }
                        },
                    },
                    Err(e) => errors.lock().unwrap().push(OrganizeError {
                        path: src.display().to_string(),
                        reason: e.to_string(),
                    }),
                }

                emit_organizing_progress(&app_handle, &id_thread, &processed, total, src);
            });
        }

        let was_cancelled = cancel.0.load(Ordering::SeqCst);
        let complete = OrganizeComplete {
            processed: processed.load(Ordering::Relaxed),
            copied: copied.load(Ordering::Relaxed),
            moved: moved.load(Ordering::Relaxed),
            skipped_identical: skipped_identical.load(Ordering::Relaxed),
            skipped_by_user: skipped_by_user.load(Ordering::Relaxed),
            overwritten: overwritten.load(Ordering::Relaxed),
            renamed: renamed.load(Ordering::Relaxed),
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
    if let Some(handle) = organizes.0.lock().unwrap().get(&organize_id) {
        handle.cancel.store(true, Ordering::SeqCst);
        // Wake any worker that's currently blocked on a collision prompt so
        // it observes the cancel and bails out.
        handle.collision.cond.notify_all();
    }
}

#[tauri::command]
pub fn respond_to_collision(
    organize_id: String,
    decision: CollisionDecision,
    organizes: State<ActiveOrganizes>,
) {
    if let Some(handle) = organizes.0.lock().unwrap().get(&organize_id) {
        handle.collision.respond(decision);
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

    use crate::media_date::FileCategory;

    fn sub_image(target: &Path, ms: u64, g: &Granularity) -> PathBuf {
        build_subdir(target, ms, FileCategory::Image, DateSource::Metadata, g, "")
    }

    #[test]
    fn build_subdir_image_full_date_hierarchy() {
        let target = PathBuf::from("/t");
        let ms = 1_710_504_000_000; // 2024-03-15
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(sub_image(&target, ms, &g), PathBuf::from("/t/Images/2024/03-March/15"));
    }

    #[test]
    fn build_subdir_image_year_only() {
        let target = PathBuf::from("/t");
        let ms = 1_710_504_000_000;
        let g = Granularity { year: true, month: false, day: false };
        assert_eq!(sub_image(&target, ms, &g), PathBuf::from("/t/Images/2024"));
    }

    #[test]
    fn build_subdir_image_no_date_toggles_only_category() {
        let target = PathBuf::from("/t");
        let ms = 1_710_504_000_000;
        let g = Granularity { year: false, month: false, day: false };
        assert_eq!(sub_image(&target, ms, &g), PathBuf::from("/t/Images"));
    }

    #[test]
    fn build_subdir_image_fallback_routes_to_category_unknown() {
        let target = PathBuf::from("/t");
        let ms = 1_710_504_000_000;
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(
            build_subdir(&target, ms, FileCategory::Image, DateSource::Fallback, &g, ""),
            PathBuf::from("/t/Images/Unknown"),
        );
        assert_eq!(
            build_subdir(&target, ms, FileCategory::Video, DateSource::Fallback, &g, ""),
            PathBuf::from("/t/Videos/Unknown"),
        );
    }

    #[test]
    fn build_subdir_video_year_only() {
        let target = PathBuf::from("/t");
        let ms = 1_710_504_000_000;
        let g = Granularity { year: true, month: false, day: false };
        assert_eq!(
            build_subdir(&target, ms, FileCategory::Video, DateSource::Metadata, &g, ""),
            PathBuf::from("/t/Videos/2024"),
        );
    }

    #[test]
    fn build_subdir_pdf_is_flat_regardless_of_granularity_or_source() {
        let target = PathBuf::from("/t");
        let ms = 1_710_504_000_000;
        let g_full = Granularity { year: true, month: true, day: true };
        let g_none = Granularity { year: false, month: false, day: false };
        assert_eq!(
            build_subdir(&target, ms, FileCategory::Pdf, DateSource::Metadata, &g_full, ""),
            PathBuf::from("/t/PDFs"),
        );
        assert_eq!(
            build_subdir(&target, ms, FileCategory::Pdf, DateSource::Fallback, &g_none, ""),
            PathBuf::from("/t/PDFs"),
        );
    }

    #[test]
    fn build_subdir_audio_doc_archive_are_flat() {
        let target = PathBuf::from("/t");
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(
            build_subdir(&target, 0, FileCategory::Audio, DateSource::Metadata, &g, ""),
            PathBuf::from("/t/Audio"),
        );
        assert_eq!(
            build_subdir(&target, 0, FileCategory::Doc, DateSource::Metadata, &g, ""),
            PathBuf::from("/t/Docs"),
        );
        assert_eq!(
            build_subdir(&target, 0, FileCategory::Archive, DateSource::Metadata, &g, ""),
            PathBuf::from("/t/Archives"),
        );
    }

    #[test]
    fn build_subdir_unknown_uses_subfolder_name() {
        let target = PathBuf::from("/t");
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(
            build_subdir(&target, 0, FileCategory::Unknown, DateSource::Fallback, &g, "LOG"),
            PathBuf::from("/t/Unknown/LOG"),
        );
        assert_eq!(
            build_subdir(&target, 0, FileCategory::Unknown, DateSource::Metadata, &g, "NoExtension"),
            PathBuf::from("/t/Unknown/NoExtension"),
        );
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
        let ms = 1_705_276_800_000; // 2024-01-15
        let g = Granularity { year: true, month: true, day: false };
        assert_eq!(sub_image(&target, ms, &g), PathBuf::from("/tmp/x/Images/2024/01-January"));
    }

    #[test]
    fn build_subdir_zero_ms_is_epoch() {
        let target = PathBuf::from("/t");
        let g = Granularity { year: true, month: true, day: true };
        assert_eq!(sub_image(&target, 0, &g), PathBuf::from("/t/Images/1970/01-January/01"));
    }

    #[test]
    fn fallback_ms_returns_nonzero_for_real_file() {
        let dir = tempdir();
        let path = dir.join("file.bin");
        write_file(&path, b"hello");
        let ms = fallback_ms(&path);
        // File was just written; ms should be a recent unix-ms value.
        assert!(ms > 1_700_000_000_000, "expected recent ms, got {ms}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fallback_ms_missing_file_returns_zero() {
        let path = PathBuf::from("/definitely/does/not/exist-xyz.bin");
        assert_eq!(fallback_ms(&path), 0);
    }

    #[test]
    fn resolved_date_uses_fallback_when_no_metadata_or_filename() {
        let dir = tempdir();
        // Plain .bin: no image/video metadata, no parseable date in stem.
        let path = dir.join("plain.bin");
        write_file(&path, b"x");
        let (_ms, src) = resolved_date(&path);
        assert_eq!(src, DateSource::Fallback);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolved_date_uses_filename_when_no_metadata() {
        let dir = tempdir();
        // .bin won't have media metadata; filename has a parseable date.
        let path = dir.join("2025-02-11-0005.bin");
        write_file(&path, b"x");
        let (_ms, src) = resolved_date(&path);
        assert_eq!(src, DateSource::Filename);
        let _ = std::fs::remove_dir_all(&dir);
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

    fn dummy_emit() {}

    #[test]
    fn resolve_returns_use_when_destination_is_free() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        write_file(&src, b"data");
        let desired = dir.join("dest").join("src.txt");
        let state = CollisionState::new();
        let cancel = CancelToken::new();
        let result =
            resolve_with_collision_state(&src, desired.clone(), &state, &cancel, dummy_emit).unwrap();
        assert!(matches!(result, Resolution::Use(p) if p == desired));
    }

    #[test]
    fn byte_identical_collision_prompts_when_no_sticky_decision() {
        // Identical files must trigger the collision prompt and obey the
        // user's decision, so that Overwrite All / Skip All / Keep Both All
        // govern the run uniformly — never a silent skip the user can't see.
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"same");
        write_file(&dest, b"same");
        let state = Arc::new(CollisionState::new());
        let cancel = CancelToken::new();
        let emit_called = Arc::new(AtomicBool::new(false));

        let state_for_responder = state.clone();
        let responder = std::thread::spawn(move || {
            // Wait up to ~1s for the prompt to open, then respond. Bounded so
            // the test fails fast if the prompt never fires.
            for _ in 0..200 {
                if state_for_responder.inner.lock().unwrap().paused {
                    state_for_responder.respond(CollisionDecision::OverwriteAll);
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });

        let emit_for_closure = emit_called.clone();
        let result = resolve_with_collision_state(&src, dest.clone(), &state, &cancel, || {
            emit_for_closure.store(true, Ordering::SeqCst);
        })
        .unwrap();
        responder.join().unwrap();
        assert!(emit_called.load(Ordering::SeqCst), "expected prompt to fire for byte-identical collision");
        assert!(matches!(result, Resolution::Overwrite(p) if p == dest));
    }

    #[test]
    fn resolve_returns_skipped_by_user_when_apply_to_all_is_skip_all() {
        // Real collision (different content) + sticky SkipAll → no prompt,
        // skip recorded.
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"new-content");
        write_file(&dest, b"existing-different");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::SkipAll);
        let cancel = CancelToken::new();
        let result = resolve_with_collision_state(&src, dest, &state, &cancel, || {
            panic!("must not prompt when apply_to_all is set");
        })
        .unwrap();
        assert!(matches!(result, Resolution::SkippedByUser));
    }

    #[test]
    fn byte_identical_obeys_sticky_overwrite_all_instead_of_skipping_silently() {
        // Once the user has chosen Overwrite All, even byte-identical
        // collisions must obey it (and count as overwritten), rather than
        // being silently dropped.
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"same");
        write_file(&dest, b"same");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::OverwriteAll);
        let cancel = CancelToken::new();
        let result = resolve_with_collision_state(&src, dest.clone(), &state, &cancel, || {
            panic!("must not prompt when apply_to_all is set");
        })
        .unwrap();
        assert!(matches!(result, Resolution::Overwrite(p) if p == dest));
    }

    #[test]
    fn byte_identical_obeys_sticky_skip_all_as_user_skip() {
        // Skip All semantics: every collision counts as a user-skip,
        // including byte-identical ones.
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"same");
        write_file(&dest, b"same");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::SkipAll);
        let cancel = CancelToken::new();
        let result = resolve_with_collision_state(&src, dest, &state, &cancel, || {
            panic!("must not prompt when apply_to_all is set");
        })
        .unwrap();
        assert!(matches!(result, Resolution::SkippedByUser));
    }

    #[test]
    fn byte_identical_propagates_sticky_cancel() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"same");
        write_file(&dest, b"same");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::Cancel);
        let cancel = CancelToken::new();
        let result =
            resolve_with_collision_state(&src, dest, &state, &cancel, || {}).unwrap();
        assert!(matches!(result, Resolution::Cancelled));
        assert!(cancel.0.load(Ordering::SeqCst));
    }

    #[test]
    fn resolve_returns_overwrite_when_apply_to_all_is_overwrite_all() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"new-content");
        write_file(&dest, b"existing-different");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::OverwriteAll);
        let cancel = CancelToken::new();
        let result = resolve_with_collision_state(&src, dest.clone(), &state, &cancel, || {
            panic!("must not prompt when apply_to_all is set");
        })
        .unwrap();
        assert!(matches!(result, Resolution::Overwrite(p) if p == dest));
    }

    #[test]
    fn resolve_renames_when_apply_to_all_is_keep_both_all() {
        // Pins parity with the old auto-rename behavior, now opt-in.
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"new-content");
        write_file(&dest, b"existing-different");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::KeepBothAll);
        let cancel = CancelToken::new();
        let result = resolve_with_collision_state(&src, dest.clone(), &state, &cancel, || {
            panic!("must not prompt when apply_to_all is set");
        })
        .unwrap();
        match result {
            Resolution::Renamed(p) => {
                assert_ne!(p, dest);
                assert!(p.file_name().unwrap().to_str().unwrap().contains("(1)"));
            }
            other => panic!("expected Renamed, got {other:?}"),
        }
    }

    #[test]
    fn resolve_cancelled_decision_propagates_and_sets_cancel_token() {
        let dir = tempdir();
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        write_file(&src, b"new-content");
        write_file(&dest, b"existing-different");
        let state = CollisionState::new();
        *state.apply_to_all.lock().unwrap() = Some(CollisionDecision::Cancel);
        let cancel = CancelToken::new();
        let result =
            resolve_with_collision_state(&src, dest, &state, &cancel, || {}).unwrap();
        assert!(matches!(result, Resolution::Cancelled));
        assert!(cancel.0.load(Ordering::SeqCst));
    }

    #[test]
    fn wait_if_paused_blocks_other_workers_until_response() {
        // Worker A hits a collision and opens a prompt (paused=true). Worker B,
        // about to start its next file, must stall at wait_if_paused until A's
        // decision lands. Without this gate, B would race ahead and organize
        // files in the background while the modal is up.
        let state = std::sync::Arc::new(CollisionState::new());
        let cancel = std::sync::Arc::new(CancelToken::new());

        let started_prompt = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started_a = started_prompt.clone();
        let state_a = state.clone();
        let cancel_a = cancel.0.clone();
        let handle_a = std::thread::spawn(move || {
            let token = CancelToken(cancel_a);
            state_a.await_decision(&token, || {
                started_a.store(true, Ordering::SeqCst);
            })
        });

        // Wait until A has emitted the prompt event (and therefore set paused).
        while !started_prompt.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }

        let b_passed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let b_passed_inner = b_passed.clone();
        let state_b = state.clone();
        let cancel_b = cancel.0.clone();
        let handle_b = std::thread::spawn(move || {
            let token = CancelToken(cancel_b);
            let ok = state_b.wait_if_paused(&token);
            b_passed_inner.store(ok, Ordering::SeqCst);
        });

        std::thread::sleep(Duration::from_millis(150));
        assert!(
            !b_passed.load(Ordering::SeqCst),
            "B must still be paused while A's prompt is open"
        );

        state.respond(CollisionDecision::Skip);

        let decision = handle_a.join().unwrap();
        handle_b.join().unwrap();
        assert_eq!(decision, Some(CollisionDecision::Skip));
        assert!(
            b_passed.load(Ordering::SeqCst),
            "B must pass the gate once A's prompt is resolved"
        );
    }

    #[test]
    fn await_decision_returns_none_when_cancel_flips() {
        // Worker thread waits on the condvar; if cancel is set, it must
        // wake up and return None without a frontend response.
        let state = std::sync::Arc::new(CollisionState::new());
        let cancel = CancelToken::new();
        let cancel_clone = cancel.0.clone();
        let state_clone = state.clone();
        let handle = std::thread::spawn(move || {
            let temp_cancel = CancelToken(cancel_clone);
            state_clone.await_decision(&temp_cancel, || {})
        });
        // Give the thread a chance to enter the wait loop.
        std::thread::sleep(std::time::Duration::from_millis(150));
        cancel.0.store(true, Ordering::SeqCst);
        state.cond.notify_all();
        let result = handle.join().unwrap();
        assert!(result.is_none());
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
