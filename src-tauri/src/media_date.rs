use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "tif", "tiff", "heic", "heif", "webp", "bmp", "gif", "avif", "svg",
    "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "arq", "srf", "sr2", "rw2", "orf", "raf",
    "pef", "3fr", "iiq", "mef", "x3f", "erf", "raw", "dcr", "kdc", "mrw", "rwl",
];
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "3gp", "3g2"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Other,
}

pub fn media_kind(path: &Path) -> MediaKind {
    let Some(ext) = ext_lower(path) else {
        return MediaKind::Other;
    };
    if IMAGE_EXTS.iter().any(|e| *e == ext) {
        return MediaKind::Image;
    }
    if VIDEO_EXTS.iter().any(|e| *e == ext) {
        return MediaKind::Video;
    }
    MediaKind::Other
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

fn parse_exif_datetime(s: &str) -> Option<u64> {
    // EXIF DateTimeOriginal format: "YYYY:MM:DD HH:MM:SS" (no timezone).
    // Treat as UTC — best-effort, since EXIF rarely carries a tz.
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i32 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let month: u32 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let day: u32 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    let hour: u32 = std::str::from_utf8(&bytes[11..13]).ok()?.parse().ok()?;
    let minute: u32 = std::str::from_utf8(&bytes[14..16]).ok()?.parse().ok()?;
    let second: u32 = std::str::from_utf8(&bytes[17..19]).ok()?.parse().ok()?;
    civil_to_unix_ms(year, month, day, hour, minute, second)
}

/// Convert a Gregorian (UTC) date to milliseconds since the Unix epoch.
/// Uses the days-from-civil algorithm (Hinnant).
fn civil_to_unix_ms(y: i32, m: u32, d: u32, h: u32, min: u32, s: u32) -> Option<u64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 || s > 60 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let m_u = m as i32;
    let doy = (153 * (m_u + (if m_u > 2 { -3 } else { 9 })) + 2) / 5 + d as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u32;
    let days_since_epoch: i64 = era as i64 * 146097 + doe as i64 - 719468;
    let secs = days_since_epoch * 86400 + h as i64 * 3600 + min as i64 * 60 + s as i64;
    if secs < 0 {
        return None;
    }
    Some((secs as u64) * 1000)
}

fn read_image_exif_ms(path: &Path) -> Option<u64> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif_reader = exif::Reader::new();
    let exif = exif_reader.read_from_container(&mut reader).ok()?;
    // Prefer DateTimeOriginal, fall back to DateTime (file modification per EXIF).
    for tag in [exif::Tag::DateTimeOriginal, exif::Tag::DateTime] {
        if let Some(field) = exif.get_field(tag, exif::In::PRIMARY) {
            let s = field.display_value().to_string();
            if let Some(ms) = parse_exif_datetime(&s) {
                return Some(ms);
            }
        }
    }
    None
}

// MP4 / QuickTime creation_time is seconds since 1904-01-01 UTC.
// Unix epoch (1970-01-01) is 2_082_844_800 seconds later.
const MAC_TO_UNIX_SECS: u64 = 2_082_844_800;

/// Walk top-level ISO BMFF (MP4/MOV) atoms looking for `moov`, then walk its
/// children for `mvhd` and return the parsed creation_time (Unix ms).
fn read_mp4_creation_ms(path: &Path) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let total = file.metadata().ok()?.len();
    let moov_range = find_top_level_atom(&mut file, total, *b"moov")?;
    file.seek(SeekFrom::Start(moov_range.0)).ok()?;
    let mvhd_range = find_top_level_atom(&mut file, moov_range.1, *b"mvhd")?;
    file.seek(SeekFrom::Start(mvhd_range.0)).ok()?;
    parse_mvhd_creation_ms(&mut file)
}

/// Returns the (start_offset, end_offset) of the first atom matching `tag`
/// found in the box-stream starting at the file's current position, scanning
/// up to absolute offset `end`. Offsets point at the atom's *payload*, not
/// its header.
fn find_top_level_atom(file: &mut File, end: u64, tag: [u8; 4]) -> Option<(u64, u64)> {
    loop {
        let pos = file.stream_position().ok()?;
        if pos + 8 > end {
            return None;
        }
        let mut header = [0u8; 8];
        file.read_exact(&mut header).ok()?;
        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let atom_type = [header[4], header[5], header[6], header[7]];

        let (payload_start, atom_end) = match size {
            0 => (pos + 8, end), // box extends to end of file
            1 => {
                let mut ext = [0u8; 8];
                file.read_exact(&mut ext).ok()?;
                let ext_size = u64::from_be_bytes(ext);
                if ext_size < 16 {
                    return None;
                }
                (pos + 16, pos + ext_size)
            }
            n if n >= 8 => (pos + 8, pos + n),
            _ => return None,
        };

        if atom_type == tag {
            return Some((payload_start, atom_end));
        }
        if atom_end <= pos {
            return None;
        }
        file.seek(SeekFrom::Start(atom_end)).ok()?;
    }
}

fn parse_mvhd_creation_ms(file: &mut File) -> Option<u64> {
    let mut ver_flags = [0u8; 4];
    file.read_exact(&mut ver_flags).ok()?;
    let version = ver_flags[0];
    let secs_since_1904: u64 = match version {
        0 => {
            let mut buf = [0u8; 4];
            file.read_exact(&mut buf).ok()?;
            u32::from_be_bytes(buf) as u64
        }
        1 => {
            let mut buf = [0u8; 8];
            file.read_exact(&mut buf).ok()?;
            u64::from_be_bytes(buf)
        }
        _ => return None,
    };
    if secs_since_1904 <= MAC_TO_UNIX_SECS {
        return None;
    }
    Some((secs_since_1904 - MAC_TO_UNIX_SECS) * 1000)
}

/// Scan a filename stem for an embedded date (and optional time), returning
/// it as Unix ms. Used as a fallback when metadata has no capture date — many
/// camera exports and screenshots encode the date in the name itself.
///
/// Accepted patterns (year must be 1970–2100):
///   YYYY-MM-DD, YYYY_MM_DD, YYYYMMDD
/// Optionally followed by a separator (`-`, `_`, ` `, or `T`) and a time:
///   HHMMSS, HH-MM-SS, HH_MM_SS, HH:MM:SS
/// If no time is present, defaults to noon UTC to avoid day-boundary issues.
pub fn read_filename_date_ms(path: &Path) -> Option<u64> {
    let stem = path.file_stem()?.to_str()?;
    parse_filename_date_ms(stem)
}

fn parse_filename_date_ms(stem: &str) -> Option<u64> {
    let bytes = stem.as_bytes();
    let n = bytes.len();
    if n < 8 {
        return None;
    }
    let mut i = 0;
    while i + 8 <= n {
        // Don't match digits embedded inside a longer digit run (e.g. avoid
        // pulling "20240101" out of "120240101"). Require a non-digit (or
        // start-of-string) immediately before the year.
        if i > 0 && bytes[i - 1].is_ascii_digit() {
            i += 1;
            continue;
        }
        if let Some((ms, consumed)) = try_date_at(bytes, i) {
            // Also ensure the date isn't followed by a digit that would make
            // the year/day part of a longer number we mis-parsed.
            let after = i + consumed;
            if after < n && bytes[after].is_ascii_digit() {
                // Special case: 8-digit form followed by a digit means we're
                // inside a longer run; skip.
                i += 1;
                continue;
            }
            return Some(ms);
        }
        i += 1;
    }
    None
}

fn try_date_at(bytes: &[u8], i: usize) -> Option<(u64, usize)> {
    let n = bytes.len();
    let year = parse_n_digits(bytes, i, 4)?;
    if !(1970..=2100).contains(&year) {
        return None;
    }
    let (month, day, date_len) = if i + 10 <= n
        && is_date_sep(bytes[i + 4])
        && is_date_sep(bytes[i + 7])
    {
        let m = parse_n_digits(bytes, i + 5, 2)?;
        let d = parse_n_digits(bytes, i + 8, 2)?;
        (m, d, 10)
    } else if i + 8 <= n {
        let m = parse_n_digits(bytes, i + 4, 2)?;
        let d = parse_n_digits(bytes, i + 6, 2)?;
        (m, d, 8)
    } else {
        return None;
    };

    let (h, mi, s, end) = parse_optional_time(bytes, i + date_len)
        .unwrap_or((12, 0, 0, i + date_len));
    let ms = civil_to_unix_ms(year as i32, month, day, h, mi, s)?;
    Some((ms, end - i))
}

/// Try to parse a time suffix starting at `start` (the separator byte before
/// the time). Returns (hour, minute, second, end_index) on success.
fn parse_optional_time(bytes: &[u8], start: usize) -> Option<(u32, u32, u32, usize)> {
    let n = bytes.len();
    if start >= n || !matches!(bytes[start], b'-' | b'_' | b' ' | b'T' | b't') {
        return None;
    }
    let t = start + 1;
    // HHMMSS (6 consecutive digits, not part of a longer run)
    if t + 6 <= n
        && (0..6).all(|k| bytes[t + k].is_ascii_digit())
        && (t + 6 == n || !bytes[t + 6].is_ascii_digit())
    {
        let h = parse_n_digits(bytes, t, 2)?;
        let mi = parse_n_digits(bytes, t + 2, 2)?;
        let s = parse_n_digits(bytes, t + 4, 2)?;
        return Some((h, mi, s, t + 6));
    }
    // HH[sep]MM[sep]SS where sep is - _ :
    if t + 8 <= n {
        let sep1 = bytes[t + 2];
        let sep2 = bytes[t + 5];
        if matches!(sep1, b'-' | b'_' | b':') && sep1 == sep2 {
            let h = parse_n_digits(bytes, t, 2)?;
            let mi = parse_n_digits(bytes, t + 3, 2)?;
            let s = parse_n_digits(bytes, t + 6, 2)?;
            return Some((h, mi, s, t + 8));
        }
    }
    None
}

fn is_date_sep(b: u8) -> bool {
    b == b'-' || b == b'_'
}

fn parse_n_digits(bytes: &[u8], start: usize, n: usize) -> Option<u32> {
    if start + n > bytes.len() {
        return None;
    }
    let mut v: u32 = 0;
    for k in 0..n {
        let c = bytes[start + k];
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as u32;
    }
    Some(v)
}

/// Returns the original-capture timestamp (ms since Unix epoch) read from
/// media metadata, or None if the format is unsupported or no tag is present.
pub fn read_metadata_ms(path: &Path) -> Option<u64> {
    let ext = ext_lower(path)?;
    if IMAGE_EXTS.iter().any(|e| *e == ext) {
        return read_image_exif_ms(path);
    }
    if VIDEO_EXTS.iter().any(|e| *e == ext) {
        return read_mp4_creation_ms(path);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_exif_datetime_known_timestamp() {
        // 2024-03-15 12:00:00 UTC → 1_710_504_000_000 ms
        let ms = parse_exif_datetime("2024:03:15 12:00:00").unwrap();
        assert_eq!(ms, 1_710_504_000_000);
    }

    #[test]
    fn parse_exif_datetime_epoch() {
        let ms = parse_exif_datetime("1970:01:01 00:00:00").unwrap();
        assert_eq!(ms, 0);
    }

    #[test]
    fn parse_exif_datetime_too_short_returns_none() {
        assert!(parse_exif_datetime("2024:03:15").is_none());
        assert!(parse_exif_datetime("").is_none());
    }

    #[test]
    fn parse_exif_datetime_malformed_returns_none() {
        assert!(parse_exif_datetime("not-a-date-at-all").is_none());
        assert!(parse_exif_datetime("XXXX:XX:XX XX:XX:XX").is_none());
    }

    #[test]
    fn parse_exif_datetime_invalid_month_returns_none() {
        assert!(parse_exif_datetime("2024:13:01 00:00:00").is_none());
        assert!(parse_exif_datetime("2024:00:01 00:00:00").is_none());
    }

    #[test]
    fn civil_to_unix_ms_round_trips_with_unix_ms_to_civil() {
        // Use organize::unix_ms_to_civil indirectly: just verify a known value.
        let ms = civil_to_unix_ms(2024, 3, 15, 12, 0, 0).unwrap();
        assert_eq!(ms, 1_710_504_000_000);
    }

    #[test]
    fn civil_to_unix_ms_rejects_pre_epoch() {
        assert!(civil_to_unix_ms(1969, 12, 31, 0, 0, 0).is_none());
    }

    #[test]
    fn civil_to_unix_ms_rejects_invalid_components() {
        assert!(civil_to_unix_ms(2024, 0, 1, 0, 0, 0).is_none());
        assert!(civil_to_unix_ms(2024, 13, 1, 0, 0, 0).is_none());
        assert!(civil_to_unix_ms(2024, 1, 0, 0, 0, 0).is_none());
        assert!(civil_to_unix_ms(2024, 1, 32, 0, 0, 0).is_none());
        assert!(civil_to_unix_ms(2024, 1, 1, 24, 0, 0).is_none());
        assert!(civil_to_unix_ms(2024, 1, 1, 0, 60, 0).is_none());
    }

    #[test]
    fn read_metadata_ms_unknown_extension_returns_none() {
        let path = Path::new("/nonexistent/foo.txt");
        assert!(read_metadata_ms(path).is_none());
    }

    #[test]
    fn read_metadata_ms_missing_image_file_returns_none() {
        let path = Path::new("/nonexistent/foo.jpg");
        assert!(read_metadata_ms(path).is_none());
    }

    #[test]
    fn read_metadata_ms_extensionless_returns_none() {
        let path = Path::new("/nonexistent/no_ext");
        assert!(read_metadata_ms(path).is_none());
    }

    #[test]
    fn filename_date_dash_separated() {
        let ms = parse_filename_date_ms("2025-02-11-0005").unwrap();
        // 2025-02-11 12:00:00 UTC
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 12, 0, 0).unwrap());
    }

    #[test]
    fn filename_date_underscore_separated() {
        let ms = parse_filename_date_ms("2025_02_11").unwrap();
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 12, 0, 0).unwrap());
    }

    #[test]
    fn filename_date_compact_eight_digit() {
        let ms = parse_filename_date_ms("20250211-0005").unwrap();
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 12, 0, 0).unwrap());
    }

    #[test]
    fn filename_date_with_compact_time() {
        let ms = parse_filename_date_ms("IMG_20250211_143015").unwrap();
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 14, 30, 15).unwrap());
    }

    #[test]
    fn filename_date_with_separated_time() {
        let ms = parse_filename_date_ms("2025-02-11T14-30-15").unwrap();
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 14, 30, 15).unwrap());
    }

    #[test]
    fn filename_date_embedded_mid_name() {
        let ms = parse_filename_date_ms("screenshot-2025-02-11-at-3pm").unwrap();
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 12, 0, 0).unwrap());
    }

    #[test]
    fn filename_date_no_date_returns_none() {
        assert!(parse_filename_date_ms("vacation").is_none());
        assert!(parse_filename_date_ms("IMG_0001").is_none());
    }

    #[test]
    fn filename_date_invalid_month_day_returns_none() {
        assert!(parse_filename_date_ms("1234-56-78").is_none());
        assert!(parse_filename_date_ms("2025-13-01").is_none());
        assert!(parse_filename_date_ms("2025-02-32").is_none());
    }

    #[test]
    fn filename_date_pre_1970_year_returns_none() {
        assert!(parse_filename_date_ms("1899-01-01").is_none());
        assert!(parse_filename_date_ms("1969-12-31").is_none());
    }

    #[test]
    fn filename_date_avoids_longer_digit_runs() {
        // Don't pull 20250211 out of 120250211 / 202502115
        assert!(parse_filename_date_ms("120250211").is_none());
        assert!(parse_filename_date_ms("202502115").is_none());
    }

    #[test]
    fn read_filename_date_ms_via_path() {
        let path = Path::new("/some/dir/2025-02-11-0005.jpg");
        let ms = read_filename_date_ms(path).unwrap();
        assert_eq!(ms, civil_to_unix_ms(2025, 2, 11, 12, 0, 0).unwrap());
    }

    #[test]
    fn ext_lower_normalizes_case() {
        assert_eq!(ext_lower(Path::new("/x/IMG.JPG")), Some("jpg".to_string()));
        assert_eq!(ext_lower(Path::new("/x/file.PNG")), Some("png".to_string()));
        assert_eq!(ext_lower(Path::new("/x/no_ext")), None);
    }
}
