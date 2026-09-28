//! Rust panics abort; Objective-C exceptions unwind through Rust frames to
//! AppKit (docs/specs/standalone.md -> "Objective-C exceptions").

/// Abort on every Rust panic once the default hook has reported it — what
/// `panic = "abort"` did before the release profile had to unwind.
pub(crate) fn abort_on_panic() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        report(info);
        std::process::abort();
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const CHILD: &str = "DORMOUSE_PANIC_POLICY_CHILD";
    const ABORTED: i32 = 134;

    #[cfg(unix)]
    extern "C" fn exit_on_sigabrt(_: i32) {
        extern "C" {
            fn _exit(code: i32) -> !;
        }
        unsafe { _exit(ABORTED) }
    }

    #[test]
    fn a_rust_panic_aborts_instead_of_unwinding() {
        if std::env::var_os(CHILD).is_some() {
            // Exit from the SIGABRT handler so macOS files no crash report for
            // this test binary; only `abort` raises SIGABRT here.
            #[cfg(unix)]
            unsafe {
                extern "C" {
                    fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
                }
                signal(6, exit_on_sigabrt);
            }
            abort_on_panic();
            panic!("synthetic panic");
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "panic_policy::tests::a_rust_panic_aborts_instead_of_unwinding",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        // A panic that unwound would fail the child's harness with 101 instead.
        #[cfg(unix)]
        assert_eq!(output.status.code(), Some(ABORTED), "{output:?}");
        #[cfg(not(unix))]
        assert!(
            !output.status.success() && output.status.code() != Some(101),
            "{output:?}"
        );
    }

    #[test]
    fn release_builds_unwind() {
        let manifest = include_str!("../Cargo.toml");
        let release = manifest
            .split("\n[")
            .find(|section| section.starts_with("profile.release]"))
            .expect("Cargo.toml has a [profile.release]");
        let panic: Vec<&str> = release
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("panic"))
            .collect();
        assert_eq!(panic, ["panic = \"unwind\""]);
    }

    #[test]
    fn tao_is_the_unwind_fork() {
        let sources: Vec<Option<&str>> = include_str!("../Cargo.lock")
            .split("[[package]]")
            .filter(|package| package.lines().any(|line| line == "name = \"tao\""))
            .map(|package| {
                package
                    .lines()
                    .find_map(|line| line.strip_prefix("source = "))
            })
            .collect();
        assert_eq!(sources.len(), 1, "one tao, not {sources:?}");
        assert!(
            sources[0]
                .is_some_and(|source| source.starts_with("\"git+https://github.com/diffplug/tao?")),
            "{sources:?}"
        );
    }
}
