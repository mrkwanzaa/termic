//! Recurring schedules (the recurring half of GH #300).
//!
//! A schedule lives on its PARENT task's record (`Task::schedule`), the way a
//! scheduled queue message lives on its tab record, so it rides the task file:
//! profile-scoped, paused while the parent is archived, back on restore, gone
//! with a hard delete. The clock and every decision about WHEN to run belong
//! to the webview (`src/lib/schedules/`), which is what reads the parent's
//! record and creates each run.
//!
//! What lives here is every rule that touches the user's files. A run's result
//! is a report the agent writes into `<project>/.termic/schedules/<slug>/`,
//! inside the live checkout because that is where a caged agent can write
//! (Seatbelt allows the task dir, and a main-checkout task's dir is the
//! project). This module creates that folder, keeps it out of git through the
//! repo's local `info/exclude`, reads a report's title, and deletes old
//! reports. Deletion is in Rust, not the caller, because it removes files from
//! the user's project: only report-named files, only directly inside the
//! schedule's own folder, never through a symlink.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Where every schedule's report folder lives, relative to the project root.
/// `.termic/` is shared: `.termic/tasks` is a legal worktrees root too, so
/// nothing here may treat `.termic/` itself as ours to clean.
pub const REPORTS_ROOT: [&str; 2] = [".termic", "schedules"];

/// Upper bound on `keep_runs`. The runner archives runs past N by walking
/// `history`, so N has to fit comfortably inside it.
pub const MAX_KEEP_RUNS: u32 = 20;

/// Sanity cap on `history`. The runner keeps about 30 entries; this only
/// stops a frontend bug from growing a task file without bound.
pub const MAX_HISTORY: usize = 100;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CadenceKind {
    #[default]
    Daily,
    Weekdays,
    Weekly,
}

/// When a schedule runs. Presets, not cron: daily, weekdays (Mon-Fri) or
/// weekly, each at one local wall-clock time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct ScheduleCadence {
    pub kind: CadenceKind,
    /// Local wall-clock time, `HH:MM`.
    pub time: String,
    /// Weekly only: 0 = Sunday .. 6 = Saturday, JavaScript's `getDay()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u8>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    /// In flight: created, and not yet settled.
    #[default]
    Running,
    /// Settled done with its report written.
    Fired,
    /// Settled done WITHOUT writing its report: the agent stopped but did
    /// not do the job, the failure the settle signal alone cannot see.
    NoReport,
    /// Blocked on the user. The run stays live.
    NeedsInput,
    /// The slot passed while Termic was not running (or the Mac slept past
    /// the grace window). `count` holds a streak.
    Missed,
    /// The previous run was still active when the slot came due.
    Skipped,
    /// The run could not be created or never got its prompt; `error` says why.
    Failed,
}

/// One entry in a schedule's history.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct ScheduleRun {
    /// The slot this entry is about (epoch ms). For a Run now, the moment it
    /// was asked for.
    pub slot: i64,
    pub outcome: RunOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_task_id: Option<String>,
    /// The report's path relative to the project, once one was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    /// The report's first heading (or `<title>`), read once when the run
    /// ended so the Scheduled view never reads files to draw itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A missed streak: how many slots this one entry stands for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Started by Run now rather than by the clock.
    #[serde(skip_serializing_if = "is_false")]
    pub manual: bool,
    /// The report was deleted by retention; the entry says so instead of
    /// linking to a missing file.
    #[serde(skip_serializing_if = "is_false")]
    pub report_gone: bool,
}

/// `Task::schedule`. Absent on every task that is not a schedule's parent, so
/// existing task files are unchanged.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct TaskSchedule {
    pub enabled: bool,
    pub name: String,
    /// The report folder's name. Fixed at creation, so renaming a schedule
    /// does not strand its reports; `task_set_schedule` refuses a change.
    pub slug: String,
    /// The prompt text. With `prompt_id` as well, the library entry's body
    /// comes first and this follows it, the CLI's `-P` + `-p` composition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// A prompt-library entry, resolved when the run fires.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    pub cadence: ScheduleCadence,
    /// Run once when a missed slot is first noticed (at launch, or on wake),
    /// however many slots passed.
    pub catch_up: bool,
    /// Runs past the newest N are archived.
    pub keep_runs: u32,
    /// Days to keep reports, `None` for forever. Written as 30 when a
    /// schedule is created, so `None` only ever means the user chose forever.
    pub report_days: Option<u32>,
    /// The last slot the runner acted on (epoch ms). A pass only acts on a
    /// later one, which is the whole DST story: the repeated hour cannot fire
    /// twice.
    pub last_slot: Option<i64>,
    pub history: Vec<ScheduleRun>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A slug names a directory, so it is refused rather than sanitized: a
/// silently rewritten slug would point at a different folder than the
/// record says. Lowercase ASCII letters, digits and inner hyphens.
pub fn slug_ok(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

fn time_ok(t: &str) -> bool {
    let b = t.as_bytes();
    if b.len() != 5 || b[2] != b':' || !t[..2].bytes().chain(t[3..].bytes()).all(|c| c.is_ascii_digit()) {
        return false;
    }
    let (h, m): (u32, u32) = (t[..2].parse().unwrap_or(99), t[3..].parse().unwrap_or(99));
    h < 24 && m < 60
}

/// Why `s` cannot be stored, or `None`. The frontend validates the same
/// things for its own messages; this is the boundary that does not trust it.
pub fn schedule_problem(s: &TaskSchedule) -> Option<String> {
    if s.name.trim().is_empty() {
        return Some("a schedule needs a name".into());
    }
    if !slug_ok(&s.slug) {
        return Some(format!("invalid schedule folder name \"{}\"", s.slug));
    }
    let has = |o: &Option<String>| o.as_deref().is_some_and(|v| !v.trim().is_empty());
    if !has(&s.prompt) && !has(&s.prompt_id) {
        return Some("a schedule needs a prompt".into());
    }
    if !time_ok(&s.cadence.time) {
        return Some(format!("invalid time \"{}\", expected HH:MM", s.cadence.time));
    }
    if s.cadence.kind == CadenceKind::Weekly && !s.cadence.weekday.is_some_and(|d| d <= 6) {
        return Some("a weekly schedule needs a weekday".into());
    }
    if !(1..=MAX_KEEP_RUNS).contains(&s.keep_runs) {
        return Some(format!("keep between 1 and {MAX_KEEP_RUNS} runs"));
    }
    if s.report_days.is_some_and(|d| d == 0 || d > 3650) {
        return Some("report retention must be between 1 and 3650 days, or forever".into());
    }
    if s.history.len() > MAX_HISTORY {
        return Some("schedule history is too long".into());
    }
    None
}

/// `<project>/.termic/schedules/<slug>`, unresolved.
pub fn report_dir(project_root: &Path, slug: &str) -> PathBuf {
    let mut p = project_root.to_path_buf();
    for c in REPORTS_ROOT {
        p.push(c);
    }
    p.push(slug);
    p
}

/// The report folder, checked: the slug is valid and no component from the
/// project root down (`.termic`, `schedules`, the slug) is a symlink or
/// anything but a directory. `Ok(None)` when the folder does not exist yet.
///
/// Every check is on the LINK itself (`symlink_metadata`), because following
/// one is exactly how a cleanup would end up deleting files somewhere else.
pub fn checked_report_dir(project_root: &Path, slug: &str) -> Result<Option<PathBuf>, String> {
    if !slug_ok(slug) {
        return Err(format!("invalid schedule folder name \"{slug}\""));
    }
    let mut cur = project_root.to_path_buf();
    for c in REPORTS_ROOT.iter().copied().chain(std::iter::once(slug)) {
        cur.push(c);
        match fs::symlink_metadata(&cur) {
            Err(_) => return Ok(None),
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!("refusing {}: it is a symlink", cur.display()));
            }
            Ok(m) if !m.is_dir() => {
                return Err(format!("refusing {}: it is not a folder", cur.display()));
            }
            Ok(_) => {}
        }
    }
    Ok(Some(cur))
}

/// Create the schedule's report folder, and in a git project keep
/// `.termic/schedules/` out of git through the repo's local exclude file.
///
/// Refuses to create through a symlinked `.termic` or `schedules`:
/// `create_dir_all` would follow it and make the folder somewhere else.
pub fn ensure_report_dir(project_root: &Path, is_git: bool, slug: &str) -> Result<PathBuf, String> {
    if !project_root.is_dir() {
        return Err(format!("project folder {} does not exist", project_root.display()));
    }
    let dir = match checked_report_dir(project_root, slug)? {
        Some(d) => d,
        None => {
            let d = report_dir(project_root, slug);
            fs::create_dir_all(&d).map_err(|e| format!("could not create {}: {e}", d.display()))?;
            // Re-check after creating: a component that existed as a symlink
            // was already refused above, so this only catches a race.
            checked_report_dir(project_root, slug)?
                .ok_or_else(|| format!("could not create {}", d.display()))?
        }
    };
    if is_git {
        if let Some((exclude, line)) = exclude_target(project_root) {
            crate::append_exclude_line(&exclude, &line);
        }
    }
    Ok(dir)
}

/// The repo's exclude file and the line that hides `.termic/schedules/` in it.
///
/// A project need not be its repository's root (pointing Termic at
/// `packages/app` makes that the project), and the exclude file belongs to
/// the repo, so the line is anchored at the REPO root: `/packages/app/.termic/
/// schedules/`. The file is in the common git dir, which is where `info/`
/// lives for a linked worktree too. `None` for anything git cannot answer.
pub fn exclude_target(project_root: &Path) -> Option<(PathBuf, String)> {
    let top = crate::git(&["rev-parse", "--show-toplevel"], project_root).ok()?;
    let common = crate::git(&["rev-parse", "--git-common-dir"], project_root).ok()?;
    let top = dunce::canonicalize(top.trim()).ok()?;
    let common = PathBuf::from(common.trim());
    // Relative output is relative to the directory git ran in.
    let common = if common.is_absolute() { common } else { project_root.join(common) };
    let common = dunce::canonicalize(common).ok()?;
    let root = dunce::canonicalize(project_root).ok()?;
    let rel = root.strip_prefix(&top).ok()?;
    let mut line = String::from("/");
    for c in rel.components() {
        line.push_str(&escape_ignore_glob(&c.as_os_str().to_string_lossy()));
        line.push('/');
    }
    line.push_str(".termic/schedules/");
    Some((common.join("info").join("exclude"), line))
}

/// Escape the characters a gitignore pattern treats as glob syntax, so a
/// project folder named `app[2]` matches itself. The line always starts with
/// `/` and ends with `/`, so a leading `#`/`!` and trailing spaces cannot
/// occur.
fn escape_ignore_glob(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for ch in seg.chars() {
        if matches!(ch, '*' | '?' | '[' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `YYYY-MM-DD` out of a report file name `YYYY-MM-DD_HHMM.md` or `.html`,
/// or `None` for anything else. The name is the only thing a cleanup trusts:
/// a file the agent or the user put in the folder under any other name is
/// never touched.
pub fn report_name_date(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".md").or_else(|| name.strip_suffix(".html"))?;
    if !stem_ok(stem) {
        return None;
    }
    Some(&stem[..10])
}

/// A report stem: `YYYY-MM-DD_HHMM`, with a real month, day, hour and minute.
pub fn stem_ok(stem: &str) -> bool {
    let b = stem.as_bytes();
    if b.len() != 15 || b[4] != b'-' || b[7] != b'-' || b[10] != b'_' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<u32> {
        let s = &stem[r];
        if s.bytes().all(|c| c.is_ascii_digit()) { s.parse().ok() } else { None }
    };
    let (Some(_y), Some(mo), Some(d), Some(h), Some(mi)) =
        (digits(0..4), digits(5..7), digits(8..10), digits(11..13), digits(13..15))
    else {
        return false;
    };
    (1..=12).contains(&mo) && (1..=31).contains(&d) && h < 24 && mi < 60
}

fn date_ok(d: &str) -> bool {
    stem_ok(&format!("{d}_0000"))
}

/// Delete report files in one schedule's folder. With `before`
/// (`YYYY-MM-DD`, local, computed by the caller), only reports whose NAME is
/// dated earlier; without it, every report (deleting a schedule's reports),
/// after which the folder itself goes if nothing else is left in it.
///
/// Age comes from the file name and never the mtime, so editing an old report
/// does not reset its clock. Only regular files directly in the folder whose
/// names match the report pattern are candidates: a subfolder, a symlink or
/// any other file stays. Returns the deleted names, sorted.
pub fn prune_reports(project_root: &Path, slug: &str, before: Option<&str>) -> Result<Vec<String>, String> {
    if let Some(b) = before {
        if !date_ok(b) {
            return Err(format!("invalid cutoff date \"{b}\", expected YYYY-MM-DD"));
        }
    }
    let Some(dir) = checked_report_dir(project_root, slug)? else {
        return Ok(Vec::new());
    };
    let mut deleted = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        // `DirEntry::file_type` does not follow symlinks, so a link named
        // like a report is neither a file here nor deleted.
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(date) = report_name_date(&name) else { continue };
        if before.is_some_and(|b| date >= b) {
            continue;
        }
        if fs::remove_file(entry.path()).is_ok() {
            deleted.push(name);
        }
    }
    deleted.sort();
    if before.is_none() {
        // Non-recursive: anything left in it keeps it.
        let _ = fs::remove_dir(&dir);
    }
    Ok(deleted)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default)]
pub struct ReportStatus {
    /// Relative to the project root, `/`-separated. `None` when the run did
    /// not write a report.
    pub path: Option<String>,
    pub title: Option<String>,
}

/// Bytes read to find a title. A heading is at the top of a report.
const TITLE_SCAN_BYTES: u64 = 64 * 1024;
const TITLE_MAX_CHARS: usize = 200;

/// Whether the run behind `stem` wrote its report, and its title. `.md` wins
/// over `.html` when both exist. A symlink named like a report is not one.
pub fn report_status(project_root: &Path, slug: &str, stem: &str) -> Result<ReportStatus, String> {
    if !stem_ok(stem) {
        return Err(format!("invalid report name \"{stem}\""));
    }
    let Some(dir) = checked_report_dir(project_root, slug)? else {
        return Ok(ReportStatus::default());
    };
    for ext in ["md", "html"] {
        let file = dir.join(format!("{stem}.{ext}"));
        let Ok(meta) = fs::symlink_metadata(&file) else { continue };
        if !meta.file_type().is_file() {
            continue;
        }
        let text = read_head(&file).unwrap_or_default();
        let title = if ext == "md" { markdown_title(&text) } else { html_title(&text) };
        return Ok(ReportStatus {
            path: Some(format!("{}/{}/{slug}/{stem}.{ext}", REPORTS_ROOT[0], REPORTS_ROOT[1])),
            title,
        });
    }
    Ok(ReportStatus::default())
}

fn read_head(file: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    fs::File::open(file)?.take(TITLE_SCAN_BYTES).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn clip_title(s: &str) -> Option<String> {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(TITLE_MAX_CHARS).collect())
}

/// The first ATX heading (`# Title`, any level), skipping fenced code.
pub fn markdown_title(text: &str) -> Option<String> {
    let mut fenced = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let hashes = t.bytes().take_while(|&b| b == b'#').count();
        if (1..=6).contains(&hashes) {
            let rest = &t[hashes..];
            if rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t') {
                let rest = rest.trim().trim_end_matches('#').trim();
                if let Some(title) = clip_title(rest) {
                    return Some(title);
                }
            }
        }
    }
    None
}

/// `<title>`, else the first `<h1>`, as plain text.
pub fn html_title(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let inner = |open: &str, close: &str| -> Option<String> {
        let start = lower.find(open)?;
        let body_start = start + lower[start..].find('>')? + 1;
        let end = body_start + lower[body_start..].find(close)?;
        clip_title(&decode_entities(&strip_tags(&text[body_start..end])))
    };
    inner("<title", "</title>").or_else(|| inner("<h1", "</h1>"))
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    fn sched() -> TaskSchedule {
        TaskSchedule {
            enabled: true,
            name: "grafana check".into(),
            slug: "grafana-check".into(),
            prompt: Some("check the dashboards".into()),
            cadence: ScheduleCadence { kind: CadenceKind::Daily, time: "09:00".into(), weekday: None },
            keep_runs: 7,
            report_days: Some(30),
            ..Default::default()
        }
    }

    fn git_init(dir: &Path) {
        let ok = Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap().success();
        assert!(ok, "git init failed in {}", dir.display());
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    // ── the record ───────────────────────────────────────────────────────

    #[test]
    fn a_valid_schedule_has_no_problem() {
        assert_eq!(schedule_problem(&sched()), None);
        let mut weekly = sched();
        weekly.cadence = ScheduleCadence { kind: CadenceKind::Weekly, time: "23:59".into(), weekday: Some(6) };
        weekly.prompt = None;
        weekly.prompt_id = Some("builtin:review".into());
        weekly.report_days = None;
        assert_eq!(schedule_problem(&weekly), None);
    }

    #[test]
    fn the_boundary_refuses_what_the_runner_cannot_use() {
        let cases: Vec<(&str, Box<dyn Fn(&mut TaskSchedule)>)> = vec![
            ("blank name", Box::new(|s| s.name = "  ".into())),
            ("slug climbs out", Box::new(|s| s.slug = "../x".into())),
            ("slug has a slash", Box::new(|s| s.slug = "a/b".into())),
            ("slug uppercase", Box::new(|s| s.slug = "Grafana".into())),
            ("slug leading hyphen", Box::new(|s| s.slug = "-x".into())),
            ("no prompt", Box::new(|s| { s.prompt = Some(" ".into()); s.prompt_id = None; })),
            ("bad time", Box::new(|s| s.cadence.time = "24:00".into())),
            ("bad time shape", Box::new(|s| s.cadence.time = "9:00".into())),
            ("weekly without a day", Box::new(|s| s.cadence.kind = CadenceKind::Weekly)),
            ("weekday out of range", Box::new(|s| { s.cadence.kind = CadenceKind::Weekly; s.cadence.weekday = Some(7); })),
            ("keep zero", Box::new(|s| s.keep_runs = 0)),
            ("keep too many", Box::new(|s| s.keep_runs = MAX_KEEP_RUNS + 1)),
            ("zero retention", Box::new(|s| s.report_days = Some(0))),
            ("history unbounded", Box::new(|s| s.history = vec![ScheduleRun::default(); MAX_HISTORY + 1])),
        ];
        for (what, edit) in cases {
            let mut s = sched();
            edit(&mut s);
            assert!(schedule_problem(&s).is_some(), "accepted: {what}");
        }
    }

    #[test]
    fn the_wire_shape_is_snake_case_and_omits_what_is_unset() {
        let mut s = sched();
        s.history.push(ScheduleRun { slot: 1, outcome: RunOutcome::NoReport, ..Default::default() });
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["cadence"]["kind"], "daily");
        assert!(v["cadence"].get("weekday").is_none());
        assert_eq!(v["history"][0]["outcome"], "no_report");
        assert!(v["history"][0].get("manual").is_none());
        assert!(v["history"][0].get("report_gone").is_none());
        // Forever is an explicit null, never an absent key the frontend would
        // read as "not set yet".
        s.report_days = None;
        assert!(serde_json::to_value(&s).unwrap()["report_days"].is_null());
        let back: TaskSchedule = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    // ── the folder and the exclude line ──────────────────────────────────

    #[test]
    fn creating_the_folder_in_a_repo_adds_one_exclude_line() {
        let d = tempdir().unwrap();
        git_init(d.path());
        let dir = ensure_report_dir(d.path(), true, "grafana-check").unwrap();
        assert!(dir.is_dir());
        assert!(dir.ends_with(".termic/schedules/grafana-check"));
        // A second schedule, and the same one again: still one line.
        ensure_report_dir(d.path(), true, "deps").unwrap();
        ensure_report_dir(d.path(), true, "grafana-check").unwrap();
        let exclude = fs::read_to_string(d.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| *l == "/.termic/schedules/").count(), 1, "{exclude}");
        // And git really does ignore what lands there.
        touch(&dir.join("2026-09-28_0900.md"));
        let st = Command::new("git").args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(d.path()).output().unwrap();
        assert!(String::from_utf8_lossy(&st.stdout).trim().is_empty(), "report shows in git status");
    }

    #[test]
    fn a_project_below_its_repo_root_anchors_the_line_at_the_repo_root() {
        let d = tempdir().unwrap();
        git_init(d.path());
        let project = d.path().join("packages").join("app[2]");
        fs::create_dir_all(&project).unwrap();
        let dir = ensure_report_dir(&project, true, "nightly").unwrap();
        let exclude = fs::read_to_string(d.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l == "/packages/app\\[2]/.termic/schedules/"), "{exclude}");
        touch(&dir.join("2026-09-28_0900.md"));
        let st = Command::new("git").args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(d.path()).output().unwrap();
        assert!(String::from_utf8_lossy(&st.stdout).trim().is_empty(),
            "report shows in git status: {}", String::from_utf8_lossy(&st.stdout));
    }

    #[test]
    fn a_plain_folder_gets_the_folder_and_no_git_dir() {
        let d = tempdir().unwrap();
        ensure_report_dir(d.path(), false, "triage").unwrap();
        assert!(d.path().join(".termic/schedules/triage").is_dir());
        assert!(!d.path().join(".git").exists());
    }

    #[cfg(unix)]
    #[test]
    fn creating_through_a_symlinked_termic_dir_is_refused() {
        let d = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), d.path().join(".termic")).unwrap();
        let err = ensure_report_dir(d.path(), false, "triage").unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(fs::read_dir(elsewhere.path()).unwrap().next().is_none(), "created through the link");
    }

    // ── pruning ──────────────────────────────────────────────────────────

    #[test]
    fn report_names_are_the_only_candidates() {
        assert_eq!(report_name_date("2026-09-28_0900.md"), Some("2026-09-28"));
        assert_eq!(report_name_date("2026-09-28_2359.html"), Some("2026-09-28"));
        for name in [
            "2026-09-28_0900.txt", "2026-09-28_0900.md.bak", "notes.md", "2026-13-01_0900.md",
            "2026-09-28_2400.md", "2026-09-28-0900.md", "x2026-09-28_0900.md", "2026-09-28_0900",
        ] {
            assert_eq!(report_name_date(name), None, "{name}");
        }
    }

    #[test]
    fn prune_deletes_an_old_report_and_keeps_a_new_one() {
        let d = tempdir().unwrap();
        let dir = ensure_report_dir(d.path(), false, "s").unwrap();
        touch(&dir.join("2026-08-01_0900.md"));
        touch(&dir.join("2026-08-02_0900.html"));
        touch(&dir.join("2026-09-28_0900.md"));
        let deleted = prune_reports(d.path(), "s", Some("2026-09-01")).unwrap();
        assert_eq!(deleted, vec!["2026-08-01_0900.md", "2026-08-02_0900.html"]);
        assert!(dir.join("2026-09-28_0900.md").exists());
        // Nothing left to delete: an empty answer, so the caller writes nothing.
        assert!(prune_reports(d.path(), "s", Some("2026-09-01")).unwrap().is_empty());
    }

    #[test]
    fn age_comes_from_the_name_not_the_mtime() {
        let d = tempdir().unwrap();
        let dir = ensure_report_dir(d.path(), false, "s").unwrap();
        // Written just now (fresh mtime) but named for August: it goes.
        touch(&dir.join("2026-08-01_0900.md"));
        assert_eq!(prune_reports(d.path(), "s", Some("2026-09-01")).unwrap(), vec!["2026-08-01_0900.md"]);
    }

    #[test]
    fn prune_leaves_other_files_subfolders_and_symlinks_alone() {
        let d = tempdir().unwrap();
        let dir = ensure_report_dir(d.path(), false, "s").unwrap();
        touch(&dir.join("notes.md"));
        fs::create_dir_all(dir.join("2026-08-01_0900.md")).unwrap(); // a FOLDER named like a report
        touch(&d.path().join("outside").join("keep.md"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(d.path().join("outside/keep.md"), dir.join("2026-08-02_0900.md")).unwrap();
        let deleted = prune_reports(d.path(), "s", Some("2026-09-01")).unwrap();
        assert!(deleted.is_empty(), "{deleted:?}");
        assert!(dir.join("notes.md").exists());
        assert!(dir.join("2026-08-01_0900.md").is_dir());
        assert!(d.path().join("outside/keep.md").exists());
        // Deleting ALL reports still leaves them, and so the folder stays.
        prune_reports(d.path(), "s", None).unwrap();
        assert!(dir.join("notes.md").exists());
        assert!(dir.is_dir());
    }

    #[test]
    fn delete_all_removes_reports_and_then_an_empty_folder() {
        let d = tempdir().unwrap();
        let dir = ensure_report_dir(d.path(), false, "s").unwrap();
        touch(&dir.join("2026-08-01_0900.md"));
        touch(&dir.join("2099-01-01_0900.md"));
        assert_eq!(prune_reports(d.path(), "s", None).unwrap().len(), 2);
        assert!(!dir.exists());
        assert!(d.path().join(".termic/schedules").is_dir(), "only the schedule's own folder goes");
    }

    #[test]
    fn prune_refuses_a_slug_that_climbs_out() {
        let d = tempdir().unwrap();
        let project = d.path().join("p");
        fs::create_dir_all(&project).unwrap();
        touch(&d.path().join("victim").join("2026-08-01_0900.md"));
        for slug in ["../../victim", "..", "a/../../b", ""] {
            assert!(prune_reports(&project, slug, Some("2026-09-01")).is_err(), "{slug}");
        }
        assert!(d.path().join("victim/2026-08-01_0900.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn prune_refuses_a_symlinked_schedule_folder() {
        let d = tempdir().unwrap();
        let elsewhere = tempdir().unwrap();
        touch(&elsewhere.path().join("2026-08-01_0900.md"));
        fs::create_dir_all(d.path().join(".termic/schedules")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), d.path().join(".termic/schedules/s")).unwrap();
        assert!(prune_reports(d.path(), "s", Some("2026-09-01")).is_err());
        assert!(prune_reports(d.path(), "s", None).is_err());
        assert!(elsewhere.path().join("2026-08-01_0900.md").exists());
    }

    #[test]
    fn prune_refuses_a_malformed_cutoff() {
        let d = tempdir().unwrap();
        ensure_report_dir(d.path(), false, "s").unwrap();
        assert!(prune_reports(d.path(), "s", Some("30 days")).is_err());
        assert!(prune_reports(d.path(), "s", Some("2026-9-1")).is_err());
    }

    #[test]
    fn a_missing_folder_prunes_nothing() {
        let d = tempdir().unwrap();
        assert!(prune_reports(d.path(), "never-ran", Some("2026-09-01")).unwrap().is_empty());
    }

    // ── report status ────────────────────────────────────────────────────

    #[test]
    fn status_finds_the_report_and_its_title() {
        let d = tempdir().unwrap();
        let dir = ensure_report_dir(d.path(), false, "s").unwrap();
        assert_eq!(report_status(d.path(), "s", "2026-09-28_0900").unwrap(), ReportStatus::default());
        fs::write(dir.join("2026-09-28_0900.md"), "intro\n```\n# not this\n```\n## Dashboards: all green ##\n").unwrap();
        let st = report_status(d.path(), "s", "2026-09-28_0900").unwrap();
        assert_eq!(st.path.as_deref(), Some(".termic/schedules/s/2026-09-28_0900.md"));
        assert_eq!(st.title.as_deref(), Some("Dashboards: all green"));
        fs::write(dir.join("2026-09-29_0900.html"), "<html><head><TITLE>CPU &amp; memory</TITLE></head></html>").unwrap();
        let st = report_status(d.path(), "s", "2026-09-29_0900").unwrap();
        assert_eq!(st.path.as_deref(), Some(".termic/schedules/s/2026-09-29_0900.html"));
        assert_eq!(st.title.as_deref(), Some("CPU & memory"));
        assert!(report_status(d.path(), "s", "../../etc").is_err());
    }

    #[test]
    fn titles_fall_back_sensibly() {
        assert_eq!(markdown_title("no heading at all"), None);
        assert_eq!(markdown_title("#hashtag\n# Real"), Some("Real".into()));
        assert_eq!(html_title("<body><h1 class=x>Big <b>news</b></h1></body>"), Some("Big news".into()));
        assert_eq!(html_title("<p>none</p>"), None);
        let long = format!("# {}", "a".repeat(500));
        assert_eq!(markdown_title(&long).unwrap().chars().count(), TITLE_MAX_CHARS);
    }
}
