use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Most recent N events live in a ring buffer; older entries are dropped.
/// Sized to comfortably hold a busy scan/organize session's worth of events
/// without unbounded memory growth.
const LOG_CAPACITY: usize = 500;

/// Severity bucket for a single log entry. Strings (not an enum) so the
/// frontend can render new levels we add in the future without a schema bump.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp_ms: u64,
    pub level: String,
    pub source: String,
    pub message: String,
}

#[derive(Default)]
pub struct LogState(pub Mutex<VecDeque<LogEntry>>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append a log entry to the in-memory ring buffer and emit `log://new` so
/// the Debug page can update live. Safe to call from any thread / Tauri
/// command. A missing `LogState` (very early startup) is a no-op rather
/// than a panic — `eprintln!` to stderr in that case so nothing is lost.
pub fn log(app: &AppHandle, level: &str, source: &str, message: impl Into<String>) {
    let entry = LogEntry {
        timestamp_ms: now_ms(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.into(),
    };
    match app.try_state::<LogState>() {
        Some(state) => {
            let mut buf = state.0.lock().unwrap();
            if buf.len() >= LOG_CAPACITY {
                buf.pop_front();
            }
            buf.push_back(entry.clone());
        }
        None => {
            eprintln!("[{}/{}] {}", entry.level, entry.source, entry.message);
        }
    }
    let _ = app.emit("log://new", entry);
}

/// Append an entry directly to a `LogState` (no `AppHandle`, no emit). Used
/// in unit tests and by callers that already hold the state.
#[cfg(test)]
pub fn push_to(state: &LogState, level: &str, source: &str, message: impl Into<String>) -> LogEntry {
    let entry = LogEntry {
        timestamp_ms: now_ms(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.into(),
    };
    let mut buf = state.0.lock().unwrap();
    if buf.len() >= LOG_CAPACITY {
        buf.pop_front();
    }
    buf.push_back(entry.clone());
    entry
}

#[tauri::command]
pub fn get_logs(state: State<LogState>) -> Vec<LogEntry> {
    state.0.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn clear_logs(state: State<LogState>) {
    state.0.lock().unwrap().clear();
}

/// Frontend-side `console.error` / explicit user actions push their own
/// entries through this command so all log surfaces share one timeline.
#[tauri::command]
pub fn push_log(level: String, source: String, message: String, app: AppHandle) {
    log(&app, &level, &source, message);
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParseFilenameDateResult {
    /// Echo of the input filename, so the frontend can render the trace
    /// without holding a separate copy.
    pub input: String,
    /// `Path::file_stem()` view of the input — the part actually scanned by
    /// the parser. Surfacing it makes "why didn't my filename match?"
    /// answerable at a glance.
    pub stem: Option<String>,
    /// Result of `media_date::read_filename_date_ms` — `None` means no
    /// date pattern was found.
    pub parsed_ms: Option<u64>,
    /// `parsed_ms` rendered as "YYYY-MM-DD HH:MM:SS UTC" for display. None
    /// when `parsed_ms` is None.
    pub formatted_utc: Option<String>,
}

#[tauri::command]
pub fn parse_filename_date_test(filename: String) -> ParseFilenameDateResult {
    let path = PathBuf::from(&filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let parsed_ms = crate::media_date::read_filename_date_ms(&path);
    let formatted_utc = parsed_ms.map(format_iso_utc);
    ParseFilenameDateResult {
        input: filename,
        stem,
        parsed_ms,
        formatted_utc,
    }
}

fn format_iso_utc(ms: u64) -> String {
    let (y, mo, d) = crate::organize::unix_ms_to_civil(ms);
    let secs = ms / 1000;
    let day_secs = (secs % 86_400) as u32;
    let h = day_secs / 3600;
    let mi = (day_secs % 3600) / 60;
    let s = day_secs % 60;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        y, mo, d, h, mi, s
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_caps_at_capacity() {
        let state = LogState::default();
        for i in 0..(LOG_CAPACITY + 50) {
            push_to(&state, "info", "test", format!("msg {}", i));
        }
        let buf = state.0.lock().unwrap();
        assert_eq!(buf.len(), LOG_CAPACITY);
        // Oldest dropped: first surviving message must be msg 50.
        assert_eq!(buf.front().unwrap().message, "msg 50");
        assert_eq!(
            buf.back().unwrap().message,
            format!("msg {}", LOG_CAPACITY + 49)
        );
    }

    #[test]
    fn push_to_returns_entry_with_level_source_message() {
        let state = LogState::default();
        let e = push_to(&state, "error", "scan", "kaboom");
        assert_eq!(e.level, "error");
        assert_eq!(e.source, "scan");
        assert_eq!(e.message, "kaboom");
        assert!(e.timestamp_ms > 0, "timestamp should be populated");
    }

    #[test]
    fn parse_filename_date_test_returns_none_for_non_date_filename() {
        let r = parse_filename_date_test("vacation.jpg".to_string());
        assert_eq!(r.input, "vacation.jpg");
        assert_eq!(r.stem, Some("vacation".to_string()));
        assert_eq!(r.parsed_ms, None);
        assert_eq!(r.formatted_utc, None);
    }

    #[test]
    fn parse_filename_date_test_handles_users_gif_example() {
        let r = parse_filename_date_test("2018-10-07 00_32_48 +0000.gif".to_string());
        assert_eq!(r.stem.as_deref(), Some("2018-10-07 00_32_48 +0000"));
        // 2018-10-07 00:32:48 UTC = 1_538_872_368 s
        assert_eq!(r.parsed_ms, Some(1_538_872_368_000));
        assert_eq!(
            r.formatted_utc.as_deref(),
            Some("2018-10-07 00:32:48 UTC")
        );
    }

    #[test]
    fn parse_filename_date_test_handles_dash_only_form() {
        let r = parse_filename_date_test("2025-02-11.jpg".to_string());
        assert_eq!(r.parsed_ms.is_some(), true);
        // No time → defaults to noon UTC (see media_date::parse_optional_time).
        assert_eq!(r.formatted_utc.as_deref(), Some("2025-02-11 12:00:00 UTC"));
    }

    #[test]
    fn parse_filename_date_test_handles_compact_eight_digit() {
        let r = parse_filename_date_test("IMG_20240315_143015.jpg".to_string());
        assert_eq!(r.formatted_utc.as_deref(), Some("2024-03-15 14:30:15 UTC"));
    }

    #[test]
    fn parse_filename_date_test_handles_bare_stem_no_extension() {
        // Path::file_stem on a name with no '.' returns the whole name.
        let r = parse_filename_date_test("2025-02-11".to_string());
        assert_eq!(r.stem.as_deref(), Some("2025-02-11"));
        assert!(r.parsed_ms.is_some());
    }

    #[test]
    fn parse_filename_date_test_empty_input_is_none() {
        let r = parse_filename_date_test(String::new());
        assert_eq!(r.parsed_ms, None);
        assert_eq!(r.formatted_utc, None);
    }

    #[test]
    fn format_iso_utc_known_values() {
        assert_eq!(format_iso_utc(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(format_iso_utc(1_710_504_000_000), "2024-03-15 12:00:00 UTC");
    }
}
