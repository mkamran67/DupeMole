use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::scanner::{is_macos_metadata_dir, is_macos_metadata_file};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AnalyzeSettings {
    pub ignore_hidden: bool,
    pub ignore_macos_files: bool,
    pub include_subdirs: bool,
    pub extensions: Option<Vec<String>>,
    pub ignored_extensions: Vec<String>,
    pub ignored_folders: Vec<String>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub modified_after_ms: Option<u64>,
    pub modified_before_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStat {
    pub extension: String,
    pub count: u64,
    pub total_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SizeBucket {
    pub label: String,
    pub min_bytes: u64,
    pub max_bytes: Option<u64>,
    pub count: u64,
    pub total_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgeBucket {
    pub label: String,
    pub count: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LargestFile {
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AnalysisReport {
    pub total_files: u64,
    pub total_bytes: u64,
    pub largest_file: Option<LargestFile>,
    pub smallest_file: Option<LargestFile>,
    pub average_bytes: u64,
    pub median_bytes: u64,
    pub oldest_modified_ms: Option<u64>,
    pub newest_modified_ms: Option<u64>,
    pub extensions: Vec<ExtensionStat>,
    pub size_buckets: Vec<SizeBucket>,
    pub age_buckets: Vec<AgeBucket>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub processed: u64,
    pub current_path: Option<PathBuf>,
    pub folder_index: u32,
    pub folder_total: u32,
    pub folder_path: PathBuf,
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

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    let m = meta.modified().ok()?;
    let d = m.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_millis() as u64)
}

fn passes_filters(path: &Path, size: u64, modified: Option<u64>, s: &AnalyzeSettings) -> bool {
    if s.ignore_macos_files {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if is_macos_metadata_file(name) {
                return false;
            }
        }
    }
    if let Some(min) = s.min_size {
        if size < min {
            return false;
        }
    }
    if let Some(max) = s.max_size {
        if size > max {
            return false;
        }
    }
    let ext = extension_lower(path);
    if let Some(ref e) = ext {
        if s.ignored_extensions.iter().any(|i| i.eq_ignore_ascii_case(e)) {
            return false;
        }
    }
    if let Some(ref allow) = s.extensions {
        match ext {
            Some(ref e) if allow.iter().any(|a| a.eq_ignore_ascii_case(e)) => {}
            _ => return false,
        }
    }
    if s.modified_after_ms.is_some() || s.modified_before_ms.is_some() {
        let m = match modified {
            Some(v) => v,
            None => return false,
        };
        if let Some(after) = s.modified_after_ms {
            if m < after {
                return false;
            }
        }
        if let Some(before) = s.modified_before_ms {
            if m > before {
                return false;
            }
        }
    }
    true
}

const DAY_MS: u64 = 86_400_000;

fn size_bucket_index(size: u64) -> usize {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if size < KB {
        0
    } else if size < MB {
        1
    } else if size < 100 * MB {
        2
    } else if size < GB {
        3
    } else {
        4
    }
}

fn new_size_buckets() -> Vec<SizeBucket> {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    vec![
        SizeBucket { label: "<1KB".into(), min_bytes: 0, max_bytes: Some(KB), count: 0, total_bytes: 0 },
        SizeBucket { label: "1KB–1MB".into(), min_bytes: KB, max_bytes: Some(MB), count: 0, total_bytes: 0 },
        SizeBucket { label: "1MB–100MB".into(), min_bytes: MB, max_bytes: Some(100 * MB), count: 0, total_bytes: 0 },
        SizeBucket { label: "100MB–1GB".into(), min_bytes: 100 * MB, max_bytes: Some(GB), count: 0, total_bytes: 0 },
        SizeBucket { label: ">1GB".into(), min_bytes: GB, max_bytes: None, count: 0, total_bytes: 0 },
    ]
}

fn age_bucket_index(modified_ms: Option<u64>, now_ms: u64) -> usize {
    let Some(m) = modified_ms else { return 5 };
    let age = now_ms.saturating_sub(m);
    if age < DAY_MS {
        0
    } else if age < 7 * DAY_MS {
        1
    } else if age < 30 * DAY_MS {
        2
    } else if age < 365 * DAY_MS {
        3
    } else {
        4
    }
}

fn new_age_buckets() -> Vec<AgeBucket> {
    vec![
        AgeBucket { label: "<1d".into(), count: 0 },
        AgeBucket { label: "1d–1w".into(), count: 0 },
        AgeBucket { label: "1w–1mo".into(), count: 0 },
        AgeBucket { label: "1mo–1y".into(), count: 0 },
        AgeBucket { label: ">1y".into(), count: 0 },
        AgeBucket { label: "unknown".into(), count: 0 },
    ]
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn run_analysis<F>(
    paths: Vec<PathBuf>,
    settings: &AnalyzeSettings,
    cancel: &CancelToken,
    on_progress: F,
) -> AnalysisReport
where
    F: Fn(AnalysisProgress) + Send + Sync,
{
    let ignored_folders_lower: Vec<String> =
        settings.ignored_folders.iter().map(|s| s.to_lowercase()).collect();

    let mut sizes: Vec<u64> = Vec::new();
    let mut ext_map: HashMap<String, (u64, u64)> = HashMap::new(); // ext -> (count, bytes)
    let mut size_buckets = new_size_buckets();
    let mut age_buckets = new_age_buckets();

    let mut total_files: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut largest: Option<(PathBuf, u64)> = None;
    let mut smallest: Option<(PathBuf, u64)> = None;
    let mut oldest: Option<u64> = None;
    let mut newest: Option<u64> = None;

    let now = now_ms();
    let folder_total = paths.len() as u32;

    for (i, root) in paths.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let folder_index = i as u32;
        let mut walker = WalkDir::new(root).follow_links(false);
        if !settings.include_subdirs {
            walker = walker.max_depth(1);
        }
        let ignore_hidden = settings.ignore_hidden;
        let ignore_macos = settings.ignore_macos_files;
        let ignored_folders = ignored_folders_lower.clone();
        let mut last_emit = Instant::now();
        let mut visited: u64 = 0;

        let iter = walker.into_iter().filter_entry(move |e| {
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
        });

        for entry in iter {
            if cancel.is_cancelled() {
                break;
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            visited += 1;
            let Ok(meta) = entry.metadata() else { continue };
            let size = meta.len();
            let modified = modified_ms(&meta);
            let path = entry.into_path();
            if !passes_filters(&path, size, modified, settings) {
                continue;
            }

            total_files += 1;
            total_bytes = total_bytes.saturating_add(size);
            sizes.push(size);

            let ext_key = extension_lower(&path).unwrap_or_default();
            let entry = ext_map.entry(ext_key).or_insert((0, 0));
            entry.0 += 1;
            entry.1 = entry.1.saturating_add(size);

            let sb = &mut size_buckets[size_bucket_index(size)];
            sb.count += 1;
            sb.total_bytes = sb.total_bytes.saturating_add(size);

            let ab = &mut age_buckets[age_bucket_index(modified, now)];
            ab.count += 1;

            match &largest {
                Some((_, s)) if *s >= size => {}
                _ => largest = Some((path.clone(), size)),
            }
            match &smallest {
                Some((_, s)) if *s <= size => {}
                _ => smallest = Some((path.clone(), size)),
            }
            if let Some(m) = modified {
                oldest = Some(oldest.map_or(m, |o| o.min(m)));
                newest = Some(newest.map_or(m, |n| n.max(m)));
            }

            let now_t = Instant::now();
            if visited % 256 == 0 || now_t.duration_since(last_emit).as_millis() >= 80 {
                last_emit = now_t;
                on_progress(AnalysisProgress {
                    processed: total_files,
                    current_path: Some(path),
                    folder_index,
                    folder_total,
                    folder_path: root.clone(),
                });
            }
        }
    }

    let average_bytes = if total_files == 0 { 0 } else { total_bytes / total_files };
    sizes.sort_unstable();
    let median_bytes = if sizes.is_empty() {
        0
    } else if sizes.len() % 2 == 1 {
        sizes[sizes.len() / 2]
    } else {
        let mid = sizes.len() / 2;
        (sizes[mid - 1] + sizes[mid]) / 2
    };

    let mut extensions: Vec<ExtensionStat> = ext_map
        .into_iter()
        .map(|(extension, (count, total_bytes))| ExtensionStat {
            extension,
            count,
            total_bytes,
        })
        .collect();
    extensions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| b.total_bytes.cmp(&a.total_bytes)));

    AnalysisReport {
        total_files,
        total_bytes,
        largest_file: largest.map(|(path, size)| LargestFile { path, size }),
        smallest_file: smallest.map(|(path, size)| LargestFile { path, size }),
        average_bytes,
        median_bytes,
        oldest_modified_ms: oldest,
        newest_modified_ms: newest,
        extensions,
        size_buckets,
        age_buckets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use uuid::Uuid;

    fn tempdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!("dupemole-analysis-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    fn s() -> AnalyzeSettings {
        AnalyzeSettings { include_subdirs: true, ..Default::default() }
    }

    #[test]
    fn happy_path_counts_files_and_extensions() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"hello");
        write_file(&dir.join("b.txt"), b"world!!");
        write_file(&dir.join("c.jpg"), b"jpeg-bytes");

        let r = run_analysis(vec![dir], &s(), &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 3);
        assert_eq!(r.total_bytes, 5 + 7 + 10);
        let txt = r.extensions.iter().find(|e| e.extension == "txt").unwrap();
        assert_eq!(txt.count, 2);
        assert_eq!(txt.total_bytes, 12);
        let jpg = r.extensions.iter().find(|e| e.extension == "jpg").unwrap();
        assert_eq!(jpg.count, 1);
    }

    #[test]
    fn nonexistent_path_yields_zero_totals() {
        let r = run_analysis(
            vec![PathBuf::from("/definitely/not/a/real/path/here-xyz")],
            &s(),
            &CancelToken::new(),
            |_| {},
        );
        assert_eq!(r.total_files, 0);
        assert_eq!(r.total_bytes, 0);
        assert!(r.largest_file.is_none());
        assert_eq!(r.average_bytes, 0);
    }

    #[test]
    fn empty_directory_yields_zero_totals() {
        let dir = tempdir();
        let r = run_analysis(vec![dir], &s(), &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 0);
        assert!(r.extensions.is_empty());
        assert_eq!(r.median_bytes, 0);
        assert_eq!(r.average_bytes, 0);
    }

    #[test]
    fn single_file_median_equals_size() {
        let dir = tempdir();
        write_file(&dir.join("only.bin"), &vec![0u8; 500]);
        let r = run_analysis(vec![dir], &s(), &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 1);
        assert_eq!(r.median_bytes, 500);
        assert_eq!(r.average_bytes, 500);
        assert_eq!(r.largest_file.as_ref().unwrap().size, 500);
        assert_eq!(r.smallest_file.as_ref().unwrap().size, 500);
    }

    #[test]
    fn size_bucket_boundary_1024_lands_in_kb_bucket() {
        let dir = tempdir();
        write_file(&dir.join("tiny.bin"), &vec![0u8; 1023]);
        write_file(&dir.join("kb.bin"), &vec![0u8; 1024]);
        let r = run_analysis(vec![dir], &s(), &CancelToken::new(), |_| {});
        assert_eq!(r.size_buckets[0].count, 1, "1023 byte file must be in <1KB bucket");
        assert_eq!(r.size_buckets[1].count, 1, "exactly 1024 must be in 1KB–1MB bucket");
    }

    #[test]
    fn ignore_hidden_excludes_dotfiles() {
        let dir = tempdir();
        write_file(&dir.join("visible.txt"), b"hi");
        write_file(&dir.join(".hidden"), b"secret");
        let mut settings = s();
        settings.ignore_hidden = true;
        let r = run_analysis(vec![dir.clone()], &settings, &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 1);

        let mut settings2 = s();
        settings2.ignore_hidden = false;
        let r2 = run_analysis(vec![dir], &settings2, &CancelToken::new(), |_| {});
        assert_eq!(r2.total_files, 2);
    }

    #[test]
    fn include_subdirs_false_stays_at_top_level() {
        let dir = tempdir();
        write_file(&dir.join("top.txt"), b"a");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        write_file(&sub.join("nested.txt"), b"b");

        let mut settings = s();
        settings.include_subdirs = false;
        let r = run_analysis(vec![dir.clone()], &settings, &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 1);

        settings.include_subdirs = true;
        let r2 = run_analysis(vec![dir], &settings, &CancelToken::new(), |_| {});
        assert_eq!(r2.total_files, 2);
    }

    #[test]
    fn extension_allowlist_filters_files() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"a");
        write_file(&dir.join("b.log"), b"b");
        let mut settings = s();
        settings.extensions = Some(vec!["txt".into()]);
        let r = run_analysis(vec![dir], &settings, &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 1);
        assert_eq!(r.extensions.len(), 1);
        assert_eq!(r.extensions[0].extension, "txt");
    }

    #[test]
    fn extension_blocklist_filters_files() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"a");
        write_file(&dir.join("b.log"), b"b");
        let mut settings = s();
        settings.ignored_extensions = vec!["log".into()];
        let r = run_analysis(vec![dir], &settings, &CancelToken::new(), |_| {});
        assert_eq!(r.total_files, 1);
    }

    #[test]
    fn largest_and_smallest_files_tracked() {
        let dir = tempdir();
        write_file(&dir.join("small.txt"), &vec![0u8; 10]);
        write_file(&dir.join("mid.txt"), &vec![0u8; 100]);
        write_file(&dir.join("big.txt"), &vec![0u8; 1000]);
        let r = run_analysis(vec![dir], &s(), &CancelToken::new(), |_| {});
        assert_eq!(r.largest_file.as_ref().unwrap().size, 1000);
        assert_eq!(r.smallest_file.as_ref().unwrap().size, 10);
        assert_eq!(r.median_bytes, 100);
        assert_eq!(r.average_bytes, (10 + 100 + 1000) / 3);
    }

    #[test]
    fn extensions_sorted_by_count_desc() {
        let dir = tempdir();
        write_file(&dir.join("a.txt"), b"a");
        write_file(&dir.join("b.txt"), b"b");
        write_file(&dir.join("c.txt"), b"c");
        write_file(&dir.join("d.jpg"), b"d");
        let r = run_analysis(vec![dir], &s(), &CancelToken::new(), |_| {});
        assert_eq!(r.extensions[0].extension, "txt");
        assert_eq!(r.extensions[0].count, 3);
        assert_eq!(r.extensions[1].extension, "jpg");
    }
}
