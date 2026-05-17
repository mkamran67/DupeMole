use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Extensions whose container we know how to write a creation date into.
/// Mirrors `media_date::VIDEO_METADATA_EXTS` — same ISO BMFF / QuickTime
/// family the reader supports.
const WRITABLE_VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "qt", "3gp", "3g2"];

/// Outcome of attempting to write a capture-date EXIF tag to an image.
#[derive(Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    /// EXIF tags were written successfully.
    Written,
    /// The file's container format is not one we can write EXIF into
    /// (e.g. RAW, BMP, GIF, AVIF, SVG). The caller should route the file
    /// to the failure-quarantine folder rather than retry.
    UnsupportedFormat,
    /// Write attempt failed for some other reason (I/O, corrupt file, etc).
    Failed(String),
}

/// Write `ms` (Unix milliseconds, UTC) as the EXIF capture-date for the image
/// at `path`. Sets `DateTimeOriginal` (0x9003), `CreateDate` (0x9004, a.k.a.
/// DateTimeDigitized), and `ModifyDate` (0x0132, a.k.a. the IFD0 "DateTime"
/// tag that `media_date::read_image_exif_ms` falls back to). Writing all three
/// matches the convention used by most camera firmware and EXIF tools and
/// guarantees both readers in `media_date.rs` (DateTimeOriginal preferred,
/// DateTime fallback — see media_date.rs:103) will pick up the value.
///
/// The file is rewritten in place. Callers that must preserve the source
/// (e.g. organize-Copy mode) should invoke this on the destination *after*
/// the copy succeeds, never on the source.
pub fn write_image_capture_date_ms(path: &Path, ms: u64) -> WriteOutcome {
    use little_exif::exif_tag::ExifTag;
    use little_exif::metadata::Metadata;

    let datetime = format_exif_datetime(ms);

    if !path.exists() {
        return WriteOutcome::Failed(format!("file not found: {}", path.display()));
    }

    // `new_from_path` returns Unsupported for unwritable container types
    // (BMP, GIF, RAW, …) — surface that distinctly so the caller can route
    // the file to the failure-quarantine folder. Other errors here usually
    // mean "supported container, but no EXIF block yet"; fall through to a
    // fresh `Metadata` so we still embed the date.
    let mut metadata = match Metadata::new_from_path(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
            return WriteOutcome::UnsupportedFormat;
        }
        Err(_) => Metadata::new(),
    };

    metadata.set_tag(ExifTag::DateTimeOriginal(datetime.clone()));
    metadata.set_tag(ExifTag::CreateDate(datetime.clone()));
    metadata.set_tag(ExifTag::ModifyDate(datetime));

    match metadata.write_to_file(path) {
        Ok(()) => WriteOutcome::Written,
        Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
            WriteOutcome::UnsupportedFormat
        }
        Err(e) => WriteOutcome::Failed(e.to_string()),
    }
}

/// Write `ms` (Unix milliseconds, UTC) as the creation_time / modification_time
/// in the ISO BMFF / QuickTime container at `path`. Patches the `mvhd` box
/// inside `moov`, plus every `tkhd` box inside every `trak`. The file is
/// modified in place; no atoms are added or removed and atom sizes are
/// unchanged, so byte offsets in the rest of the file remain valid.
///
/// Supported extensions: mp4, m4v, mov, qt, 3gp, 3g2. Other video extensions
/// (mkv, webm, avi, flv, wmv) use different containers and return
/// `UnsupportedFormat`.
pub fn write_video_capture_date_ms(path: &Path, ms: u64) -> WriteOutcome {
    if !path.exists() {
        return WriteOutcome::Failed(format!("file not found: {}", path.display()));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    let Some(ext) = ext else {
        return WriteOutcome::UnsupportedFormat;
    };
    if !WRITABLE_VIDEO_EXTS.iter().any(|e| *e == ext) {
        return WriteOutcome::UnsupportedFormat;
    }

    // ISO BMFF / QuickTime creation_time is seconds since 1904-01-01 UTC.
    // Negative or far-pre-1904 inputs aren't representable; clamp at 0.
    const MAC_TO_UNIX_SECS: u64 = 2_082_844_800;
    let unix_secs = ms / 1000;
    let secs_1904 = unix_secs.saturating_add(MAC_TO_UNIX_SECS);

    let mut file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(e) => return WriteOutcome::Failed(format!("open: {e}")),
    };
    let total = match file.metadata().map(|m| m.len()) {
        Ok(n) => n,
        Err(e) => return WriteOutcome::Failed(format!("stat: {e}")),
    };

    let moov = match find_atom(&mut file, 0, total, *b"moov") {
        Ok(Some(r)) => r,
        Ok(None) => return WriteOutcome::Failed("moov atom not found".to_string()),
        Err(e) => return WriteOutcome::Failed(format!("read moov: {e}")),
    };

    let mvhd = match find_atom(&mut file, moov.0, moov.1, *b"mvhd") {
        Ok(Some(r)) => r,
        Ok(None) => return WriteOutcome::Failed("mvhd atom not found".to_string()),
        Err(e) => return WriteOutcome::Failed(format!("read mvhd: {e}")),
    };
    if let Err(e) = patch_header_timestamps(&mut file, mvhd.0, secs_1904) {
        return WriteOutcome::Failed(format!("patch mvhd: {e}"));
    }

    // Best-effort: also update each trak/tkhd. A file with no traks is
    // unusual but not an error to write.
    let mut cursor = moov.0;
    while cursor < moov.1 {
        match find_atom(&mut file, cursor, moov.1, *b"trak") {
            Ok(Some(trak)) => {
                if let Ok(Some(tkhd)) = find_atom(&mut file, trak.0, trak.1, *b"tkhd") {
                    if let Err(e) = patch_header_timestamps(&mut file, tkhd.0, secs_1904) {
                        return WriteOutcome::Failed(format!("patch tkhd: {e}"));
                    }
                }
                cursor = trak.1;
            }
            Ok(None) => break,
            Err(e) => return WriteOutcome::Failed(format!("read trak: {e}")),
        }
    }

    if let Err(e) = file.flush() {
        return WriteOutcome::Failed(format!("flush: {e}"));
    }
    WriteOutcome::Written
}

/// Patch the version-prefixed `creation_time` and `modification_time` fields
/// shared by `mvhd` and `tkhd`. Layout (relative to payload start):
///   v0: [u8 version, [u8;3] flags, u32 creation, u32 modification, ...]
///   v1: [u8 version, [u8;3] flags, u64 creation, u64 modification, ...]
fn patch_header_timestamps(
    file: &mut std::fs::File,
    payload_start: u64,
    secs_1904: u64,
) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(payload_start))?;
    let mut ver_flags = [0u8; 4];
    file.read_exact(&mut ver_flags)?;
    match ver_flags[0] {
        0 => {
            let v: u32 = secs_1904.min(u32::MAX as u64) as u32;
            file.seek(SeekFrom::Start(payload_start + 4))?;
            file.write_all(&v.to_be_bytes())?;
            file.write_all(&v.to_be_bytes())?;
        }
        1 => {
            file.seek(SeekFrom::Start(payload_start + 4))?;
            file.write_all(&secs_1904.to_be_bytes())?;
            file.write_all(&secs_1904.to_be_bytes())?;
        }
        v => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown header version: {v}"),
            ));
        }
    }
    Ok(())
}

/// Walk box children in `[start, end)` looking for `tag`. Returns the
/// (payload_start, payload_end) range for the first match, or `Ok(None)`
/// if no such atom exists in that range.
fn find_atom(
    file: &mut std::fs::File,
    start: u64,
    end: u64,
    tag: [u8; 4],
) -> std::io::Result<Option<(u64, u64)>> {
    let mut pos = start;
    file.seek(SeekFrom::Start(pos))?;
    while pos + 8 <= end {
        let mut header = [0u8; 8];
        file.read_exact(&mut header)?;
        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let atom_type = [header[4], header[5], header[6], header[7]];
        let (payload_start, atom_end) = match size {
            0 => (pos + 8, end),
            1 => {
                let mut ext = [0u8; 8];
                file.read_exact(&mut ext)?;
                let ext_size = u64::from_be_bytes(ext);
                if ext_size < 16 {
                    return Ok(None);
                }
                (pos + 16, pos + ext_size)
            }
            n if n >= 8 => (pos + 8, pos + n),
            _ => return Ok(None),
        };
        if atom_type == tag {
            return Ok(Some((payload_start, atom_end)));
        }
        if atom_end <= pos {
            return Ok(None);
        }
        pos = atom_end;
        file.seek(SeekFrom::Start(pos))?;
    }
    Ok(None)
}

/// Format a Unix-ms timestamp as the EXIF "YYYY:MM:DD HH:MM:SS" string
/// required by tags 0x0132 / 0x9003 / 0x9004 (all 20 bytes including NUL).
fn format_exif_datetime(ms: u64) -> String {
    let (y, mo, d) = crate::organize::unix_ms_to_civil(ms);
    let secs = ms / 1000;
    let day_secs = (secs % 86_400) as u32;
    let h = day_secs / 3600;
    let mi = (day_secs % 3600) / 60;
    let s = day_secs % 60;
    format!("{:04}:{:02}:{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write_blank_jpeg(path: &Path) {
        use image::RgbImage;
        let img = RgbImage::new(2, 2);
        img.save(path).expect("write test jpeg");
    }

    fn read_back_capture_ms(path: &Path) -> Option<u64> {
        // Use the same reader the rest of the app uses, so we exercise the
        // round-trip exactly as Organize will see it.
        crate::media_date::read_metadata_ms(path)
    }

    fn fresh_path(tmp: &tempfile::TempDir, name: &str) -> PathBuf {
        tmp.path().join(name)
    }

    #[test]
    fn format_exif_datetime_known_timestamp() {
        // 2024-03-15 12:00:00 UTC = 1_710_504_000_000 ms
        assert_eq!(format_exif_datetime(1_710_504_000_000), "2024:03:15 12:00:00");
    }

    #[test]
    fn format_exif_datetime_epoch() {
        assert_eq!(format_exif_datetime(0), "1970:01:01 00:00:00");
    }

    #[test]
    fn format_exif_datetime_with_time_of_day() {
        // 2024-03-15 12:00:00 UTC = 1_710_504_000_000 (from media_date.rs tests)
        // → 2024-03-15 00:00:00 = that minus 12h.
        let start_of_day = 1_710_504_000_000u64 - 12 * 3600 * 1000;
        // + 23:59:59
        let ms = start_of_day + (23 * 3600 + 59 * 60 + 59) * 1000;
        assert_eq!(format_exif_datetime(ms), "2024:03:15 23:59:59");
    }

    #[test]
    fn write_jpeg_happy_path_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "blank.jpg");
        write_blank_jpeg(&path);
        // 2025-02-11 12:00:00 UTC
        let ms = 1_739_275_200_000u64;
        assert_eq!(write_image_capture_date_ms(&path, ms), WriteOutcome::Written);
        let read = read_back_capture_ms(&path).expect("EXIF should now be present");
        assert_eq!(read, ms);
    }

    #[test]
    fn write_jpeg_epoch_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "epoch.jpg");
        write_blank_jpeg(&path);
        assert_eq!(write_image_capture_date_ms(&path, 0), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(0));
    }

    #[test]
    fn write_jpeg_far_future_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "future.jpg");
        write_blank_jpeg(&path);
        // 2099-12-31 23:59:59 UTC
        // Days from 1970-01-01 to 2099-12-31 = 47_481, plus leap accounting.
        // Easier: just write a value, then verify via a freshly-formatted
        // string we know parses correctly.
        let target_ms = 4_102_444_799_000u64; // 2099-12-31 23:59:59 UTC
        assert_eq!(format_exif_datetime(target_ms), "2099:12:31 23:59:59");
        assert_eq!(
            write_image_capture_date_ms(&path, target_ms),
            WriteOutcome::Written
        );
        assert_eq!(read_back_capture_ms(&path), Some(target_ms));
    }

    #[test]
    fn write_nonexistent_path_returns_failed() {
        let path = Path::new("/nonexistent/dir/does_not_exist.jpg");
        match write_image_capture_date_ms(path, 0) {
            WriteOutcome::Failed(_) => {}
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[test]
    fn write_unsupported_extension_returns_unsupported() {
        // .bmp is not in little_exif's writable set
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "x.bmp");
        // Write a minimal valid BMP via the image crate so the file exists
        // but the extension routes through get_file_type.
        use image::RgbImage;
        let img = RgbImage::new(2, 2);
        img.save(&path).expect("write test bmp");
        assert_eq!(
            write_image_capture_date_ms(&path, 0),
            WriteOutcome::UnsupportedFormat
        );
    }

    #[test]
    fn write_overwrites_existing_datetime_original() {
        // Documents behavior: caller is responsible for the
        // "only write if metadata absent" gate; this fn unconditionally
        // overwrites.
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "twice.jpg");
        write_blank_jpeg(&path);
        let first_ms = 1_710_504_000_000u64;
        let second_ms = 1_739_275_200_000u64;
        assert_eq!(write_image_capture_date_ms(&path, first_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(first_ms));
        assert_eq!(write_image_capture_date_ms(&path, second_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(second_ms));
    }

    fn write_minimal_mp4(path: &Path, creation_secs_1904: u32) {
        let bytes = crate::media_date::tests::build_minimal_mp4_v0(creation_secs_1904);
        std::fs::write(path, bytes).expect("write test mp4");
    }

    /// Build a v1 (64-bit timestamps) mvhd inside moov, with an arbitrary
    /// initial creation value. Used to confirm the writer also patches v1.
    fn write_minimal_mp4_v1(path: &Path, creation_secs_1904: u64) {
        // v1 mvhd payload = 4 + 8 + 8 + 4 + 8 + 4 + 2 + 10 + 36 + 24 + 4 = 112
        let mut mvhd_payload = Vec::new();
        mvhd_payload.push(1); // version=1
        mvhd_payload.extend_from_slice(&[0u8; 3]); // flags
        mvhd_payload.extend_from_slice(&creation_secs_1904.to_be_bytes());
        mvhd_payload.extend_from_slice(&0u64.to_be_bytes()); // modification
        mvhd_payload.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd_payload.extend_from_slice(&0u64.to_be_bytes()); // duration
        mvhd_payload.extend_from_slice(&[0u8; 4]); // rate
        mvhd_payload.extend_from_slice(&[0u8; 2]); // volume
        mvhd_payload.extend_from_slice(&[0u8; 10]); // reserved
        mvhd_payload.extend_from_slice(&[0u8; 36]); // matrix
        mvhd_payload.extend_from_slice(&[0u8; 24]); // pre_defined
        mvhd_payload.extend_from_slice(&[0u8; 4]); // next_track_id

        let mut mvhd_box = Vec::new();
        let mvhd_size = (8 + mvhd_payload.len()) as u32;
        mvhd_box.extend_from_slice(&mvhd_size.to_be_bytes());
        mvhd_box.extend_from_slice(b"mvhd");
        mvhd_box.extend_from_slice(&mvhd_payload);

        let mut moov_box = Vec::new();
        let moov_size = (8 + mvhd_box.len()) as u32;
        moov_box.extend_from_slice(&moov_size.to_be_bytes());
        moov_box.extend_from_slice(b"moov");
        moov_box.extend_from_slice(&mvhd_box);

        std::fs::write(path, moov_box).expect("write test v1 mp4");
    }

    #[test]
    fn write_mp4_v0_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "clip.mp4");
        write_minimal_mp4(&path, 0); // initial creation = epoch-1904
        let target_ms = 1_739_275_200_000u64; // 2025-02-11 12:00:00 UTC
        assert_eq!(write_video_capture_date_ms(&path, target_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(target_ms));
    }

    #[test]
    fn write_mov_v0_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "clip.mov");
        write_minimal_mp4(&path, 0);
        let target_ms = 1_710_504_000_000u64;
        assert_eq!(write_video_capture_date_ms(&path, target_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(target_ms));
    }

    #[test]
    fn write_qt_v0_roundtrips() {
        // QuickTime .qt files share the same container as .mov.
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "clip.qt");
        write_minimal_mp4(&path, 0);
        let target_ms = 1_710_504_000_000u64;
        assert_eq!(write_video_capture_date_ms(&path, target_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(target_ms));
    }

    #[test]
    fn write_mp4_v1_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "v1.mp4");
        write_minimal_mp4_v1(&path, 0);
        let target_ms = 1_710_504_000_000u64;
        assert_eq!(write_video_capture_date_ms(&path, target_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(target_ms));
    }

    #[test]
    fn write_mp4_overwrites_existing_creation() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "twice.mp4");
        // Pre-seed with some non-zero creation_time to confirm we replace it.
        write_minimal_mp4(&path, 1_000_000_000);
        let first_ms = 1_710_504_000_000u64;
        let second_ms = 1_739_275_200_000u64;
        assert_eq!(write_video_capture_date_ms(&path, first_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(first_ms));
        assert_eq!(write_video_capture_date_ms(&path, second_ms), WriteOutcome::Written);
        assert_eq!(read_back_capture_ms(&path), Some(second_ms));
    }

    #[test]
    fn write_video_nonexistent_returns_failed() {
        let path = Path::new("/nonexistent/dir/x.mp4");
        match write_video_capture_date_ms(path, 0) {
            WriteOutcome::Failed(_) => {}
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[test]
    fn write_video_unsupported_ext_returns_unsupported() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "clip.mkv");
        std::fs::write(&path, b"not really an mkv").unwrap();
        assert_eq!(
            write_video_capture_date_ms(&path, 0),
            WriteOutcome::UnsupportedFormat
        );
    }

    #[test]
    fn write_video_no_moov_returns_failed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = fresh_path(&tmp, "broken.mp4");
        // 16 bytes of a single non-moov atom: ftyp-like garbage.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&16u32.to_be_bytes());
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(&[0u8; 8]);
        std::fs::write(&path, bytes).unwrap();
        match write_video_capture_date_ms(&path, 0) {
            WriteOutcome::Failed(_) => {}
            other => panic!("expected Failed for no-moov, got {:?}", other),
        }
    }
}
