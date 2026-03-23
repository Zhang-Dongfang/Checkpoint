use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use walkdir::WalkDir;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SaveInfo {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub time: i64,
    pub delta: String,
    pub cloud: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiffFile {
    pub file_type: String, // "add" | "mod" | "del"
    pub file: String,
    pub add: i32,
    pub rem: i32,
}

/// A tree maps relative file paths to their SHA-256 content hashes.
type Tree = HashMap<String, String>;

// ── Ignore rules ───────────────────────────────────────────────────────────

const IGNORE_DIRS: &[&str] = &[
    ".savepoint",
    ".git", ".svn", ".hg",
    "node_modules", ".pnp",
    "target",
    "dist", "build", "out", ".output",
    ".next", ".nuxt", ".svelte-kit",
    "__pycache__", ".venv", "venv", "env",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".gradle", "vendor",
    "coverage", ".nyc_output",
    ".idea", ".vs",
    "Pods",
];

const IGNORE_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024; // skip files > 10 MB

fn is_ignored(e: &walkdir::DirEntry) -> bool {
    let name = match e.file_name().to_str() {
        Some(n) => n,
        None => return true,
    };
    if e.file_type().is_dir() {
        return IGNORE_DIRS.contains(&name) || name.starts_with('.');
    }
    if IGNORE_FILES.contains(&name) {
        return true;
    }
    e.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false)
}

// ── Content-addressable object store ───────────────────────────────────────

fn sha256(content: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(content);
    format!("{:x}", h.finalize())
}

/// Write an object if it doesn't already exist. Returns its hash.
fn store_object(objects: &Path, content: &[u8]) -> io::Result<String> {
    let hash = sha256(content);
    let obj_path = object_path(objects, &hash);
    if !obj_path.exists() {
        fs::create_dir_all(obj_path.parent().unwrap())?;
        fs::write(&obj_path, content)?;
    }
    Ok(hash)
}

fn read_object(objects: &Path, hash: &str) -> io::Result<Vec<u8>> {
    fs::read(object_path(objects, hash))
}

fn object_path(objects: &Path, hash: &str) -> PathBuf {
    // Split like git: first 2 chars as directory, rest as filename
    objects.join(&hash[..2]).join(&hash[2..])
}

// ── Path helpers ───────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn savepoint_root(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".savepoint")
}

fn objects_dir(project_path: &str) -> PathBuf {
    savepoint_root(project_path).join("objects")
}

fn project_dir(project_path: &str) -> PathBuf {
    savepoint_root(project_path)
}

fn index_path(proj_dir: &Path) -> PathBuf {
    proj_dir.join("index.json")
}

fn tree_path(proj_dir: &Path, save_id: &str) -> PathBuf {
    proj_dir.join("trees").join(format!("{}.json", save_id))
}

// ── Index (save list) ──────────────────────────────────────────────────────

fn read_index(proj_dir: &Path) -> Vec<SaveInfo> {
    let p = index_path(proj_dir);
    if !p.exists() {
        return vec![];
    }
    serde_json::from_str(&fs::read_to_string(p).unwrap_or_default()).unwrap_or_default()
}

fn write_index(proj_dir: &Path, saves: &[SaveInfo]) -> io::Result<()> {
    fs::create_dir_all(proj_dir)?;
    fs::write(index_path(proj_dir), serde_json::to_string_pretty(saves).unwrap())
}

// ── Tree operations ────────────────────────────────────────────────────────

fn read_tree(proj_dir: &Path, save_id: &str) -> Tree {
    let p = tree_path(proj_dir, save_id);
    if !p.exists() {
        return Tree::new();
    }
    serde_json::from_str(&fs::read_to_string(p).unwrap_or_default()).unwrap_or_default()
}

fn write_tree(proj_dir: &Path, save_id: &str, tree: &Tree) -> io::Result<()> {
    let p = tree_path(proj_dir, save_id);
    fs::create_dir_all(p.parent().unwrap())?;
    fs::write(p, serde_json::to_string(tree).unwrap())
}

/// Walk the project and store every file in the object store.
/// Returns a Tree (path → hash).
fn snapshot_project(project_path: &str, objects: &Path) -> io::Result<Tree> {
    let root = Path::new(project_path);
    let mut tree = Tree::new();

    let walker = WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_ignored(e));

    for entry in walker {
        let entry = entry.map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        let key = rel.to_string_lossy().replace('\\', "/");

        let content = fs::read(entry.path())?;
        let hash = store_object(objects, &content)?;
        tree.insert(key, hash);
    }

    Ok(tree)
}

/// Restore project files from a tree + object store.
fn restore_tree(tree: &Tree, objects: &Path, project_path: &str) -> io::Result<()> {
    let root = Path::new(project_path);
    for (rel, hash) in tree {
        let content = read_object(objects, hash)?;
        let dest = root.join(rel);
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p)?;
        }
        fs::write(dest, content)?;
    }
    Ok(())
}

// ── Diff ───────────────────────────────────────────────────────────────────

fn count_lines(content: &[u8]) -> i32 {
    if content.contains(&0u8) {
        return 1; // treat binary as 1 "line"
    }
    content.iter().filter(|&&b| b == b'\n').count() as i32 + 1
}

fn diff_trees(old: &Tree, new: &Tree, objects: &Path) -> Vec<DiffFile> {
    let mut result = Vec::new();

    for (rel, new_hash) in new {
        match old.get(rel) {
            None => {
                // Added
                let lines = read_object(objects, new_hash).map(|c| count_lines(&c)).unwrap_or(0);
                result.push(DiffFile { file_type: "add".into(), file: rel.clone(), add: lines, rem: 0 });
            }
            Some(old_hash) if old_hash != new_hash => {
                // Modified
                let new_lines = read_object(objects, new_hash).map(|c| count_lines(&c)).unwrap_or(0);
                let old_lines = read_object(objects, old_hash).map(|c| count_lines(&c)).unwrap_or(0);
                result.push(DiffFile {
                    file_type: "mod".into(),
                    file: rel.clone(),
                    add: (new_lines - old_lines).max(0),
                    rem: (old_lines - new_lines).max(0),
                });
            }
            _ => {} // unchanged — same hash, skip
        }
    }

    for rel in old.keys() {
        if !new.contains_key(rel) {
            // Deleted
            let old_hash = old.get(rel).unwrap();
            let lines = read_object(objects, old_hash).map(|c| count_lines(&c)).unwrap_or(0);
            result.push(DiffFile { file_type: "del".into(), file: rel.clone(), add: 0, rem: lines });
        }
    }

    result.sort_by(|a, b| {
        let ord = |t: &str| match t { "add" => 0, "mod" => 1, _ => 2 };
        ord(&a.file_type).cmp(&ord(&b.file_type)).then(a.file.cmp(&b.file))
    });
    result
}

fn delta_summary(diffs: &[DiffFile]) -> String {
    let add: i32 = diffs.iter().map(|d| d.add).sum();
    let rem: i32 = diffs.iter().map(|d| d.rem).sum();
    let n = diffs.len();
    if n == 0 {
        return "无变更".into();
    }
    match (add, rem) {
        (a, 0) => format!("+{} 行 ({} 文件)", a, n),
        (0, r) => format!("-{} 行 ({} 文件)", r, n),
        (a, r) => format!("+{} -{} ({} 文件)", a, r, n),
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_saves(project_path: String) -> Result<Vec<SaveInfo>, String> {
    let dir = project_dir(&project_path);
    Ok(read_index(&dir))
}

#[tauri::command]
pub fn create_save(
    project_path: String,
    name: String,
    desc: String,
) -> Result<String, String> {
    let objects = objects_dir(&project_path);
    let proj_dir = project_dir(&project_path);

    // Snapshot current project state into object store
    let new_tree = snapshot_project(&project_path, &objects)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    // Load previous tree for delta comparison
    let existing = read_index(&proj_dir);
    let old_tree = existing
        .first()
        .map(|s| read_tree(&proj_dir, &s.id))
        .unwrap_or_default();

    let diffs = diff_trees(&old_tree, &new_tree, &objects);
    let delta = delta_summary(&diffs);

    let id = now_ms().to_string();

    // Persist tree and update index
    write_tree(&proj_dir, &id, &new_tree)
        .map_err(|e| format!("写入存档失败: {}", e))?;

    let info = SaveInfo {
        id: id.clone(),
        name: name.trim().to_string(),
        desc: desc.trim().to_string(),
        time: now_ms(),
        delta,
        cloud: false,
    };

    let mut all = existing;
    all.insert(0, info);
    write_index(&proj_dir, &all).map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn get_diff(
    project_path: String,
    save_id: String,
) -> Result<Vec<DiffFile>, String> {
    let objects = objects_dir(&project_path);
    let proj_dir = project_dir(&project_path);
    let saves = read_index(&proj_dir);

    let pos = saves.iter().position(|s| s.id == save_id).ok_or("存档未找到")?;

    let new_tree = read_tree(&proj_dir, &save_id);
    // saves are newest-first, so the previous save is at pos+1
    let old_tree = saves
        .get(pos + 1)
        .map(|s| read_tree(&proj_dir, &s.id))
        .unwrap_or_default();

    Ok(diff_trees(&old_tree, &new_tree, &objects))
}

#[tauri::command]
pub fn rollback_to(
    project_path: String,
    save_id: String,
) -> Result<(), String> {
    let objects = objects_dir(&project_path);
    let proj_dir = project_dir(&project_path);
    let tree = read_tree(&proj_dir, &save_id);

    if tree.is_empty() {
        return Err("存档不存在或已损坏".into());
    }

    restore_tree(&tree, &objects, &project_path)
        .map_err(|e| format!("恢复文件失败: {}", e))
}
