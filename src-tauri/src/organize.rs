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
    pub bytes_processed: u64,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file_total: Option<u64>,
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
    /// Files for which the parsed filename date was successfully written into
    /// EXIF (`writeFilenameDate` toggle on).
    pub metadata_written: u64,
    /// Files routed to `MetadataWriteFailed/` because the EXIF write could
    /// not be performed (unsupported container, I/O error, etc).
    pub metadata_write_failed: u64,
    /// Images left in source because they already had a date-taken EXIF tag
    /// and the `skipImagesWithExistingDate` sub-toggle was on.
    pub skipped_existing_metadata: u64,
    pub errors: Vec<OrganizeError>,
    pub cancelled: bool,
    pub target: String,
}

/// Folder under the target where files whose EXIF write failed (or could
/// not be attempted, for unsupported containers) get routed when the
/// `writeFilenameDate` toggle is on. Lets the user find and retry them.
pub const METADATA_WRITE_FAILED_DIR: &str = "MetadataWriteFailed";

/// Container formats `little_exif` can write EXIF into. Anything else in
/// the broader `IMAGE_EXTS` list (RAW family, BMP, GIF, AVIF, SVG, DNG, …)
/// is treated as unwritable up-front, before any mutation, so we can route
/// the file to `MetadataWriteFailed/` without first touching it.
const WRITABLE_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif", "jxl",
];

/// Video container formats we can patch a `creation_time` into in place
/// (ISO BMFF / QuickTime family). Other video extensions in the broader
/// `VIDEO_EXTS` list (mkv, webm, avi, flv, wmv) use unrelated containers
/// and route to `MetadataWriteFailed/` up-front.
const WRITABLE_VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "qt", "3gp", "3g2"];

fn is_writable_image_ext(path: &Path) -> bool {
    let Some(ext) = ext_lower(path) else { return false };
    WRITABLE_IMAGE_EXTS.iter().any(|e| *e == ext)
}

fn is_writable_video_ext(path: &Path) -> bool {
    let Some(ext) = ext_lower(path) else { return false };
    WRITABLE_VIDEO_EXTS.iter().any(|e| *e == ext)
}

/// Walk `root`'s subtree bottom-up and remove every empty directory under
/// it. `root` itself is never removed, even if it ends up empty.
/// `std::fs::remove_dir` only succeeds on empty directories, so any subdir
/// that still contains files (or non-empty subdirs) is left intact.
/// Best-effort: returns the count of dirs removed; I/O errors on individual
/// entries are swallowed so a stuck dir doesn't abort the cleanup.
fn prune_empty_subdirs(root: &Path) -> usize {
    fn recurse(dir: &Path, removed: &mut usize, is_root: bool) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            // Don't follow symlinks — removing through one could touch
            // anything outside the target tree.
            if ft.is_dir() && !ft.is_symlink() {
                recurse(&path, removed, false);
            }
        }
        if !is_root && std::fs::remove_dir(dir).is_ok() {
            *removed += 1;
        }
    }
    let mut removed = 0;
    if root.is_dir() {
        recurse(root, &mut removed, true);
    }
    removed
}

/// Dispatch to the right writer for the file's category. Callers should
/// only reach here for `MetadataWriteIntent::Attempt`, where the category
/// is guaranteed to be Image or Video.
fn write_capture_date_for_category(
    path: &Path,
    ms: u64,
    category: crate::media_date::FileCategory,
) -> crate::metadata_writer::WriteOutcome {
    use crate::media_date::FileCategory;
    match category {
        FileCategory::Image => crate::metadata_writer::write_image_capture_date_ms(path, ms),
        FileCategory::Video => crate::metadata_writer::write_video_capture_date_ms(path, ms),
        _ => crate::metadata_writer::WriteOutcome::UnsupportedFormat,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum MetadataWriteIntent {
    /// Toggle off, or file isn't a filename-date-derived image: leave alone.
    Skip,
    /// Eligible AND the container is writable: caller should attempt the
    /// write (before move / after copy).
    Attempt,
    /// Eligible BUT the container can't be EXIF-written: caller routes to
    /// the failure folder without attempting a write.
    UnsupportedExt,
}

/// Sub-toggle filter: when the user enables `skipImagesWithExistingDate`
/// alongside `writeFilenameDate`, images that already have a date-taken EXIF
/// tag are left in source — not moved, not copied, not counted as organized.
/// Videos and other non-image categories are unaffected.
fn should_skip_existing_metadata(
    write_filename_date: bool,
    skip_images_with_existing_date: bool,
    date_src: DateSource,
    category: crate::media_date::FileCategory,
) -> bool {
    write_filename_date
        && skip_images_with_existing_date
        && category == crate::media_date::FileCategory::Image
        && date_src == DateSource::Metadata
}

fn classify_metadata_write_intent(
    src: &Path,
    write_filename_date: bool,
    date_src: DateSource,
    category: crate::media_date::FileCategory,
) -> MetadataWriteIntent {
    use crate::media_date::FileCategory;
    if !write_filename_date || date_src != DateSource::Filename {
        return MetadataWriteIntent::Skip;
    }
    match category {
        FileCategory::Image => {
            if is_writable_image_ext(src) {
                MetadataWriteIntent::Attempt
            } else {
                MetadataWriteIntent::UnsupportedExt
            }
        }
        FileCategory::Video => {
            if is_writable_video_ext(src) {
                MetadataWriteIntent::Attempt
            } else {
                MetadataWriteIntent::UnsupportedExt
            }
        }
        _ => MetadataWriteIntent::Skip,
    }
}

const MONTH_NAMES: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];

/// Inverse of civil_to_unix_ms. Returns (year, month [1..=12], day [1..=31]).
pub fn unix_ms_to_civil(ms: u64) -> (i32, u32, u32) {
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

/// True when `size` falls within the inclusive [min, max] window.
/// `None` on either bound means "no bound on that side".
fn passes_size_window(size: u64, min: Option<u64>, max: Option<u64>) -> bool {
    if let Some(m) = min {
        if size < m {
            return false;
        }
    }
    if let Some(m) = max {
        if size > m {
            return false;
        }
    }
    true
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
    bytes_processed: &AtomicU64,
    started: std::time::Instant,
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
                    bytes_processed: bytes_processed.load(Ordering::Relaxed),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    current_file_bytes: None,
                    current_file_total: None,
                }
            }),
        );
    }
}

/// Result of a move: did the OS rename it atomically, or did we stream-copy it?
pub(crate) enum MoveOutcome {
    /// Atomic same-volume rename; no chunked progress was reported.
    Renamed,
    /// Cross-device fallback: bytes were already reported via `on_chunk`.
    CopiedStreaming,
}

fn move_file<F: FnMut(u64)>(
    source: &Path,
    dest: &Path,
    on_chunk: F,
) -> std::io::Result<MoveOutcome> {
    match std::fs::rename(source, dest) {
        Ok(()) => Ok(MoveOutcome::Renamed),
        Err(_) => {
            // Cross-device (or other rename failure) — fall back to copy + remove.
            copy_with_progress(source, dest, on_chunk)?;
            std::fs::remove_file(source)?;
            Ok(MoveOutcome::CopiedStreaming)
        }
    }
}

const COPY_CHUNK_SIZE: usize = 1024 * 1024;

/// Copy a file from `source` to `dest`, reading/writing in fixed-size chunks
/// and reporting cumulative bytes written via `on_chunk(bytes_written_so_far)`.
///
/// Callback is invoked once per chunk written; for empty files it is not
/// invoked. Throttling/aggregation is the caller's responsibility.
pub(crate) fn copy_with_progress<F: FnMut(u64)>(
    source: &Path,
    dest: &Path,
    mut on_chunk: F,
) -> std::io::Result<u64> {
    use std::io::{Read, Write};
    let mut src = std::fs::File::open(source)?;
    let mut dst = std::fs::File::create(dest)?;
    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
    let mut total: u64 = 0;
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])?;
        total += n as u64;
        on_chunk(total);
    }
    dst.flush()?;
    Ok(total)
}

fn emit_chunk_progress(
    app: &AppHandle,
    id: &str,
    processed: &AtomicU64,
    total_files: u64,
    src: &Path,
    bytes_processed: &AtomicU64,
    started: std::time::Instant,
    current_file_bytes: u64,
    current_file_total: u64,
) {
    let _ = app.emit(
        "organize://progress",
        serde_json::json!({
            "organizeId": id,
            "progress": OrganizeProgress {
                processed: processed.load(Ordering::Relaxed),
                total: total_files,
                current_path: Some(src.to_path_buf()),
                phase: "organizing",
                bytes_processed: bytes_processed.load(Ordering::Relaxed),
                elapsed_ms: started.elapsed().as_millis() as u64,
                current_file_bytes: Some(current_file_bytes),
                current_file_total: Some(current_file_total),
            }
        }),
    );
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
    max_size: Option<u64>,
    ignore_macos_files: Option<bool>,
    write_filename_date: Option<bool>,
    skip_images_with_existing_date: Option<bool>,
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
    let min_size_opt = min_size;
    let max_size_opt = max_size;
    let write_filename_date = write_filename_date.unwrap_or(false);
    let skip_images_with_existing_date = skip_images_with_existing_date.unwrap_or(false);

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
            bytes_processed: 0,
            elapsed_ms: 0,
            current_file_bytes: None,
            current_file_total: None,
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
                if min_size_opt.is_some() || max_size_opt.is_some() {
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    if !passes_size_window(size, min_size_opt, max_size_opt) {
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
                        bytes_processed: 0,
                        elapsed_ms: 0,
                        current_file_bytes: None,
                        current_file_total: None,
                    });
                }
            }
        }

        let total = files.len() as u64;
        let cancelled_during_walk = cancel.0.load(Ordering::SeqCst);

        let organize_started = std::time::Instant::now();
        let bytes_processed = AtomicU64::new(0);
        emit_progress(OrganizeProgress {
            processed: 0,
            total,
            current_path: None,
            phase: "organizing",
            bytes_processed: 0,
            elapsed_ms: 0,
            current_file_bytes: None,
            current_file_total: None,
        });

        let processed = AtomicU64::new(0);
        let copied = AtomicU64::new(0);
        let moved = AtomicU64::new(0);
        let skipped_identical = AtomicU64::new(0);
        let skipped_by_user = AtomicU64::new(0);
        let overwritten = AtomicU64::new(0);
        let renamed = AtomicU64::new(0);
        let metadata_written = AtomicU64::new(0);
        let metadata_write_failed = AtomicU64::new(0);
        let skipped_existing_metadata = AtomicU64::new(0);
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

                // Sub-toggle: leave images that already have a date-taken
                // EXIF tag in source. They are not organized, not counted as
                // processed via copied/moved, just tallied separately.
                if should_skip_existing_metadata(
                    write_filename_date,
                    skip_images_with_existing_date,
                    date_src,
                    category,
                ) {
                    skipped_existing_metadata.fetch_add(1, Ordering::Relaxed);
                    emit_organizing_progress(&app_handle, &id_thread, &processed, total, src, &bytes_processed, organize_started);
                    return;
                }

                let intent = classify_metadata_write_intent(
                    src,
                    write_filename_date,
                    date_src,
                    category,
                );

                // For Move + Attempt, write EXIF on src up-front — we're
                // about to consume it anyway. For Copy + Attempt, defer
                // until *after* the copy so we never mutate the source.
                // For UnsupportedExt, route to the failure folder without
                // touching the file.
                let mut metadata_outcome: Option<crate::metadata_writer::WriteOutcome> = None;
                let mut route_to_failed = false;
                match intent {
                    MetadataWriteIntent::Skip => {}
                    MetadataWriteIntent::UnsupportedExt => {
                        metadata_outcome = Some(
                            crate::metadata_writer::WriteOutcome::UnsupportedFormat,
                        );
                        route_to_failed = true;
                    }
                    MetadataWriteIntent::Attempt => match op {
                        OrganizeOp::Move => {
                            let r = write_capture_date_for_category(src, ms, category);
                            if !matches!(r, crate::metadata_writer::WriteOutcome::Written) {
                                route_to_failed = true;
                            }
                            metadata_outcome = Some(r);
                        }
                        OrganizeOp::Copy => {
                            // defer write to post-copy
                        }
                    },
                }

                let dir = if route_to_failed {
                    target_path.join(METADATA_WRITE_FAILED_DIR)
                } else {
                    build_subdir(&target_path, ms, category, date_src, &granularity, &unknown_sub)
                };
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
                            &bytes_processed,
                            organize_started,
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
                            &bytes_processed,
                            organize_started,
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

                let mut chunked_bytes_added: u64 = 0;
                let mut last_chunk_emit = std::time::Instant::now();
                let app_handle_chunk = &app_handle;
                let id_thread_chunk = id_thread.as_str();
                let processed_ref = &processed;
                let bytes_processed_ref = &bytes_processed;
                let src_chunk = src.as_path();
                let mut on_chunk = |bytes_written: u64| {
                    let delta = bytes_written.saturating_sub(chunked_bytes_added);
                    if delta > 0 {
                        bytes_processed_ref.fetch_add(delta, Ordering::Relaxed);
                        chunked_bytes_added = bytes_written;
                    }
                    let now = std::time::Instant::now();
                    if now.duration_since(last_chunk_emit).as_millis() >= 120 {
                        last_chunk_emit = now;
                        emit_chunk_progress(
                            app_handle_chunk,
                            id_thread_chunk,
                            processed_ref,
                            total,
                            src_chunk,
                            bytes_processed_ref,
                            organize_started,
                            bytes_written,
                            source_size,
                        );
                    }
                };

                let result = match op {
                    OrganizeOp::Copy => copy_with_progress(src, &dest, &mut on_chunk).map(|_| true),
                    OrganizeOp::Move => move_file(src, &dest, &mut on_chunk).map(|outcome| {
                        matches!(outcome, MoveOutcome::CopiedStreaming)
                    }),
                };

                match result {
                    Ok(streamed) => {
                        // If we didn't stream chunks (atomic rename), bytes
                        // weren't reported via the callback — add them now.
                        if !streamed {
                            bytes_processed.fetch_add(source_size, Ordering::Relaxed);
                        } else if chunked_bytes_added < source_size {
                            // Cover any tail (e.g. file shorter than metadata).
                            bytes_processed.fetch_add(
                                source_size - chunked_bytes_added,
                                Ordering::Relaxed,
                            );
                        }
                        match kind {
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
                        }

                        // Deferred Copy-mode EXIF write: do it now on the
                        // destination (we promised never to mutate the
                        // source for Copy). Skip if we already routed to
                        // the failure folder up-front.
                        if matches!(intent, MetadataWriteIntent::Attempt)
                            && matches!(op, OrganizeOp::Copy)
                            && !route_to_failed
                        {
                            metadata_outcome = Some(
                                write_capture_date_for_category(&dest, ms, category),
                            );
                        }

                        if let Some(outcome) = metadata_outcome.take() {
                            match outcome {
                                crate::metadata_writer::WriteOutcome::Written => {
                                    metadata_written.fetch_add(1, Ordering::Relaxed);
                                }
                                crate::metadata_writer::WriteOutcome::UnsupportedFormat => {
                                    metadata_write_failed.fetch_add(1, Ordering::Relaxed);
                                    errors.lock().unwrap().push(OrganizeError {
                                        path: src.display().to_string(),
                                        reason: "metadata write: unsupported format".to_string(),
                                    });
                                }
                                crate::metadata_writer::WriteOutcome::Failed(msg) => {
                                    metadata_write_failed.fetch_add(1, Ordering::Relaxed);
                                    errors.lock().unwrap().push(OrganizeError {
                                        path: src.display().to_string(),
                                        reason: format!("metadata write: {msg}"),
                                    });
                                }
                            }
                        }
                    }
                    Err(e) => errors.lock().unwrap().push(OrganizeError {
                        path: src.display().to_string(),
                        reason: e.to_string(),
                    }),
                }

                emit_organizing_progress(&app_handle, &id_thread, &processed, total, src, &bytes_processed, organize_started);
            });
        }

        let was_cancelled = cancel.0.load(Ordering::SeqCst);

        // Remove any empty subdirectories under target_path. The per-file
        // worker pre-creates dated subdirs before resolving collisions, so
        // Skip/Cancel/copy-error paths can leave an empty leaf behind. A
        // bottom-up sweep cleans every empty dir without touching ones that
        // have files in them. Best-effort: errors are silently ignored.
        let _ = prune_empty_subdirs(&target_path);

        let complete = OrganizeComplete {
            processed: processed.load(Ordering::Relaxed),
            copied: copied.load(Ordering::Relaxed),
            moved: moved.load(Ordering::Relaxed),
            skipped_identical: skipped_identical.load(Ordering::Relaxed),
            skipped_by_user: skipped_by_user.load(Ordering::Relaxed),
            overwritten: overwritten.load(Ordering::Relaxed),
            renamed: renamed.load(Ordering::Relaxed),
            metadata_written: metadata_written.load(Ordering::Relaxed),
            metadata_write_failed: metadata_write_failed.load(Ordering::Relaxed),
            skipped_existing_metadata: skipped_existing_metadata.load(Ordering::Relaxed),
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
    fn organize_progress_serializes_bytes_and_elapsed_in_camel_case() {
        let p = OrganizeProgress {
            processed: 3,
            total: 10,
            current_path: None,
            phase: "organizing",
            bytes_processed: 4096,
            elapsed_ms: 1500,
            current_file_bytes: None,
            current_file_total: None,
        };
        let v: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(v["bytesProcessed"], 4096);
        assert_eq!(v["elapsedMs"], 1500);
        assert_eq!(v["processed"], 3);
        assert_eq!(v["phase"], "organizing");
    }

    #[test]
    fn copy_with_progress_reports_chunks_and_copies_bytes() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("big.bin");
        let dst = dir.path().join("big.bin.copy");
        // 4 MiB of distinguishable bytes.
        let size = 4 * COPY_CHUNK_SIZE;
        {
            let mut f = std::fs::File::create(&src).unwrap();
            let chunk = vec![0xABu8; 64 * 1024];
            let mut written = 0;
            while written < size {
                let n = (size - written).min(chunk.len());
                f.write_all(&chunk[..n]).unwrap();
                written += n;
            }
        }
        let mut samples: Vec<u64> = Vec::new();
        let total = copy_with_progress(&src, &dst, |b| samples.push(b)).unwrap();
        assert_eq!(total, size as u64);
        assert!(samples.len() >= 4, "expected >=4 chunk callbacks, got {}", samples.len());
        for w in samples.windows(2) {
            assert!(w[1] > w[0], "callback byte counts must be strictly increasing");
        }
        assert_eq!(*samples.last().unwrap(), size as u64);
        let src_bytes = std::fs::read(&src).unwrap();
        let dst_bytes = std::fs::read(&dst).unwrap();
        assert_eq!(src_bytes, dst_bytes);
    }

    #[test]
    fn copy_with_progress_missing_source_returns_err_no_callback() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("does-not-exist");
        let dst = dir.path().join("out");
        let mut called = false;
        let result = copy_with_progress(&src, &dst, |_| called = true);
        assert!(result.is_err());
        assert!(!called);
    }

    #[test]
    fn copy_with_progress_empty_file_no_callback() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("empty");
        let dst = dir.path().join("empty.copy");
        std::fs::write(&src, b"").unwrap();
        let mut samples: Vec<u64> = Vec::new();
        let total = copy_with_progress(&src, &dst, |b| samples.push(b)).unwrap();
        assert_eq!(total, 0);
        assert!(samples.is_empty());
        assert!(dst.exists());
    }

    #[test]
    fn copy_with_progress_exact_buffer_size_one_callback() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("one-buf");
        let dst = dir.path().join("one-buf.copy");
        let payload = vec![0x42u8; COPY_CHUNK_SIZE];
        std::fs::write(&src, &payload).unwrap();
        let mut samples: Vec<u64> = Vec::new();
        let total = copy_with_progress(&src, &dst, |b| samples.push(b)).unwrap();
        assert_eq!(total, COPY_CHUNK_SIZE as u64);
        // Read may return short; allow up to 2 callbacks but require final = size.
        assert!(!samples.is_empty() && samples.len() <= 2);
        assert_eq!(*samples.last().unwrap(), COPY_CHUNK_SIZE as u64);
    }

    #[test]
    fn move_file_same_dir_uses_rename_outcome_no_callback() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        let dst = dir.path().join("b.txt");
        std::fs::write(&src, b"hello").unwrap();
        let mut called = false;
        let outcome = move_file(&src, &dst, |_| called = true).unwrap();
        assert!(matches!(outcome, MoveOutcome::Renamed));
        assert!(!called);
        assert!(!src.exists());
        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");
    }

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
    fn skip_existing_metadata_only_when_all_three_conditions_hold() {
        // Happy path: all three conditions satisfied → skip.
        assert!(should_skip_existing_metadata(
            true,
            true,
            DateSource::Metadata,
            FileCategory::Image,
        ));
    }

    #[test]
    fn skip_existing_metadata_off_when_sub_toggle_off() {
        assert!(!should_skip_existing_metadata(
            true,
            false,
            DateSource::Metadata,
            FileCategory::Image,
        ));
    }

    #[test]
    fn skip_existing_metadata_off_when_parent_toggle_off() {
        // Sub-toggle is meaningless without the parent toggle.
        assert!(!should_skip_existing_metadata(
            false,
            true,
            DateSource::Metadata,
            FileCategory::Image,
        ));
    }

    #[test]
    fn skip_existing_metadata_off_for_filename_or_fallback_date() {
        // No existing EXIF date → don't skip; the whole point is to process these.
        assert!(!should_skip_existing_metadata(
            true,
            true,
            DateSource::Filename,
            FileCategory::Image,
        ));
        assert!(!should_skip_existing_metadata(
            true,
            true,
            DateSource::Fallback,
            FileCategory::Image,
        ));
    }

    #[test]
    fn skip_existing_metadata_off_for_non_images() {
        // Videos with QuickTime metadata are still organized; sub-toggle is images-only.
        for cat in [
            FileCategory::Video,
            FileCategory::Audio,
            FileCategory::Pdf,
            FileCategory::Doc,
            FileCategory::Archive,
            FileCategory::Unknown,
        ] {
            assert!(
                !should_skip_existing_metadata(true, true, DateSource::Metadata, cat),
                "expected non-image category {:?} not to be skipped",
                cat,
            );
        }
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
    fn passes_size_window_no_bounds_accepts_anything() {
        assert!(passes_size_window(0, None, None));
        assert!(passes_size_window(u64::MAX, None, None));
    }

    #[test]
    fn passes_size_window_rejects_below_min() {
        assert!(!passes_size_window(99, Some(100), None));
        assert!(passes_size_window(100, Some(100), None)); // boundary inclusive
        assert!(passes_size_window(101, Some(100), None));
    }

    #[test]
    fn passes_size_window_rejects_above_max() {
        assert!(passes_size_window(99, None, Some(100)));
        assert!(passes_size_window(100, None, Some(100))); // boundary inclusive
        assert!(!passes_size_window(101, None, Some(100)));
    }

    #[test]
    fn passes_size_window_with_both_bounds_filters_outside() {
        assert!(!passes_size_window(50, Some(100), Some(200)));
        assert!(passes_size_window(150, Some(100), Some(200)));
        assert!(!passes_size_window(250, Some(100), Some(200)));
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
        move_file(&src, &dest, |_| {}).unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }

    // ── Metadata-write intent classification ─────────────────────────────

    #[test]
    fn is_writable_image_ext_accepts_jpeg_png_tiff_webp_heif_jxl() {
        for p in ["a.jpg", "a.JPEG", "a.png", "a.tif", "a.tiff", "a.webp", "a.heic", "a.HEIF", "a.jxl"] {
            assert!(is_writable_image_ext(Path::new(p)), "should accept {p}");
        }
    }

    #[test]
    fn is_writable_image_ext_rejects_other_image_exts() {
        for p in ["a.bmp", "a.gif", "a.svg", "a.avif", "a.dng", "a.cr2", "a.arw", "a.raw"] {
            assert!(!is_writable_image_ext(Path::new(p)), "should reject {p}");
        }
    }

    #[test]
    fn classify_skip_when_toggle_off() {
        let p = Path::new("/x/2025-02-11.jpg");
        assert_eq!(
            classify_metadata_write_intent(p, false, DateSource::Filename, crate::media_date::FileCategory::Image),
            MetadataWriteIntent::Skip,
        );
    }

    #[test]
    fn classify_skip_when_date_already_in_metadata() {
        let p = Path::new("/x/2025-02-11.jpg");
        assert_eq!(
            classify_metadata_write_intent(p, true, DateSource::Metadata, crate::media_date::FileCategory::Image),
            MetadataWriteIntent::Skip,
        );
    }

    #[test]
    fn classify_skip_when_no_filename_date_fallback() {
        let p = Path::new("/x/vacation.jpg");
        assert_eq!(
            classify_metadata_write_intent(p, true, DateSource::Fallback, crate::media_date::FileCategory::Image),
            MetadataWriteIntent::Skip,
        );
    }

    #[test]
    fn classify_skip_when_not_an_image_or_video() {
        let p = Path::new("/x/2025-02-11.pdf");
        assert_eq!(
            classify_metadata_write_intent(p, true, DateSource::Filename, crate::media_date::FileCategory::Pdf),
            MetadataWriteIntent::Skip,
        );
    }

    #[test]
    fn classify_attempt_for_writable_video_with_filename_date() {
        for p in ["/x/2025-02-11.mp4", "/x/2025-02-11.mov", "/x/2025-02-11.qt"] {
            assert_eq!(
                classify_metadata_write_intent(Path::new(p), true, DateSource::Filename, crate::media_date::FileCategory::Video),
                MetadataWriteIntent::Attempt,
                "expected Attempt for {p}",
            );
        }
    }

    #[test]
    fn classify_unsupported_ext_for_mkv_with_filename_date() {
        for p in ["/x/2025-02-11.mkv", "/x/2025-02-11.webm", "/x/2025-02-11.avi"] {
            assert_eq!(
                classify_metadata_write_intent(Path::new(p), true, DateSource::Filename, crate::media_date::FileCategory::Video),
                MetadataWriteIntent::UnsupportedExt,
                "expected UnsupportedExt for {p}",
            );
        }
    }

    #[test]
    fn classify_attempt_for_writable_image_with_filename_date() {
        let p = Path::new("/x/2025-02-11.jpg");
        assert_eq!(
            classify_metadata_write_intent(p, true, DateSource::Filename, crate::media_date::FileCategory::Image),
            MetadataWriteIntent::Attempt,
        );
    }

    #[test]
    fn classify_unsupported_ext_for_raw_with_filename_date() {
        let p = Path::new("/x/2025-02-11.dng");
        assert_eq!(
            classify_metadata_write_intent(p, true, DateSource::Filename, crate::media_date::FileCategory::Image),
            MetadataWriteIntent::UnsupportedExt,
        );
    }

    // ── End-to-end integration of the metadata-write step ────────────────
    //
    // These bypass the Tauri command shell (which needs an AppHandle to
    // emit events) and exercise the metadata-write logic via the public
    // helpers directly. They mirror the par_iter block in `start_organize`
    // tightly enough to catch regressions in routing & counter semantics.

    fn write_blank_jpeg(path: &Path) {
        use image::RgbImage;
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        RgbImage::new(2, 2).save(path).unwrap();
    }

    #[test]
    fn metadata_write_copy_succeeds_writes_dest_leaves_source_pristine() {
        let dir = tempdir();
        let src = dir.join("src/2025-02-11.jpg");
        write_blank_jpeg(&src);
        let src_bytes_before = std::fs::read(&src).unwrap();

        // Simulate Copy mode: copy to dated subdir, then write EXIF on dest.
        let (ms, date_src) = resolved_date(&src);
        let category = crate::media_date::file_category(&src);
        assert_eq!(date_src, DateSource::Filename);
        assert_eq!(category, crate::media_date::FileCategory::Image);

        let intent = classify_metadata_write_intent(&src, true, date_src, category);
        assert_eq!(intent, MetadataWriteIntent::Attempt);

        let target = dir.clone();
        let g = Granularity { year: true, month: true, day: false };
        let dest_dir = build_subdir(&target, ms, category, date_src, &g, "");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("2025-02-11.jpg");
        std::fs::copy(&src, &dest).unwrap();
        let outcome = crate::metadata_writer::write_image_capture_date_ms(&dest, ms);
        assert_eq!(outcome, crate::metadata_writer::WriteOutcome::Written);

        // Source untouched
        assert_eq!(std::fs::read(&src).unwrap(), src_bytes_before);
        // Dest has EXIF now
        assert_eq!(
            crate::media_date::read_metadata_ms(&dest),
            Some(ms),
            "destination should have EXIF capture date matching parsed ms"
        );
    }

    #[test]
    fn metadata_write_unsupported_ext_routes_to_failed_folder() {
        let dir = tempdir();
        let src = dir.join("src/2025-02-11.dng");
        write_file(&src, b"not a real dng but extension is enough");

        let (ms, date_src) = resolved_date(&src);
        let category = crate::media_date::file_category(&src);
        assert_eq!(date_src, DateSource::Filename);
        // .dng is an image extension per media_date::IMAGE_EXTS
        assert_eq!(category, crate::media_date::FileCategory::Image);

        let intent = classify_metadata_write_intent(&src, true, date_src, category);
        assert_eq!(intent, MetadataWriteIntent::UnsupportedExt);

        // Route override: failure folder, not the dated subdir
        let target = dir.clone();
        let g = Granularity { year: true, month: true, day: false };
        let unknown_sub = crate::media_date::unknown_subfolder_name(&src);
        let dated_dir = build_subdir(&target, ms, category, date_src, &g, &unknown_sub);
        let failed_dir = target.join(METADATA_WRITE_FAILED_DIR);
        assert_ne!(dated_dir, failed_dir);
        // Sanity: the dated path would have been under Images/2025/...
        assert!(dated_dir.to_string_lossy().contains("Images"));
    }

    #[test]
    fn metadata_write_move_mutates_source_then_moves() {
        // For Move mode, the source is already condemned, so we write
        // EXIF on the source before the rename. Verify a writable image
        // gets its EXIF populated by the writer.
        let dir = tempdir();
        let src = dir.join("src/2025-02-11.jpg");
        write_blank_jpeg(&src);

        let (ms, _) = resolved_date(&src);
        let outcome = crate::metadata_writer::write_image_capture_date_ms(&src, ms);
        assert_eq!(outcome, crate::metadata_writer::WriteOutcome::Written);
        assert_eq!(crate::media_date::read_metadata_ms(&src), Some(ms));

        // Now the move itself
        let dest_dir = dir.join("Images/2025/02-February");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("2025-02-11.jpg");
        move_file(&src, &dest, |_| {}).unwrap();
        assert!(!src.exists());
        assert_eq!(crate::media_date::read_metadata_ms(&dest), Some(ms));
    }

    #[test]
    fn prune_empty_subdirs_removes_a_lone_empty_dir() {
        let dir = tempdir();
        std::fs::create_dir_all(dir.join("Images/2025/02-February")).unwrap();
        let removed = prune_empty_subdirs(&dir);
        assert_eq!(removed, 3, "should remove 02-February, 2025, Images");
        assert!(dir.exists(), "root must never be removed");
        assert!(!dir.join("Images").exists());
    }

    #[test]
    fn prune_empty_subdirs_keeps_dirs_with_files() {
        let dir = tempdir();
        let kept = dir.join("Images/2025/02-February");
        std::fs::create_dir_all(&kept).unwrap();
        write_file(&kept.join("photo.jpg"), b"x");
        // Sibling that's empty
        std::fs::create_dir_all(dir.join("Images/2025/03-March")).unwrap();

        let removed = prune_empty_subdirs(&dir);
        assert_eq!(removed, 1, "only 03-March should be removed");
        assert!(kept.join("photo.jpg").exists(), "file must survive");
        assert!(kept.exists());
        assert!(!dir.join("Images/2025/03-March").exists());
    }

    #[test]
    fn prune_empty_subdirs_never_removes_root_even_if_empty() {
        let dir = tempdir();
        let removed = prune_empty_subdirs(&dir);
        assert_eq!(removed, 0);
        assert!(dir.exists(), "root must remain even when empty");
    }

    #[test]
    fn prune_empty_subdirs_handles_missing_root() {
        // Should not panic on a path that doesn't exist.
        let missing = std::path::PathBuf::from("/nonexistent/definitely/missing");
        assert_eq!(prune_empty_subdirs(&missing), 0);
    }

    #[test]
    fn prune_empty_subdirs_removes_deeply_nested_empties_while_preserving_useful_branch() {
        let dir = tempdir();
        // Useful branch: Videos/2024/12-December/clip.mov
        let video_dir = dir.join("Videos/2024/12-December");
        std::fs::create_dir_all(&video_dir).unwrap();
        write_file(&video_dir.join("clip.mov"), b"x");
        // Empty branch alongside, several levels deep
        std::fs::create_dir_all(dir.join("Videos/Unknown")).unwrap();
        std::fs::create_dir_all(dir.join("Images/2025/02-February")).unwrap();
        std::fs::create_dir_all(dir.join("MetadataWriteFailed")).unwrap();

        prune_empty_subdirs(&dir);

        assert!(video_dir.join("clip.mov").exists());
        assert!(video_dir.exists());
        assert!(dir.join("Videos/2024").exists());
        assert!(dir.join("Videos").exists());
        assert!(!dir.join("Videos/Unknown").exists());
        assert!(!dir.join("Images").exists());
        assert!(!dir.join("MetadataWriteFailed").exists());
    }

    #[test]
    fn metadata_write_video_copy_succeeds_writes_dest_leaves_source_pristine() {
        // Mirror of the image Copy-mode test for video. Uses a minimal MP4
        // (moov→mvhd) under a .qt name to confirm both QuickTime ext and
        // the dispatch helper work end-to-end.
        let dir = tempdir();
        let src = dir.join("src/2025-02-11.qt");
        if let Some(p) = src.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        // Initial creation_time = 0 (epoch-1904); the writer will replace it.
        std::fs::write(
            &src,
            crate::media_date::tests::build_minimal_mp4_v0(0),
        )
        .unwrap();
        let src_bytes_before = std::fs::read(&src).unwrap();

        let (ms, date_src) = resolved_date(&src);
        let category = crate::media_date::file_category(&src);
        assert_eq!(date_src, DateSource::Filename);
        assert_eq!(category, crate::media_date::FileCategory::Video);

        let intent = classify_metadata_write_intent(&src, true, date_src, category);
        assert_eq!(intent, MetadataWriteIntent::Attempt);

        let target = dir.clone();
        let g = Granularity { year: true, month: true, day: false };
        let dest_dir = build_subdir(&target, ms, category, date_src, &g, "");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("2025-02-11.qt");
        std::fs::copy(&src, &dest).unwrap();
        let outcome = write_capture_date_for_category(&dest, ms, category);
        assert_eq!(outcome, crate::metadata_writer::WriteOutcome::Written);

        assert_eq!(std::fs::read(&src).unwrap(), src_bytes_before);
        assert_eq!(crate::media_date::read_metadata_ms(&dest), Some(ms));
    }

    #[test]
    fn metadata_write_mkv_video_routes_to_failed_folder() {
        let dir = tempdir();
        let src = dir.join("src/2025-02-11.mkv");
        write_file(&src, b"not a real mkv");

        let (_ms, date_src) = resolved_date(&src);
        let category = crate::media_date::file_category(&src);
        assert_eq!(date_src, DateSource::Filename);
        assert_eq!(category, crate::media_date::FileCategory::Video);
        let intent = classify_metadata_write_intent(&src, true, date_src, category);
        assert_eq!(intent, MetadataWriteIntent::UnsupportedExt);
    }
}
