//! Parse directory paths passed on the command line so the desktop app can
//! preload them, mirroring `code .` / `cursor .` ergonomics.
//!
//! Rules:
//! - Skip argv[0] (the binary path).
//! - Stop interpreting once we hit `--`; everything before that wins.
//! - Drop any arg starting with `-` (flag-like).
//! - Resolve relative paths against `cwd`.
//! - Drop anything that isn't an existing directory — we don't want to seed
//!   a scan with a file or a typo.
//! - Canonicalize to avoid surprises from symlinks / `..` segments.

use std::path::{Path, PathBuf};

pub fn parse_paths<I, S>(argv: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    let mut iter = argv.into_iter();
    let _bin = iter.next();

    for raw in iter {
        let s = raw.as_ref();
        if s == "--" {
            break;
        }
        if s.starts_with('-') {
            continue;
        }
        let candidate = if Path::new(s).is_absolute() {
            PathBuf::from(s)
        } else {
            cwd.join(s)
        };
        let canon = match candidate.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if canon.is_dir() && !out.contains(&canon) {
            out.push(canon);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn tempdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!("dupemole-cli-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        base.canonicalize().unwrap()
    }

    #[test]
    fn empty_argv_returns_empty() {
        let cwd = std::env::current_dir().unwrap();
        let out = parse_paths::<_, &str>(std::iter::empty(), &cwd);
        assert!(out.is_empty());
    }

    #[test]
    fn skips_binary_path() {
        let cwd = tempdir();
        let out = parse_paths(vec!["dupemole"], &cwd);
        assert!(out.is_empty());
    }

    #[test]
    fn resolves_relative_dot_to_cwd() {
        let cwd = tempdir();
        let out = parse_paths(vec!["dupemole", "."], &cwd);
        assert_eq!(out, vec![cwd]);
    }

    #[test]
    fn keeps_existing_absolute_dir() {
        let abs = tempdir();
        let out = parse_paths(vec!["dupemole", abs.to_str().unwrap()], Path::new("/"));
        assert_eq!(out, vec![abs]);
    }

    #[test]
    fn drops_nonexistent_path() {
        let cwd = tempdir();
        let bogus = cwd.join("does-not-exist");
        let out = parse_paths(vec!["dupemole", bogus.to_str().unwrap()], &cwd);
        assert!(out.is_empty(), "got {:?}", out);
    }

    #[test]
    fn drops_path_to_file_not_directory() {
        let cwd = tempdir();
        let file = cwd.join("a.txt");
        fs::write(&file, b"hi").unwrap();
        let out = parse_paths(vec!["dupemole", file.to_str().unwrap()], &cwd);
        assert!(out.is_empty());
    }

    #[test]
    fn drops_flag_like_args() {
        let cwd = tempdir();
        let out = parse_paths(vec!["dupemole", "--verbose", "-x", "."], &cwd);
        assert_eq!(out, vec![cwd]);
    }

    #[test]
    fn double_dash_stops_path_collection() {
        let cwd = tempdir();
        let sub = cwd.join("sub");
        fs::create_dir(&sub).unwrap();
        let out = parse_paths(
            vec!["dupemole", "--", sub.to_str().unwrap()],
            &cwd,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn deduplicates_repeated_paths() {
        let cwd = tempdir();
        let out = parse_paths(vec!["dupemole", ".", "."], &cwd);
        assert_eq!(out, vec![cwd]);
    }

    #[test]
    fn accepts_multiple_distinct_directories() {
        let cwd = tempdir();
        let a = cwd.join("a");
        let b = cwd.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        let out = parse_paths(
            vec!["dupemole", a.to_str().unwrap(), b.to_str().unwrap()],
            &cwd,
        );
        assert_eq!(out, vec![a, b]);
    }
}
