use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "tif", "tiff", "heic", "heif", "webp", "dng", "cr2", "cr3", "nef", "arw",
    "rw2", "orf", "raf",
];
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "3gp", "3g2"];

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
