use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use git2::{IndexAddOption, Repository, Signature, Sort};

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SaveInfo {
    pub id: String, // full commit SHA
    pub name: String,
    pub desc: String,
    pub time: i64, // Unix ms
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

// ── Ignore rules ────────────────────────────────────────────────────────────

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
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

fn is_ignored(name: &str, is_dir: bool) -> bool {
    if is_dir {
        IGNORE_DIRS.contains(&name) || name.starts_with('.')
    } else {
        IGNORE_FILES.contains(&name)
    }
}

// ── Paths & repo helpers ────────────────────────────────────────────────────

fn shadow_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".savepoint").join("repo")
}

fn open_or_init_shadow(project_path: &str) -> Result<Repository, String> {
    let path = shadow_path(project_path);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Repository::init(&path).map_err(|e| e.to_string())
}

fn open_shadow(project_path: &str) -> Result<Repository, String> {
    Repository::open(shadow_path(project_path))
        .map_err(|_| "还没有存档，请先创建一个".to_string())
}

fn sig() -> Result<Signature<'static>, String> {
    Signature::now("SavePoint", "savepoint@local").map_err(|e| e.to_string())
}

// ── Commit message encoding ─────────────────────────────────────────────────
//
// Format:
//   {name}
//
//   {desc}          ← optional
//
//   Savepoint-Delta: {delta}

fn encode_msg(name: &str, desc: &str, delta: &str) -> String {
    let mut s = name.to_string();
    if !desc.is_empty() {
        s.push_str("\n\n");
        s.push_str(desc);
    }
    s.push_str(&format!("\n\nSavepoint-Delta: {}", delta));
    s
}

fn decode_msg(msg: &str) -> (String, String, String) {
    let mut lines = msg.lines();
    let name = lines.next().unwrap_or("").trim().to_string();
    let rest: Vec<&str> = lines.collect();

    let delta = rest
        .iter()
        .rev()
        .find_map(|l| l.strip_prefix("Savepoint-Delta: "))
        .unwrap_or("无变更")
        .to_string();

    let desc = rest
        .iter()
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.starts_with("Savepoint-"))
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    (name, desc, delta)
}

// ── File sync ───────────────────────────────────────────────────────────────

/// Copy project → shadow workdir (clears shadow first).
fn sync_to_shadow(project_path: &str, shadow_root: &Path, blocked: &HashSet<String>) -> io::Result<()> {
    // Clear shadow workdir, preserve .git/
    for entry in fs::read_dir(shadow_root)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    copy_filtered(Path::new(project_path), shadow_root, blocked, "")
}

fn copy_filtered(src: &Path, dst: &Path, blocked: &HashSet<String>, rel_prefix: &str) -> io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;
        let rel = if rel_prefix.is_empty() {
            name_str.to_string()
        } else {
            format!("{}/{}", rel_prefix, name_str)
        };
        if ft.is_dir() {
            if is_ignored(&name_str, true) {
                continue;
            }
            if blocked.contains(&rel) {
                continue;
            }
            let sub = dst.join(&name);
            fs::create_dir_all(&sub)?;
            copy_filtered(&entry.path(), &sub, blocked, &rel)?;
        } else if ft.is_file() {
            if is_ignored(&name_str, false) {
                continue;
            }
            if blocked.contains(&rel) {
                continue;
            }
            if entry.metadata()?.len() > MAX_FILE_BYTES {
                continue;
            }
            fs::copy(entry.path(), dst.join(&name))?;
        }
    }
    Ok(())
}

/// Restore project from shadow workdir (precise: also deletes extra files).
fn sync_to_project(shadow_root: &Path, project_path: &str) -> io::Result<()> {
    let project = Path::new(project_path);
    let shadow_files = all_files(shadow_root)?;
    let project_files = non_ignored_files(project)?;

    // Delete project files absent from the snapshot
    for rel in project_files.difference(&shadow_files) {
        let _ = fs::remove_file(project.join(rel));
    }

    // Write snapshot files into project
    for rel in &shadow_files {
        let dst = project.join(rel);
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p)?;
        }
        fs::copy(shadow_root.join(rel), &dst)?;
    }
    Ok(())
}

fn all_files(root: &Path) -> io::Result<HashSet<PathBuf>> {
    fn walk(dir: &Path, base: &Path, out: &mut HashSet<PathBuf>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name() == ".git" {
                continue;
            }
            let ft = entry.file_type()?;
            if ft.is_dir() {
                walk(&entry.path(), base, out)?;
            } else if ft.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(base) {
                    out.insert(rel.to_path_buf());
                }
            }
        }
        Ok(())
    }
    let mut out = HashSet::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

fn non_ignored_files(root: &Path) -> io::Result<HashSet<PathBuf>> {
    fn walk(dir: &Path, base: &Path, out: &mut HashSet<PathBuf>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let ft = entry.file_type()?;
            if ft.is_dir() {
                if is_ignored(&name_str, true) {
                    continue;
                }
                walk(&entry.path(), base, out)?;
            } else if ft.is_file() {
                if is_ignored(&name_str, false) {
                    continue;
                }
                if let Ok(rel) = entry.path().strip_prefix(base) {
                    out.insert(rel.to_path_buf());
                }
            }
        }
        Ok(())
    }
    let mut out = HashSet::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

// ── Delta summary ────────────────────────────────────────────────────────────

fn delta_summary(diff: &git2::Diff) -> Result<String, String> {
    let stats = diff.stats().map_err(|e| e.to_string())?;
    let files = stats.files_changed();
    let add = stats.insertions();
    let del = stats.deletions();
    if files == 0 {
        return Ok("无变更".into());
    }
    Ok(match (add, del) {
        (a, 0) => format!("+{} 行 ({} 文件)", a, files),
        (0, d) => format!("-{} 行 ({} 文件)", d, files),
        (a, d) => format!("+{} -{} ({} 文件)", a, d, files),
    })
}

// ── Auto-save (amend if HEAD is an auto-save commit) ─────────────────────────

/// Like `create_save`, but always writes a commit named "自动存档".
/// If the current HEAD is already an auto-save commit it is amended in-place
/// (i.e. replaced with the same parents), so the save list stays at one entry.
#[tauri::command]
pub fn auto_save(project_path: String, blocked_files: Vec<String>) -> Result<String, String> {
    let blocked: HashSet<String> = blocked_files.into_iter().collect();
    let repo = open_or_init_shadow(&project_path)?;
    let shadow_root = shadow_path(&project_path);

    sync_to_shadow(&project_path, &shadow_root, &blocked)
        .map_err(|e| format!("同步文件失败: {}", e))?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.clear().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;

    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    let is_auto = head_commit
        .as_ref()
        .map_or(false, |c| c.message().unwrap_or("").starts_with("自动存档"));

    // Delta: compare against what existed before the auto-save slot
    let base_tree = if is_auto {
        head_commit.as_ref()
            .and_then(|c| c.parent(0).ok())
            .and_then(|p| p.tree().ok())
    } else {
        head_commit.as_ref().and_then(|c| c.tree().ok())
    };

    let diff = repo
        .diff_tree_to_tree(base_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;
    let delta = delta_summary(&diff)?;

    let msg = encode_msg("自动存档", "", &delta);
    let sig = sig()?;

    // Collect parent OIDs first (avoids borrow/move conflicts with head_commit)
    let parent_oids: Vec<git2::Oid> = if is_auto {
        // Amend: reuse head's own parents so the auto-save slot stays in place
        head_commit.as_ref()
            .map(|c| c.parent_ids().collect())
            .unwrap_or_default()
    } else {
        // Normal append: current head becomes the parent
        head_commit.as_ref()
            .map(|c| vec![c.id()])
            .unwrap_or_default()
    };
    let parents: Vec<git2::Commit> = parent_oids
        .iter()
        .filter_map(|oid| repo.find_commit(*oid).ok())
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parent_refs)
        .map_err(|e| e.to_string())?;

    Ok(oid.to_string())
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_saves(project_path: String) -> Result<Vec<SaveInfo>, String> {
    let repo = match Repository::open(shadow_path(&project_path)) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };

    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]),
    };
    let head_oid = match head.target() {
        Some(o) => o,
        None => return Ok(vec![]),
    };

    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;

    let mut saves = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let msg = commit.message().unwrap_or("").to_string();
        let (name, desc, delta) = decode_msg(&msg);
        saves.push(SaveInfo {
            id: oid.to_string(),
            name,
            desc,
            time: commit.time().seconds() * 1000,
            delta,
            cloud: false,
        });
    }

    Ok(saves)
}

#[tauri::command]
pub fn create_save(
    project_path: String,
    name: String,
    desc: String,
    blocked_files: Vec<String>,
) -> Result<String, String> {
    let blocked: HashSet<String> = blocked_files.into_iter().collect();
    let repo = open_or_init_shadow(&project_path)?;
    let shadow_root = shadow_path(&project_path);

    sync_to_shadow(&project_path, &shadow_root, &blocked)
        .map_err(|e| format!("同步文件失败: {}", e))?;

    // Stage everything (clear index first to handle deletions)
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.clear().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;

    // Resolve parent commit (None if first save)
    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parent_tree = parent_commit.as_ref().and_then(|c| c.tree().ok());

    // Compute delta before building the commit message
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;
    let delta = delta_summary(&diff)?;

    let name = {
        let n = name.trim();
        if n.is_empty() { "手动存档" } else { n }
    };
    let msg = encode_msg(name, desc.trim(), &delta);
    let sig = sig()?;

    let parents: Vec<git2::Commit> = parent_commit.into_iter().collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parent_refs)
        .map_err(|e| e.to_string())?;

    Ok(oid.to_string())
}

#[tauri::command]
pub fn get_diff(project_path: String, save_id: String) -> Result<Vec<DiffFile>, String> {
    let repo = open_shadow(&project_path)?;

    let oid = git2::Oid::from_str(&save_id).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;

    // Collect per-file +/- line counts via line callback.
    // RefCell lets both closures share the map without fighting the borrow checker.
    let file_stats: std::cell::RefCell<std::collections::HashMap<String, (String, i32, i32)>> =
        std::cell::RefCell::new(std::collections::HashMap::new());

    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let kind = match delta.status() {
                git2::Delta::Added => "add",
                git2::Delta::Deleted => "del",
                _ => "mod",
            };
            file_stats.borrow_mut().entry(path).or_insert((kind.to_string(), 0, 0));
            true
        },
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let mut map = file_stats.borrow_mut();
            if let Some(entry) = map.get_mut(&path) {
                match line.origin() {
                    '+' => entry.1 += 1,
                    '-' => entry.2 += 1,
                    _ => {}
                }
            }
            true
        }),
    )
    .map_err(|e| e.to_string())?;

    let mut result: Vec<DiffFile> = file_stats
        .into_inner()
        .into_iter()
        .map(|(file, (file_type, add, rem))| DiffFile { file_type, file, add, rem })
        .collect();

    result.sort_by(|a, b| {
        let ord = |t: &str| match t { "add" => 0, "mod" => 1, _ => 2 };
        ord(&a.file_type).cmp(&ord(&b.file_type)).then(a.file.cmp(&b.file))
    });

    Ok(result)
}

#[tauri::command]
pub fn rollback_to(project_path: String, save_id: String) -> Result<(), String> {
    let repo = open_shadow(&project_path)?;

    let oid = git2::Oid::from_str(&save_id).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

    // Checkout the target commit in the shadow repo
    let mut co = git2::build::CheckoutBuilder::new();
    co.force();
    repo.checkout_tree(commit.as_object(), Some(&mut co))
        .map_err(|e| e.to_string())?;
    repo.set_head_detached(oid).map_err(|e| e.to_string())?;

    // Copy shadow workdir → project (also deletes files not in snapshot)
    sync_to_project(&shadow_path(&project_path), &project_path)
        .map_err(|e| format!("恢复文件失败: {}", e))
}
