use std::process::Command;
use serde::{Deserialize, Serialize};

// ── Data types ─────────────────────────────────────────────────────────────

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
    pub file_type: String,
    pub file: String,
    pub add: i32,
    pub rem: i32,
}

// ── Git helper ─────────────────────────────────────────────────────────────

fn git(args: &[&str], cwd: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git 未安装或未在 PATH 中".to_string()
            } else {
                format!("无法运行 git: {}", e)
            }
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ── check_repo ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_repo(project_path: String) -> Result<bool, String> {
    match git(&["rev-parse", "--is-inside-work-tree"], &project_path) {
        Ok(out) => Ok(out.trim() == "true"),
        Err(_) => Ok(false),
    }
}

// ── get_saves ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_saves(project_path: String) -> Result<Vec<SaveInfo>, String> {
    let raw = git(
        &[
            "log",
            "--grep=[savepoint]",
            "--format=%H%x01%s%x01%at%x01%b%x02",
        ],
        &project_path,
    )?;

    if raw.trim().is_empty() {
        return Ok(vec![]);
    }

    let mut saves = Vec::new();
    for record in raw.split('\x02') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }
        let parts: Vec<&str> = record.splitn(4, '\x01').collect();
        if parts.len() < 3 {
            continue;
        }

        let id = parts[0].trim().to_string();
        if id.is_empty() {
            continue;
        }
        let name = parts[1].trim().to_string();
        let time = parts[2].trim().parse::<i64>().unwrap_or(0) * 1000;
        let desc = if parts.len() > 3 {
            parts[3]
                .lines()
                .filter(|l| !l.contains("[savepoint]"))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string()
        } else {
            String::new()
        };

        let delta = compute_delta(&id, &project_path);

        saves.push(SaveInfo {
            id,
            name,
            desc,
            time,
            delta,
            cloud: false,
        });
    }

    Ok(saves)
}

fn compute_delta(hash: &str, cwd: &str) -> String {
    let stat = git(&["diff", "--shortstat", &format!("{}^!", hash)], cwd)
        .unwrap_or_default();

    if !stat.trim().is_empty() {
        return parse_shortstat(&stat);
    }

    match git(&["diff-tree", "--no-commit-id", "-r", "--name-only", hash], cwd) {
        Ok(out) => {
            let count = out.lines().filter(|l| !l.is_empty()).count();
            format!("全量 ({} 文件)", count)
        }
        Err(_) => "全量".to_string(),
    }
}

fn parse_shortstat(s: &str) -> String {
    let mut files = 0i32;
    let mut ins = 0i32;
    let mut del = 0i32;
    for part in s.split(',') {
        let part = part.trim();
        if part.contains("file") {
            files = part.split_whitespace().next()
                .and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if part.contains("insertion") {
            ins = part.split_whitespace().next()
                .and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if part.contains("deletion") {
            del = part.split_whitespace().next()
                .and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }
    match (ins, del) {
        (i, 0) if i > 0 => format!("+{} ({} 文件)", i, files),
        (0, d) if d > 0 => format!("-{} ({} 文件)", d, files),
        (i, d) => format!("+{} -{} ({} 文件)", i, d, files),
    }
}

// ── get_diff ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_diff(project_path: String, commit_hash: String) -> Result<Vec<DiffFile>, String> {
    use std::collections::HashMap;

    let status_out = git(
        &["diff-tree", "--no-commit-id", "-r", "--name-status", "--root", &commit_hash],
        &project_path,
    )?;

    let mut status_map: HashMap<String, String> = HashMap::new();
    for line in status_out.lines() {
        let mut parts = line.splitn(2, '\t');
        if let (Some(status), Some(file)) = (parts.next(), parts.next()) {
            let s = match status.trim().chars().next() {
                Some('A') => "add",
                Some('D') => "del",
                _ => "mod",
            };
            status_map.insert(file.trim().to_string(), s.to_string());
        }
    }

    let numstat_out = git(
        &["diff-tree", "--no-commit-id", "-r", "--numstat", "--root", &commit_hash],
        &project_path,
    )?;

    let mut result = Vec::new();
    for line in numstat_out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let file = parts[2].trim().to_string();
        let add: i32 = parts[0].parse().unwrap_or(0);
        let rem: i32 = parts[1].parse().unwrap_or(0);
        let file_type = status_map.get(&file).cloned().unwrap_or_else(|| "mod".to_string());

        result.push(DiffFile { file_type, file, add, rem });
    }

    Ok(result)
}

// ── create_save ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_save(
    project_path: String,
    name: String,
    desc: String,
) -> Result<String, String> {
    git(&["add", "-A"], &project_path)?;

    let msg = if desc.trim().is_empty() {
        format!("{}\n\n[savepoint]", name.trim())
    } else {
        format!("{}\n\n{}\n\n[savepoint]", name.trim(), desc.trim())
    };

    let output = Command::new("git")
        .args(&["commit", "-m", &msg])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("无法运行 git: {}", e))?;

    if output.status.success() {
        let hash = git(&["rev-parse", "HEAD"], &project_path)?;
        Ok(hash.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("nothing to commit") || stderr.contains("nothing added to commit") {
            Err("没有检测到变更，无法创建存档。请先修改文件。".to_string())
        } else if stderr.contains("user.email") || stderr.contains("Please tell me who you are") {
            Err("请先配置 git 用户信息：\ngit config --global user.name \"名字\"\ngit config --global user.email \"邮箱\"".to_string())
        } else {
            Err(stderr.trim().to_string())
        }
    }
}

// ── rollback_to ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn rollback_to(project_path: String, commit_hash: String) -> Result<(), String> {
    git(&["checkout", &commit_hash, "--", "."], &project_path)?;
    Ok(())
}
