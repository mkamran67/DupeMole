use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::settings::{Filters, ScanThreads, Settings};

const LARGE_FILE_THRESHOLD: u64 = 64 * 1024 * 1024;
const PARTIAL_HASH_BYTES: u64 = 64 * 1024;

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

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

fn passes_filters(path: &Path, size: u64, filters: &Filters) -> bool {
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

fn walk_files(
    roots: &[PathBuf],
    ignore_hidden: bool,
    filters: &Filters,
    cancel: &CancelToken,
    extension_counts: &mut HashMap<String, u64>,
) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let ignored_folders: Vec<String> = filters
        .ignored_folders
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
    for root in roots {
        let mut walker = WalkDir::new(root).follow_links(false);
        if !filters.include_subdirs {
            walker = walker.max_depth(1);
        }
        for entry in walker.into_iter().filter_entry(|e| {
            let name = e.file_name().to_str().unwrap_or("");
            if ignore_hidden && name.starts_with('.') {
                return false;
            }
            if e.file_type().is_dir()
                && ignored_folders
                    .iter()
                    .any(|f| name.eq_ignore_ascii_case(f))
            {
                return false;
            }
            true
        }) {
            if cancel.is_cancelled() {
                return out;
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let size = meta.len();
            if size == 0 {
                continue;
            }
            let path = entry.into_path();
            if !passes_filters(&path, size, filters) {
                continue;
            }
            if let Some(ext) = extension_lower(&path) {
                *extension_counts.entry(ext).or_insert(0) += 1;
            }
            out.push((path, size));
        }
    }
    out
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

fn hash_file_full(path: &Path) -> std::io::Result<blake3::Hash> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize())
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

pub fn run_scan<F>(
    paths: Vec<PathBuf>,
    settings: &Settings,
    cancel: &CancelToken,
    on_progress: F,
) -> ScanComplete
where
    F: Fn(ScanProgress) + Sync + Send,
{
    on_progress(ScanProgress {
        processed: 0,
        total: 0,
        current_path: None,
        phase: "walking",
    });

    let mut extension_counts: HashMap<String, u64> = HashMap::new();
    let all_files = walk_files(
        &paths,
        settings.ignore_hidden,
        &settings.filters,
        cancel,
        &mut extension_counts,
    );
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
    let candidate_count: u64 = size_groups.iter().map(|(_, v)| v.len() as u64).sum();

    on_progress(ScanProgress {
        processed: 0,
        total: candidate_count,
        current_path: None,
        phase: "hashing",
    });

    let pool = build_pool(&settings.scan_threads);

    let processed = AtomicU64::new(0);
    let groups: Vec<DuplicateGroup> = pool.install(|| {
        size_groups
            .par_iter()
            .flat_map(|(size, paths)| {
                if cancel.is_cancelled() {
                    return Vec::new();
                }
                let kind = if *size > LARGE_FILE_THRESHOLD {
                    HashKind::Partial
                } else {
                    HashKind::Full
                };
                let mut by_hash: HashMap<String, Vec<DuplicateFile>> = HashMap::new();
                for path in paths {
                    if cancel.is_cancelled() {
                        return Vec::new();
                    }
                    let hash_result = match kind {
                        HashKind::Full => hash_file_full(path),
                        HashKind::Partial => hash_file_partial(path, *size),
                    };
                    let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                    on_progress(ScanProgress {
                        processed: done,
                        total: candidate_count,
                        current_path: Some(path.clone()),
                        phase: "hashing",
                    });
                    let Ok(hash) = hash_result else { continue };
                    by_hash
                        .entry(hash.to_hex().to_string())
                        .or_default()
                        .push(DuplicateFile {
                            path: path.clone(),
                            size: *size,
                            modified_ms: modified_ms(path),
                        });
                }
                by_hash
                    .into_iter()
                    .filter(|(_, files)| files.len() >= 2)
                    .map(|(hash, files)| DuplicateGroup {
                        id: Uuid::new_v4().to_string(),
                        hash,
                        size: *size,
                        hash_kind: kind,
                        files,
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    });

    let duplicate_files: u64 = groups.iter().map(|g| g.files.len() as u64).sum();
    let wasted_bytes: u64 = groups
        .iter()
        .map(|g| g.size * (g.files.len() as u64 - 1))
        .sum();

    ScanComplete {
        groups,
        total_files,
        duplicate_files,
        wasted_bytes,
        extension_counts,
    }
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
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {});

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
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {});

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
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {});

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
        settings.filters.extensions = Some(vec!["txt".into()]);
        let cancel = CancelToken::new();
        let result = run_scan(vec![dir.clone()], &settings, &cancel, |_| {});

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
}
