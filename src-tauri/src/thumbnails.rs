use std::fs::{self, File};
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageReader};
use tauri::{AppHandle, Manager};

const SUPPORTED_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff",
];

const JPEG_QUALITY: u8 = 80;

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

fn mtime_ms(path: &Path) -> Result<u64, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    let dur = modified.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
    Ok(dur.as_millis() as u64)
}

fn cache_key(path: &Path, mtime_ms: u64, size: u64, edge: u32) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(&mtime_ms.to_le_bytes());
    hasher.update(&size.to_le_bytes());
    hasher.update(&edge.to_le_bytes());
    let hex = hasher.finalize().to_hex();
    hex.as_str()[..32].to_string()
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbnails");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Read EXIF Orientation tag (1..=8) for JPEG/TIFF/HEIC-like containers.
fn read_orientation(path: &Path) -> Option<u32> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;
    let field = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?;
    field.value.get_uint(0)
}

fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn fit_within(w: u32, h: u32, edge: u32) -> (u32, u32) {
    if w <= edge && h <= edge {
        return (w.max(1), h.max(1));
    }
    let scale = (edge as f64 / w as f64).min(edge as f64 / h as f64);
    let nw = ((w as f64) * scale).round().max(1.0) as u32;
    let nh = ((h as f64) * scale).round().max(1.0) as u32;
    (nw, nh)
}

fn generate(src: &Path, dst: &Path, edge: u32) -> Result<(), String> {
    let img = ImageReader::open(src)
        .map_err(|e| format!("open: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("format: {e}"))?
        .decode()
        .map_err(|e| format!("decode: {e}"))?;

    let img = if let Some(o) = read_orientation(src) {
        apply_orientation(img, o)
    } else {
        img
    };

    let (w, h) = (img.width(), img.height());
    let (tw, th) = fit_within(w, h, edge);
    let resized = if (tw, th) == (w, h) {
        img
    } else {
        img.resize_exact(tw, th, image::imageops::FilterType::Triangle)
    };

    // JPEG doesn't carry alpha; flatten to RGB8.
    let rgb = resized.to_rgb8();

    let mut buf: Vec<u8> = Vec::with_capacity((tw * th) as usize);
    {
        let mut cursor = Cursor::new(&mut buf);
        let mut enc = JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY);
        enc.encode_image(&rgb).map_err(|e| format!("encode: {e}"))?;
    }

    // Atomic write: write to .tmp then rename.
    let tmp = dst.with_extension("jpg.tmp");
    fs::write(&tmp, &buf).map_err(|e| format!("write: {e}"))?;
    fs::rename(&tmp, dst).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

fn read_as_data_url(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
    if bytes.is_empty() {
        return Err("empty thumbnail".into());
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

#[tauri::command]
pub async fn get_thumbnail(path: String, edge: u32, app: AppHandle) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let ext = ext_lower(&src).ok_or_else(|| "no extension".to_string())?;
    if !SUPPORTED_EXTS.iter().any(|e| *e == ext) {
        return Err(format!("unsupported extension: {ext}"));
    }
    let edge = edge.clamp(32, 1024);

    let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
    let size = meta.len();
    let mtime = mtime_ms(&src)?;

    let dir = cache_dir(&app)?;
    let key = cache_key(&src, mtime, size, edge);
    let dst = dir.join(format!("{key}.jpg"));

    if dst.exists() {
        return read_as_data_url(&dst);
    }

    let dst_for_thread = dst.clone();
    tauri::async_runtime::spawn_blocking(move || generate(&src, &dst_for_thread, edge))
        .await
        .map_err(|e| format!("join: {e}"))??;

    read_as_data_url(&dst)
}
