use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::settings::{Filters, ScanThreads, Settings};

const LARGE_FILE_THRESHOLD: u64 = 64 * 1024 * 1024;
const PARTIAL_HASH_BYTES: u64 = 64 * 1024;

const HASH_CHUNK_SIZE: usize = 8192;
const HASH_EMIT_EVERY_MS: u128 = 50;
const CHECKPOINT_MIN_INTERVAL_MS: u128 = 3000;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HashKind {
    Full,
    Partial,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFile {
    pub path: PathBuf,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    pub hash: String,
    pub size: u64,
    pub hash_kind: HashKind,
    pub files: Vec<DuplicateFile>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub processed: u64,
    pub total: u64,
    pub current_path: Option<PathBuf>,
    pub phase: &'static str,
    /// 0-based index of the folder being processed for per-folder phases
    /// (discovery). None during global phases (hashing/verifying).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<PathBuf>,
}

impl ScanProgress {
    fn global(phase: &'static str, processed: u64, total: u64, current_path: Option<PathBuf>) -> Self {
        Self {
            processed,
            total,
            current_path,
            phase,
            folder_index: None,
            folder_total: None,
            folder_path: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanComplete {
    pub groups: Vec<DuplicateGroup>,
    pub total_files: u64,
    pub duplicate_files: u64,
    pub wasted_bytes: u64,
    #[serde(default)]
    pub extension_counts: HashMap<String, u64>,
}

pub struct CancelToken(pub Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(duration.as_millis() as u64)
}

/// Resolve the timestamp the UI treats as "original date". When metadata
/// reads are enabled and the file is a supported image/video, prefer the
/// EXIF/container capture date; otherwise fall back to filesystem mtime.
fn resolved_date_ms(path: &Path, use_metadata: bool) -> Option<u64> {
    if use_metadata {
        if let Some(ms) = crate::media_date::read_metadata_ms(path) {
            return Some(ms);
        }
    }
    modified_ms(path)
}

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

/// Returns true for files macOS leaves behind on any volume it touches:
/// AppleDouble sidecars (`._foo.jpg`) and `.DS_Store`. These accumulate when
/// macOS writes to non-HFS+ volumes (USB drives, network shares, archives) and
/// often masquerade as duplicates of the real files they shadow.
pub fn is_macos_metadata_file(name: &str) -> bool {
    name.starts_with("._") || name == ".DS_Store"
}

/// Directory names macOS uses to stash metadata. Skipping these saves
/// walk time and avoids ever inspecting their contents.
pub fn is_macos_metadata_dir(name: &str) -> bool {
    matches!(
        name,
        ".AppleDouble" | "__MACOSX" | ".Spotlight-V100" | ".Trashes" | ".fseventsd"
    )
}

fn passes_filters(path: &Path, size: u64, filters: &Filters) -> bool {
    if filters.ignore_macos_files {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if is_macos_metadata_file(name) {
                return false;
            }
        }
    }
    if let Some(min) = filters.min_size {
        if size < min {
            return false;
        }
    }
    if let Some(max) = filters.max_size {
        if size > max {
            return false;
        }
    }
    let ext = extension_lower(path);
    if let Some(ref e) = ext {
        if filters.ignored_extensions.iter().any(|i| i.eq_ignore_ascii_case(e)) {
            return false;
        }
    }
    if let Some(ref allow) = filters.extensions {
        match ext {
            Some(ref e) if allow.iter().any(|a| a.eq_ignore_ascii_case(e)) => {}
            _ => return false,
        }
    }
    if filters.modified_after_ms.is_some() || filters.modified_before_ms.is_some() {
        let m = match modified_ms(path) {
            Some(v) => v,
            None => return false,
        };
        if let Some(after) = filters.modified_after_ms {
            if m < after {
                return false;
            }
        }
        if let Some(before) = filters.modified_before_ms {
            if m > before {
                return false;
            }
        }
    }
    true
}

fn lowercase_ignored_folders(filters: &Filters) -> Vec<String> {
    filters.ignored_folders.iter().map(|s| s.to_lowercase()).collect()
}

fn make_walker(root: &Path, filters: &Filters) -> WalkDir {
    let mut walker = WalkDir::new(root).follow_links(false);
    if !filters.include_subdirs {
        walker = walker.max_depth(1);
    }
    walker
}

fn dir_filter<'a>(
    ignore_hidden: bool,
    ignore_macos: bool,
    ignored_folders: &'a [String],
) -> impl Fn(&walkdir::DirEntry) -> bool + 'a {
    move |e: &walkdir::DirEntry| {
        let name = e.file_name().to_str().unwrap_or("");
        if ignore_hidden && name.starts_with('.') {
            return false;
        }
        if e.file_type().is_dir() {
            if ignore_macos && is_macos_metadata_dir(name) {
                return false;
            }
            if ignored_folders.iter().any(|f| name.eq_ignore_ascii_case(f)) {
                return false;
            }
        }
        true
    }
}

/// Walk one root, applying filters and appending survivors to `out`.
fn walk_one_folder<F>(
    root: &Path,
    folder_index: u32,
    folder_total: u32,
    estimated_total: u64,
    ignore_hidden: bool,
    filters: &Filters,
    cancel: &CancelToken,
    extension_counts: &mut HashMap<String, u64>,
    out: &mut Vec<(PathBuf, u64)>,
    on_progress: &F,
) where
    F: Fn(ScanProgress) + Sync + Send,
{
    let ignored = lowercase_ignored_folders(filters);
    let f = dir_filter(ignore_hidden, filters.ignore_macos_files, &ignored);
    let mut visited: u64 = 0;
    let mut last_emit = Instant::now();
    const EMIT_EVERY_FILES: u64 = 256;
    const EMIT_EVERY_MS: u128 = 80;
    for entry in make_walker(root, filters).into_iter().filter_entry(|e| f(e)) {
        if cancel.is_cancelled() {
            return;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        visited += 1;
        let Ok(meta) = entry.metadata() else {
            maybe_emit_discovery(
                visited,
                estimated_total,
                None,
                folder_index,
                folder_total,
                root,
                &mut last_emit,
                EMIT_EVERY_FILES,
                EMIT_EVERY_MS,
                on_progress,
            );
            continue;
        };
        let size = meta.len();
        if size == 0 {
            maybe_emit_discovery(
                visited,
                estimated_total,
                None,
                folder_index,
                folder_total,
                root,
                &mut last_emit,
                EMIT_EVERY_FILES,
                EMIT_EVERY_MS,
                on_progress,
            );
            continue;
        }
        let path = entry.into_path();
        let kept = passes_filters(&path, size, filters);
        if kept {
            if let Some(ext) = extension_lower(&path) {
                *extension_counts.entry(ext).or_insert(0) += 1;
            }
            out.push((path.clone(), size));
        }
        maybe_emit_discovery(
            visited,
            estimated_total,
            Some(path),
            folder_index,
            folder_total,
            root,
            &mut last_emit,
            EMIT_EVERY_FILES,
            EMIT_EVERY_MS,
            on_progress,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn maybe_emit_discovery<F>(
    visited: u64,
    estimated_total: u64,
    current_path: Option<PathBuf>,
    folder_index: u32,
    folder_total: u32,
    root: &Path,
    last_emit: &mut Instant,
    emit_every_files: u64,
    emit_every_ms: u128,
    on_progress: &F,
) where
    F: Fn(ScanProgress) + Sync + Send,
{
    let now = Instant::now();
    if visited % emit_every_files == 0
        || now.duration_since(*last_emit).as_millis() >= emit_every_ms
    {
        *last_emit = now;
        on_progress(ScanProgress {
            processed: visited,
            total: estimated_total,
            current_path,
            phase: "discovery",
            folder_index: Some(folder_index),
            folder_total: Some(folder_total),
            folder_path: Some(root.to_path_buf()),
        });
    }
}

fn group_by_size(files: Vec<(PathBuf, u64)>) -> Vec<(u64, Vec<PathBuf>)> {
    let mut buckets: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for (path, size) in files {
        buckets.entry(size).or_default().push(path);
    }
    buckets
        .into_iter()
        .filter(|(_, v)| v.len() >= 2)
        .collect()
}

thread_local! {
    static HASH_BUF: std::cell::RefCell<Vec<u8>> = std::cell::RefCell::new(vec![0u8; 1024 * 1024]);
}

fn hash_file_full(path: &Path) -> std::io::Result<blake3::Hash> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    HASH_BUF.with(|cell| {
        let mut buf = cell.borrow_mut();
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize())
    })
}

fn hash_file_partial(path: &Path, size: u64) -> std::io::Result<blake3::Hash> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());

    let head_len = PARTIAL_HASH_BYTES.min(size) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head)?;
    hasher.update(&head);

    let tail_start = size.saturating_sub(PARTIAL_HASH_BYTES);
    if tail_start > head_len as u64 {
        file.seek(SeekFrom::Start(tail_start))?;
        let tail_len = (size - tail_start) as usize;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }
    Ok(hasher.finalize())
}

fn flatten_candidates(size_groups: Vec<(u64, Vec<PathBuf>)>) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    for (size, paths) in size_groups {
        for path in paths {
            out.push((path, size));
        }
    }
    out
}

/// `size <= PARTIAL_COVERS_FULL_BYTES` means the partial-hash function already
/// read every byte of the file, so a partial-hash match is as authoritative as
/// a full-hash match — Stage 2 can be skipped for that bucket.
const PARTIAL_COVERS_FULL_BYTES: u64 = 2 * PARTIAL_HASH_BYTES;

type ByPartial = HashMap<(u64, [u8; 32]), Vec<DuplicateFile>>;
type RunningGroups = HashMap<(u64, [u8; 32]), (HashKind, Vec<DuplicateFile>)>;

fn build_snapshot(
    by_key: &RunningGroups,
    total_files: u64,
    extension_counts: &HashMap<String, u64>,
) -> ScanComplete {
    let groups: Vec<DuplicateGroup> = by_key
        .iter()
        .filter(|(_, (_, files))| files.len() >= 2)
        .map(|((size, hash_bytes), (kind, files))| DuplicateGroup {
            id: Uuid::new_v4().to_string(),
            hash: hex_encode(hash_bytes),
            size: *size,
            hash_kind: *kind,
            files: files.clone(),
        })
        .collect();
    let duplicate_files: u64 = groups.iter().map(|g| g.files.len() as u64).sum();
    let wasted_bytes: u64 = groups
        .iter()
        .map(|g| g.size * (g.files.len() as u64).saturating_sub(1))
        .sum();
    ScanComplete {
        groups,
        total_files,
        duplicate_files,
        wasted_bytes,
        extension_counts: extension_counts.clone(),
    }
}

/// Tentative snapshot from Stage 1's partial-hash buckets. Used for mid-scan
/// checkpoints so the UI can show preliminary results before Stage 2 verifies.
fn build_snapshot_from_partial(
    by_partial: &ByPartial,
    total_files: u64,
    extension_counts: &HashMap<String, u64>,
) -> ScanComplete {
    let groups: Vec<DuplicateGroup> = by_partial
        .iter()
        .filter(|(_, files)| files.len() >= 2)
        .map(|((size, hash_bytes), files)| DuplicateGroup {
            id: Uuid::new_v4().to_string(),
            hash: hex_encode(hash_bytes),
            size: *size,
            hash_kind: HashKind::Partial,
            files: files.clone(),
        })
        .collect();
    let duplicate_files: u64 = groups.iter().map(|g| g.files.len() as u64).sum();
    let wasted_bytes: u64 = groups
        .iter()
        .map(|g| g.size * (g.files.len() as u64).saturating_sub(1))
        .sum();
    ScanComplete {
        groups,
        total_files,
        duplicate_files,
        wasted_bytes,
        extension_counts: extension_counts.clone(),
    }
}

fn hex_encode(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

pub fn run_scan<F, C>(
    paths: Vec<PathBuf>,
    settings: &Settings,
    cancel: &CancelToken,
    on_progress: F,
    on_checkpoint: C,
) -> ScanComplete
where
    F: Fn(ScanProgress) + Sync + Send,
    C: Fn(&ScanComplete) + Sync + Send,
{
    // Discovery walks each root in turn, then hashing/verifying run globally
    // since duplicates may span folders. The frontend uses (folderIndex,
    // folderTotal) to drive per-directory progress bars during discovery.
    let mut extension_counts: HashMap<String, u64> = HashMap::new();
    let mut all_files: Vec<(PathBuf, u64)> = Vec::new();
    let folder_total = paths.len() as u32;

    for (i, root) in paths.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let folder_index = i as u32;

        on_progress(ScanProgress {
            processed: 0,
            total: 0,
            current_path: None,
            phase: "discovery",
            folder_index: Some(folder_index),
            folder_total: Some(folder_total),
            folder_path: Some(root.clone()),
        });
        walk_one_folder(
            root,
            folder_index,
            folder_total,
            0,
            settings.ignore_hidden,
            &settings.scan_filters,
            cancel,
            &mut extension_counts,
            &mut all_files,
            &on_progress,
        );
    }
    let total_files = all_files.len() as u64;

    if cancel.is_cancelled() {
        return ScanComplete {
            groups: vec![],
            total_files,
            duplicate_files: 0,
            wasted_bytes: 0,
            extension_counts,
        };
    }

    let size_groups = group_by_size(all_files);
    let candidates = flatten_candidates(size_groups);
    let candidate_count: u64 = candidates.len() as u64;

    let pool = build_pool(&settings.scan_threads);
    let last_emit = Mutex::new(Instant::now());
    // Set far enough in the past so the first chunk's checkpoint always fires —
    // gives the UI an immediate partial result, then throttles subsequent saves.
    let initial_checkpoint = Instant::now()
        .checked_sub(std::time::Duration::from_millis(CHECKPOINT_MIN_INTERVAL_MS as u64 + 1))
        .unwrap_or_else(Instant::now);

    // ---- Stage 1: partial-hash every candidate ---------------------------
    on_progress(ScanProgress::global("hashing", 0, candidate_count, None));

    let mut by_partial: ByPartial = HashMap::new();
    let stage1_processed = AtomicU64::new(0);
    let mut last_checkpoint = initial_checkpoint;

    for chunk in candidates.chunks(HASH_CHUNK_SIZE) {
        if cancel.is_cancelled() {
            break;
        }
        let chunk_results: Vec<(u64, [u8; 32], DuplicateFile)> = pool.install(|| {
            chunk
                .par_iter()
                .filter_map(|(path, size)| {
                    if cancel.is_cancelled() {
                        return None;
                    }
                    let hash_result = hash_file_partial(path, *size);
                    let done = stage1_processed.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Ok(mut le) = last_emit.try_lock() {
                        let now = Instant::now();
                        if now.duration_since(*le).as_millis() >= HASH_EMIT_EVERY_MS
                            || done == candidate_count
                        {
                            *le = now;
                            drop(le);
                            on_progress(ScanProgress::global(
                                "hashing",
                                done,
                                candidate_count,
                                Some(path.clone()),
                            ));
                        }
                    }
                    let hash = hash_result.ok()?;
                    let file = DuplicateFile {
                        path: path.clone(),
                        size: *size,
                        modified_ms: None,
                    };
                    Some((*size, *hash.as_bytes(), file))
                })
                .collect()
        });

        for (size, hash_bytes, file) in chunk_results {
            by_partial.entry((size, hash_bytes)).or_default().push(file);
        }

        let now = Instant::now();
        if now.duration_since(last_checkpoint).as_millis() >= CHECKPOINT_MIN_INTERVAL_MS {
            last_checkpoint = now;
            let snapshot =
                build_snapshot_from_partial(&by_partial, total_files, &extension_counts);
            on_checkpoint(&snapshot);
        }
    }

    // ---- Classify Stage 1 buckets ----------------------------------------
    // Buckets are split three ways:
    //   - Singletons (len < 2): no possible duplicate, drop.
    //   - Settled: partial covered the whole file (size <= 128 KB) OR file is
    //     past LARGE_FILE_THRESHOLD where partial is the policy. Promote
    //     directly into the final map.
    //   - Need verify: partial only sampled head+tail; full hash required.
    let mut final_by_key: RunningGroups = HashMap::new();
    let mut needs_verify: Vec<DuplicateFile> = Vec::new();

    for ((size, partial_hash), files) in by_partial.drain() {
        if files.len() < 2 {
            continue;
        }
        if size <= PARTIAL_COVERS_FULL_BYTES {
            final_by_key.insert((size, partial_hash), (HashKind::Full, files));
        } else if size > LARGE_FILE_THRESHOLD {
            final_by_key.insert((size, partial_hash), (HashKind::Partial, files));
        } else {
            needs_verify.extend(files);
        }
    }

    // ---- Stage 2: full-hash collision survivors --------------------------
    let verify_count = needs_verify.len() as u64;
    if verify_count > 0 && !cancel.is_cancelled() {
        on_progress(ScanProgress::global("verifying", 0, verify_count, None));

        let stage2_processed = AtomicU64::new(0);
        let mut last_checkpoint = initial_checkpoint;

        for chunk in needs_verify.chunks(HASH_CHUNK_SIZE) {
            if cancel.is_cancelled() {
                break;
            }
            let chunk_results: Vec<(u64, [u8; 32], DuplicateFile)> = pool.install(|| {
                chunk
                    .par_iter()
                    .filter_map(|file| {
                        if cancel.is_cancelled() {
                            return None;
                        }
                        let hash_result = hash_file_full(&file.path);
                        let done = stage2_processed.fetch_add(1, Ordering::Relaxed) + 1;
                        if let Ok(mut le) = last_emit.try_lock() {
                            let now = Instant::now();
                            if now.duration_since(*le).as_millis() >= HASH_EMIT_EVERY_MS
                                || done == verify_count
                            {
                                *le = now;
                                drop(le);
                                on_progress(ScanProgress::global(
                                    "verifying",
                                    done,
                                    verify_count,
                                    Some(file.path.clone()),
                                ));
                            }
                        }
                        let hash = hash_result.ok()?;
                        Some((file.size, *hash.as_bytes(), file.clone()))
                    })
                    .collect()
            });

            for (size, hash_bytes, file) in chunk_results {
                final_by_key
                    .entry((size, hash_bytes))
                    .or_insert_with(|| (HashKind::Full, Vec::new()))
                    .1
                    .push(file);
            }

            let now = Instant::now();
            if now.duration_since(last_checkpoint).as_millis() >= CHECKPOINT_MIN_INTERVAL_MS {
                last_checkpoint = now;
                let snapshot = build_snapshot(&final_by_key, total_files, &extension_counts);
                on_checkpoint(&snapshot);
            }
        }
    }

    let mut final_snapshot = build_snapshot(&final_by_key, total_files, &extension_counts);
    resolve_dates_in_place(&pool, &mut final_snapshot, settings.use_metadata_dates);
    final_snapshot
}

fn resolve_dates_in_place(
    pool: &rayon::ThreadPool,
    scan: &mut ScanComplete,
    use_metadata_dates: bool,
) {
    pool.install(|| {
        scan.groups.par_iter_mut().for_each(|group| {
            for file in group.files.iter_mut() {
                if file.modified_ms.is_none() {
                    file.modified_ms = resolved_date_ms(&file.path, use_metadata_dates);
                }
            }
        });
    });
}

fn build_pool(threads: &ScanThreads) -> rayon::ThreadPool {
    let n = match threads {
        ScanThreads::Auto => 0,
        ScanThreads::N(n) => *n as usize,
    };
    rayon::ThreadPoolBuilder::new()
        .num_threads(n)
        .build()
        .expect("failed to build rayon pool")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn small_identical_files_are_grouped_via_full_hash() {
        let dir = tempdir();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        let c = dir.join("c.txt");
        write_file(&a, b"hello world");
        write_file(&b, b"hello world");
        write_file(&c, b"different");

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].hash_kind, HashKind::Full);
        assert_eq!(result.groups[0].files.len(), 2);
    }

    #[test]
    fn large_files_with_same_head_but_different_tail_are_not_grouped() {
        let dir = tempdir();
        let big = LARGE_FILE_THRESHOLD as usize + 1024 * 1024;
        let mut a_bytes = vec![0xAA; big];
        let mut b_bytes = vec![0xAA; big];
        // Differ only in last byte — head 64KB matches, tail 64KB diverges.
        let last = b_bytes.len() - 1;
        a_bytes[last] = 0x01;
        b_bytes[last] = 0x02;

        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        write_file(&a, &a_bytes);
        write_file(&b, &b_bytes);

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert!(
            result.groups.is_empty(),
            "expected tail divergence to prevent grouping, got {:?}",
            result.groups
        );
    }

    #[test]
    fn large_identical_files_are_grouped_via_partial_hash() {
        let dir = tempdir();
        let big = LARGE_FILE_THRESHOLD as usize + 1024 * 1024;
        let bytes = vec![0xCD; big];
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        write_file(&a, &bytes);
        write_file(&b, &bytes);

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].hash_kind, HashKind::Partial);
        assert_eq!(result.groups[0].files.len(), 2);
    }

    #[test]
    fn extension_allowlist_excludes_others() {
        let dir = tempdir();
        let txt_a = dir.join("a.txt");
        let txt_b = dir.join("b.txt");
        let log_a = dir.join("a.log");
        let log_b = dir.join("b.log");
        write_file(&txt_a, b"same");
        write_file(&txt_b, b"same");
        write_file(&log_a, b"same");
        write_file(&log_b, b"same");

        let mut settings = Settings::default();
        settings.scan_filters.extensions = Some(vec!["txt".into()]);
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 2);
        assert_eq!(result.groups.len(), 1);
        assert!(result.extension_counts.contains_key("txt"));
        assert!(!result.extension_counts.contains_key("log"));
    }

    fn tempdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!("dupemole-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn no_duplicates_yields_empty_groups() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"alpha");
        write_file(&dir.join("b.txt"), b"beta");
        write_file(&dir.join("c.txt"), b"gamma");

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 3);
        assert!(result.groups.is_empty());
        assert_eq!(result.duplicate_files, 0);
        assert_eq!(result.wasted_bytes, 0);
    }

    #[test]
    fn three_way_duplicates_grouped_together() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"same");
        write_file(&dir.join("b.txt"), b"same");
        write_file(&dir.join("c.txt"), b"same");

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].files.len(), 3);
        assert_eq!(result.duplicate_files, 3);
        assert_eq!(result.wasted_bytes, 4 * 2);
    }

    #[test]
    fn nonexistent_root_yields_no_files_no_panic() {
        let phantom = std::env::temp_dir().join(format!("dupemole-missing-{}", Uuid::new_v4()));
        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![phantom], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 0);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn empty_files_are_skipped() {
        let dir = tempdir();
        write_file(&dir.join("empty1.txt"), b"");
        write_file(&dir.join("empty2.txt"), b"");
        write_file(&dir.join("real.txt"), b"hello");

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 1);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn min_size_filter_excludes_small_files() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"x");
        write_file(&dir.join("b.txt"), b"x");
        let big = vec![0u8; 1024];
        write_file(&dir.join("big1.bin"), &big);
        write_file(&dir.join("big2.bin"), &big);

        let mut settings = Settings::default();
        settings.scan_filters.min_size = Some(1024);
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 2);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].size, 1024);
    }

    #[test]
    fn max_size_filter_excludes_large_files() {
        let dir = tempdir();
        write_file(&dir.join("small1.txt"), b"hi");
        write_file(&dir.join("small2.txt"), b"hi");
        write_file(&dir.join("big1.bin"), &vec![0u8; 4096]);
        write_file(&dir.join("big2.bin"), &vec![0u8; 4096]);

        let mut settings = Settings::default();
        settings.scan_filters.max_size = Some(100);
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 2);
        assert_eq!(result.groups.len(), 1);
    }

    #[test]
    fn ignored_extensions_are_excluded() {
        let dir = tempdir();
        write_file(&dir.join("keep1.txt"), b"same");
        write_file(&dir.join("keep2.txt"), b"same");
        write_file(&dir.join("drop1.log"), b"same");
        write_file(&dir.join("drop2.log"), b"same");

        let mut settings = Settings::default();
        settings.scan_filters.ignored_extensions = vec!["log".into()];
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 2);
        assert_eq!(result.groups.len(), 1);
    }

    #[test]
    fn extension_allowlist_is_case_insensitive() {
        let dir = tempdir();
        write_file(&dir.join("a.JPG"), b"img");
        write_file(&dir.join("b.jpg"), b"img");

        let mut settings = Settings::default();
        settings.scan_filters.extensions = Some(vec!["jpg".into()]);
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 2);
        assert_eq!(result.groups.len(), 1);
    }

    #[test]
    fn cancelled_token_returns_empty_result() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"same");
        write_file(&dir.join("b.txt"), b"same");

        let settings = Settings::default();
        let cancel = CancelToken::new();
        cancel.0.store(true, Ordering::SeqCst);
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert!(result.groups.is_empty());
    }

    #[test]
    fn ignore_hidden_skips_dotfiles() {
        let dir = tempdir();
        write_file(&dir.join("visible1.txt"), b"same");
        write_file(&dir.join("visible2.txt"), b"same");
        write_file(&dir.join(".hidden1.txt"), b"same");
        write_file(&dir.join(".hidden2.txt"), b"same");

        let mut settings = Settings::default();
        settings.ignore_hidden = true;
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 2);
    }

    #[test]
    fn include_subdirs_false_does_not_recurse() {
        let dir = tempdir();
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        write_file(&dir.join("top.txt"), b"same");
        write_file(&sub.join("deep.txt"), b"same");

        let mut settings = Settings::default();
        settings.scan_filters.include_subdirs = false;
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 1);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn ignored_folders_are_excluded() {
        let dir = tempdir();
        let node_modules = dir.join("node_modules");
        std::fs::create_dir_all(&node_modules).unwrap();
        write_file(&dir.join("a.txt"), b"same");
        write_file(&node_modules.join("b.txt"), b"same");

        let mut settings = Settings::default();
        settings.scan_filters.ignored_folders = vec!["node_modules".into()];
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 1);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn extension_counts_track_all_walked_files() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"one");
        write_file(&dir.join("b.txt"), b"two");
        write_file(&dir.join("c.md"), b"three");

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.extension_counts.get("txt").copied(), Some(2));
        assert_eq!(result.extension_counts.get("md").copied(), Some(1));
    }

    #[test]
    fn wasted_bytes_sums_over_multiple_groups() {
        let dir = tempdir();
        let a = vec![0u8; 100];
        let b = vec![1u8; 50];
        write_file(&dir.join("a1.bin"), &a);
        write_file(&dir.join("a2.bin"), &a);
        write_file(&dir.join("a3.bin"), &a);
        write_file(&dir.join("b1.bin"), &b);
        write_file(&dir.join("b2.bin"), &b);

        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.groups.len(), 2);
        // 100 * 2 + 50 * 1 = 250
        assert_eq!(result.wasted_bytes, 250);
    }

    #[test]
    fn modified_after_filter_excludes_old_files() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"same");
        write_file(&dir.join("b.txt"), b"same");

        let mut settings = Settings::default();
        // Far in the future — nothing should pass.
        settings.scan_filters.modified_after_ms = Some(u64::MAX / 2);
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 0);
    }

    #[test]
    fn hash_kind_is_full_at_threshold_partial_above() {
        // Uses internal helpers directly to avoid materializing a 64MB+ file twice.
        // At exactly LARGE_FILE_THRESHOLD the run_scan branch chooses Full
        // (the comparison is `> THRESHOLD`).
        assert!(!(LARGE_FILE_THRESHOLD > LARGE_FILE_THRESHOLD));
        assert!(LARGE_FILE_THRESHOLD + 1 > LARGE_FILE_THRESHOLD);
    }

    #[test]
    fn duplicates_grouped_across_chunk_boundary() {
        // Force more candidates than HASH_CHUNK_SIZE so the running map must
        // merge results from multiple chunks for the same hash key.
        let dir = tempdir();
        let n = HASH_CHUNK_SIZE + 256;
        for i in 0..n {
            write_file(&dir.join(format!("f{i}.txt")), b"same-bytes");
        }
        let settings = Settings::default();
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.groups.len(), 1, "all dups must collapse to one group");
        assert_eq!(result.groups[0].files.len(), n);
    }

    #[test]
    fn checkpoint_callback_fires_and_final_matches() {
        let dir = tempdir();
        // Enough files to span at least two chunks → at least two checkpoints.
        let n = HASH_CHUNK_SIZE + 16;
        for i in 0..n {
            write_file(&dir.join(format!("f{i}.txt")), b"same-bytes");
        }
        let settings = Settings::default();
        let cancel = CancelToken::new();
        let count = std::sync::atomic::AtomicUsize::new(0);
        let last_dup_files = std::sync::atomic::AtomicU64::new(0);
        let result = run_scan(
            vec![dir.clone()],
            &settings,
            &cancel,
            |_| {},
            |snap: &ScanComplete| {
                count.fetch_add(1, Ordering::Relaxed);
                last_dup_files.store(snap.duplicate_files, Ordering::Relaxed);
            },
        );

        assert!(
            count.load(Ordering::Relaxed) >= 1,
            "at least the initial checkpoint should fire"
        );
        assert!(
            last_dup_files.load(Ordering::Relaxed) <= result.duplicate_files,
            "checkpoint snapshot must be a partial view of the final result",
        );
    }

    #[test]
    fn cancel_after_first_chunk_preserves_partial_snapshot() {
        let dir = tempdir();
        let n = HASH_CHUNK_SIZE * 2 + 32;
        for i in 0..n {
            write_file(&dir.join(format!("f{i}.txt")), b"same-bytes");
        }
        let settings = Settings::default();
        let cancel = CancelToken::new();
        let cancel_flag = cancel.0.clone();
        let captured = Mutex::new(None::<ScanComplete>);
        let chunks_seen = std::sync::atomic::AtomicUsize::new(0);
        let _ = run_scan(
            vec![dir.clone()],
            &settings,
            &cancel,
            |_| {},
            |snap: &ScanComplete| {
                let n = chunks_seen.fetch_add(1, Ordering::Relaxed) + 1;
                *captured.lock().unwrap() = Some(snap.clone());
                if n >= 1 {
                    cancel_flag.store(true, Ordering::SeqCst);
                }
            },
        );

        let snap = captured.lock().unwrap().take().expect("checkpoint must run");
        assert!(snap.duplicate_files > 0, "first checkpoint should contain partial group");
        assert_eq!(snap.groups.len(), 1);
    }

    #[test]
    fn is_macos_metadata_file_recognises_appledouble_and_dsstore() {
        assert!(is_macos_metadata_file("._photo.jpg"));
        assert!(is_macos_metadata_file("._2014-10-30 22.03.56.jpg"));
        assert!(is_macos_metadata_file(".DS_Store"));
        assert!(!is_macos_metadata_file("photo.jpg"));
        assert!(!is_macos_metadata_file(".hidden.txt"));
        assert!(!is_macos_metadata_file("ds_store"));
    }

    #[test]
    fn is_macos_metadata_dir_recognises_known_dirs() {
        assert!(is_macos_metadata_dir(".AppleDouble"));
        assert!(is_macos_metadata_dir("__MACOSX"));
        assert!(is_macos_metadata_dir(".Spotlight-V100"));
        assert!(is_macos_metadata_dir(".Trashes"));
        assert!(is_macos_metadata_dir(".fseventsd"));
        assert!(!is_macos_metadata_dir(".git"));
        assert!(!is_macos_metadata_dir("Photos"));
    }

    #[test]
    fn ignore_macos_files_filter_drops_appledouble_and_dsstore() {
        let dir = tempdir();
        write_file(&dir.join("real.jpg"), b"actual photo bytes");
        write_file(&dir.join("._real.jpg"), b"appledouble sidecar");
        write_file(&dir.join(".DS_Store"), b"finder metadata");

        let mut settings = Settings::default();
        settings.scan_filters.ignore_macos_files = true;
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {}, |_| {});

        assert_eq!(result.total_files, 1, "only real.jpg should survive");
    }
}
