use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    println!("cargo:rerun-if-env-changed=MOUSETERM_NODE_BINARY");
    println!("cargo:rerun-if-env-changed=NODE_BINARY");
    println!("cargo:rerun-if-env-changed=PATH");

    // tauri-build doesn't expand bundle.resources globs into rerun-if-changed
    // entries, so edits to ../sidecar/*.js wouldn't rerun this script and the
    // staged copy under target/<profile>/_up_/sidecar/ would go stale.
    println!("cargo:rerun-if-changed=../sidecar");

    bundle_node_runtime().expect("failed to prepare bundled Node.js runtime");
    tauri_build::build()
}

fn bundle_node_runtime() -> Result<(), Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let target = env::var("TARGET")?;
    let host = env::var("HOST")?;
    let node_source = resolve_node_binary(&host, &target)?;

    validate_node_binary(&node_source, &target)?;

    // The supply-chain page (website/src/data/dependencies-runtime.json) discloses
    // an exact Node.js version. Fail the build if the binary we're about to bundle
    // doesn't match the pin in the root package.json's devEngines.runtime.version,
    // so the disclosed version provably equals what ships. Locally pnpm honors
    // devEngines (onFail: "download") so scripts run with the pinned Node; CI
    // reads the same field to drive actions/setup-node.
    let pinned_version = read_pinned_node_version(&manifest_dir)?;
    verify_node_version(&node_source, &host, &target, &pinned_version)?;

    let binaries_dir = manifest_dir.join("binaries");
    fs::create_dir_all(&binaries_dir)?;

    let node_dest = binaries_dir.join(node_binary_name(&target));
    fs::copy(&node_source, &node_dest)?;

    if target.contains("windows") {
        force_windows_gui_subsystem(&node_dest)?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut perms = fs::metadata(&node_dest)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&node_dest, perms)?;
    }

    Ok(())
}

// Rewrite the PE subsystem byte of the bundled node.exe from 3 (Windows
// console) to 2 (Windows GUI). Node.js does not care which subsystem its
// host binary advertises — it reads stdio handles from STARTUPINFO either
// way — but a console-subsystem process triggers Windows' default-terminal
// COM handoff, which on Win11 with Windows Terminal as DefTerm activates WT
// to host the sidecar (visible as a stray WT window titled with the node.exe
// path behind Dormouse). Neither CREATE_NO_WINDOW nor DETACHED_PROCESS opts
// out of that handoff; only a non-console subsystem does.
fn force_windows_gui_subsystem(path: &Path) -> Result<(), Box<dyn Error>> {
    const IMAGE_SUBSYSTEM_WINDOWS_GUI: u16 = 2;
    const IMAGE_SUBSYSTEM_WINDOWS_CUI: u16 = 3;

    let mut bytes = fs::read(path)?;
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return Err(format!("{} is not a PE/COFF binary", path.display()).into());
    }
    let pe_offset = u32::from_le_bytes(bytes[0x3C..0x40].try_into()?) as usize;
    // PE signature (4) + COFF header (20) + Optional header up to Subsystem (0x44).
    let subsystem_offset = pe_offset + 0x5C;
    if bytes.len() < subsystem_offset + 2 || &bytes[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err(format!("{} has no PE signature at expected offset", path.display()).into());
    }
    let current = u16::from_le_bytes(bytes[subsystem_offset..subsystem_offset + 2].try_into()?);
    if current == IMAGE_SUBSYSTEM_WINDOWS_GUI {
        return Ok(());
    }
    if current != IMAGE_SUBSYSTEM_WINDOWS_CUI {
        return Err(format!(
            "{} has unexpected PE subsystem {current}; refusing to patch",
            path.display()
        )
        .into());
    }
    bytes[subsystem_offset..subsystem_offset + 2]
        .copy_from_slice(&IMAGE_SUBSYSTEM_WINDOWS_GUI.to_le_bytes());

    // fs::copy preserves the source's read-only attribute. When the runtime
    // comes from pnpm's content-addressable store (devEngines `onFail:
    // "download"`), the source node.exe is typically read-only, so the
    // destination would be too — and fs::write would fail with "access
    // denied". Clear it defensively before writing the patched bytes back.
    let mut perms = fs::metadata(path)?.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        fs::set_permissions(path, perms)?;
    }
    fs::write(path, &bytes)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn validate_node_binary(node_source: &Path, target: &str) -> Result<(), Box<dyn Error>> {
    if target.contains("apple-darwin") {
        reject_macos_dynamic_node(node_source)?;
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn validate_node_binary(_node_source: &Path, _target: &str) -> Result<(), Box<dyn Error>> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn reject_macos_dynamic_node(node_source: &Path) -> Result<(), Box<dyn Error>> {
    let output = Command::new("otool").arg("-L").arg(node_source).output()?;
    if !output.status.success() {
        return Err(format!(
            "failed to inspect Node.js runtime at {}",
            node_source.display()
        )
        .into());
    }

    let deps = String::from_utf8_lossy(&output.stdout);
    if deps.contains("@rpath/libnode.") {
        return Err(format!(
            "{} depends on @rpath/libnode*.dylib and cannot be copied as a self-contained Tauri sidecar. Use a standalone Node.js binary, or set MOUSETERM_NODE_BINARY to one.",
            node_source.display()
        )
        .into());
    }

    Ok(())
}

fn read_pinned_node_version(manifest_dir: &Path) -> Result<String, Box<dyn Error>> {
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("manifest dir has no grandparent (expected <repo>/standalone/src-tauri)")?;
    let pin_path = repo_root.join("package.json");
    println!("cargo:rerun-if-changed={}", pin_path.display());

    let raw = fs::read_to_string(&pin_path)
        .map_err(|err| format!("failed to read {}: {err}", pin_path.display()))?;
    let pkg: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|err| format!("failed to parse {}: {err}", pin_path.display()))?;
    let version = pkg
        .get("devEngines")
        .and_then(|v| v.get("runtime"))
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            format!(
                "{} is missing devEngines.runtime.version (string)",
                pin_path.display()
            )
        })?
        .trim()
        .trim_start_matches('v')
        .to_owned();

    let is_exact = version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if !is_exact {
        return Err(format!(
            "{} devEngines.runtime.version must be an exact Node.js version (MAJOR.MINOR.PATCH), found {version:?}",
            pin_path.display()
        )
        .into());
    }

    Ok(version)
}

fn verify_node_version(
    node_source: &Path,
    host: &str,
    target: &str,
    pinned: &str,
) -> Result<(), Box<dyn Error>> {
    if host != target {
        // Can't execute a foreign-arch binary; the operator supplied it via
        // MOUSETERM_NODE_BINARY and is responsible for matching the pin.
        println!(
            "cargo:warning=skipping Node.js version check when cross-compiling to {target}; \
             ensure the bundled runtime is v{pinned}"
        );
        return Ok(());
    }

    let output = Command::new(node_source).arg("--version").output()?;
    if !output.status.success() {
        return Err(format!("failed to run `{} --version`", node_source.display()).into());
    }

    let actual = String::from_utf8(output.stdout)?
        .trim()
        .trim_start_matches('v')
        .to_owned();
    if actual != pinned {
        return Err(format!(
            "bundled Node.js {actual} does not match the package.json devEngines.runtime.version \
             pin {pinned}. Run scripts via pnpm so devEngines (onFail: \"download\") provisions \
             the pinned Node, or update the pin in package.json and regenerate \
             website/src/data/dependencies-runtime.json (node website/scripts/generate-deps.js)."
        )
        .into());
    }

    Ok(())
}

fn resolve_node_binary(host: &str, target: &str) -> Result<PathBuf, Box<dyn Error>> {
    if let Some(path) = env::var_os("MOUSETERM_NODE_BINARY").or_else(|| env::var_os("NODE_BINARY"))
    {
        return Ok(PathBuf::from(path));
    }

    if host != target {
        return Err(format!(
            "cross-compiling the standalone app requires MOUSETERM_NODE_BINARY for target {target}"
        )
        .into());
    }

    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()?;
    if !output.status.success() {
        return Err("failed to locate Node.js via `node -p process.execPath`".into());
    }

    let node_path = String::from_utf8(output.stdout)?.trim().to_owned();
    if node_path.is_empty() {
        return Err("`node -p process.execPath` returned an empty path".into());
    }

    Ok(PathBuf::from(node_path))
}

fn node_binary_name(target: &str) -> String {
    if target.contains("windows") {
        format!("node-{target}.exe")
    } else {
        format!("node-{target}")
    }
}
