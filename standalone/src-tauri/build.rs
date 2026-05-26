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

    println!("cargo:rerun-if-changed={}", node_source.display());
    validate_node_binary(&node_source, &target)?;

    // The supply-chain page (website/src/data/dependencies-runtime.json) discloses
    // an exact Node.js version. Fail the build if the binary we're about to bundle
    // doesn't match standalone/.node-version, so the disclosed version provably
    // equals what ships. CI installs the pin via setup-node's node-version-file.
    let pinned_version = read_pinned_node_version(&manifest_dir)?;
    verify_node_version(&node_source, &host, &target, &pinned_version)?;

    let binaries_dir = manifest_dir.join("binaries");
    fs::create_dir_all(&binaries_dir)?;

    let node_dest = binaries_dir.join(node_binary_name(&target));
    fs::copy(&node_source, &node_dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut perms = fs::metadata(&node_dest)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&node_dest, perms)?;
    }

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
    let pin_path = manifest_dir
        .parent()
        .ok_or("manifest dir has no parent")?
        .join(".node-version");
    println!("cargo:rerun-if-changed={}", pin_path.display());

    let raw = fs::read_to_string(&pin_path)
        .map_err(|err| format!("failed to read {}: {err}", pin_path.display()))?;
    let version = raw.trim().trim_start_matches('v').to_owned();

    let is_exact = version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if !is_exact {
        return Err(format!(
            "{} must pin an exact Node.js version (MAJOR.MINOR.PATCH), found {version:?}",
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
            "bundled Node.js {actual} does not match the standalone/.node-version pin {pinned}. \
             Install the pinned version (CI uses actions/setup-node with \
             node-version-file: standalone/.node-version) or update the pin and regenerate \
             website/src/data/dependencies-runtime.json."
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
