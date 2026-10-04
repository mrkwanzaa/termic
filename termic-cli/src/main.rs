fn main() {
    // A closed stdout pipe (`termic ... | head`) must end the process
    // the standard unix way (SIGPIPE, shells report 141), not as a
    // Rust panic with exit 101: the runtime ignores SIGPIPE by default
    // and println! panics on EPIPE. 141 is outside, and compatible
    // with, the 0-10 exit contract.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    // `termic hook-emit <target>`: an agent hook's report, from the app's
    // own generated scripts, never typed by a person. Handled before clap
    // and before any socket: a hook runs on every turn, so it has to be
    // fast, and it talks to its terminal, not to the control plane.
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "hook-emit") {
        std::process::exit(termic_cli::hook_emit(args.get(2).map(std::path::Path::new)));
    }
    // On a thread with an 8 MB stack, the size macOS and Linux give the main
    // thread. Windows gives it 1 MB, and building the clap command tree for
    // `help --json` already sat at that edge: a debug CLI on main overflowed
    // at 900 KB, and one more verb (`prop`, GH #358) pushed it over 1 MB,
    // so `help --json` died with a stack overflow on Windows only.
    // Reproduce on a Mac with `ulimit -s 1024`.
    let code = std::thread::Builder::new()
        .stack_size(8 << 20)
        .spawn(termic_cli::run)
        .expect("spawn the CLI thread")
        .join()
        .unwrap_or(1);
    std::process::exit(code);
}
