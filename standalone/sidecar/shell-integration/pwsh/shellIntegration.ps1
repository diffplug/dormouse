# Dormouse PowerShell shell integration (OSC 633).
#
# Delivered via `pwsh -NoExit -Command ". '<this>'"` (also `powershell.exe` for
# Windows PowerShell). Dormouse omits `-NoProfile`, so the user's profile loads
# first and defines their `prompt`; we then dot-source this file, which captures
# that prompt and wraps it so every render emits the OSC 633 prompt/command
# boundaries.
#
# Command start is reported the way bash/zsh report it from `preexec`: PowerShell
# has no preexec, but PSReadLine's `PSConsoleHostReadLine` is called to read each
# command line *before* it executes, so we wrap it to emit E (command line) and C
# (command start) up front — making the running command show immediately. The
# matching D (finished, with exit code) is emitted from the next `prompt` render,
# like a zsh `precmd`. If PSReadLine is unavailable we fall back to reporting the
# whole E/C/D triple from the next prompt (command from history); boundaries and
# exit codes stay exact, but the running command won't show until it finishes.

# Only wire up hooks once, even if this file is dot-sourced again. A session
# global (not an env var) so it isn't inherited by child processes — matching the
# bash/zsh guards, which are shell-local.
if ($Global:__dormouse_633_installed) {
	return
}
$Global:__dormouse_633_installed = $true

# ESC and BEL: OSC is `ESC ] 633 ; ... BEL`, matching the bash/zsh emitters.
$Global:__dormouse_633_esc = [char]0x1b
$Global:__dormouse_633_bel = [char]0x07

# Wrap an OSC 633 body (e.g. "C", "D;0", "P;Cwd=...") in the ESC...BEL framing.
function Global:__dormouse_633_osc([string]$body) {
	return "$($Global:__dormouse_633_esc)]633;$body$($Global:__dormouse_633_bel)"
}

# A rehydrated Tool's payload belongs to its first command alone
# (docs/specs/dor-tool.md -> Reaping); no later command inherits it. Ignore,
# not SilentlyContinue: every later prompt finds it gone, and SilentlyContinue
# still records that in the user's $Error.
function Global:__dormouse_633_clear_dehydrate {
	Remove-Item Env:DORMOUSE_DEHYDRATE -ErrorAction Ignore
	# WSL sets every name WSLENV lists in the distro, a missing one as empty.
	if ($env:WSLENV) { $env:WSLENV = (@($env:WSLENV -split ':') | Where-Object { ($_ -split '/')[0] -ne 'DORMOUSE_DEHYDRATE' }) -join ':' }
}

# Preserve the user's prompt so we can chain to it. `$function:prompt` is the
# prompt as it stands after the profile ran; if the user defined none, this is
# PowerShell's built-in default.
$Global:__dormouse_633_original_prompt = $function:prompt

# Set true once we've wrapped PSConsoleHostReadLine (the preexec path); when true,
# E/C come from that wrapper and the prompt emits only D.
$Global:__dormouse_633_readline_hooked = $false
# Set by the readline wrapper when a non-empty command is submitted; the next
# prompt emits its D and clears this. Mirrors bash's `__dormouse_633_ran`.
$Global:__dormouse_633_command_running = $false
# Fallback path only (no PSReadLine): history id of the last reported command, so
# the next prompt knows whether a new command actually ran. -1 = nothing reported
# yet, so the genuine first prompt emits no D.
$Global:__dormouse_633_last_history_id = -1
# Note $LASTEXITCODE and the newest error as each prompt finishes, so the next
# prompt can tell whether the command since then set either (see `prompt`).
function Global:__dormouse_633_note_status {
	$Global:__dormouse_633_exit_before = $global:LASTEXITCODE
	$Global:__dormouse_633_error_before = $null
	if ($Global:Error.Count -gt 0) { $Global:__dormouse_633_error_before = $Global:Error[0] }
}
__dormouse_633_note_status

# Escape a value for OSC 633 transport. The parser splits the E command field on
# the first raw ';' then decodes \\ and \xNN, so backslash and semicolon must be
# escaped; newlines/CR are escaped to keep the sequence single-line. Backslash
# must be replaced first, exactly as in the bash/zsh scripts.
function Global:__dormouse_633_escape([string]$value) {
	if ($null -eq $value) { return '' }
	$value = $value.Replace('\', '\\')
	$value = $value.Replace(';', '\x3b')
	$value = $value.Replace("`n", '\x0a')
	$value = $value.Replace("`r", '\x0d')
	# BEL, CAN, SUB, ESC (which begins ST) and the C1 ST end an OSC string and so
	# must not survive; docs/specs/terminal-state.md -> "Shell-integration injection" has the why. Escaping
	# costs nothing here because the parser decodes \xNN back. Written as char
	# codes rather than `a/`e so this still works on Windows PowerShell 5.1, where
	# `e does not exist.
	$value = $value.Replace([string][char]0x07, '\x07')
	$value = $value.Replace([string][char]0x18, '\x18')
	$value = $value.Replace([string][char]0x1a, '\x1a')
	$value = $value.Replace([string][char]0x1b, '\x1b')
	$value = $value.Replace([string][char]0x9c, '\x9c')
	return $value
}

# Reduce a value for the `Cwd=` field. Unlike E, the parser reads Cwd= verbatim
# — no \xNN decoding, so a Windows path's backslashes arrive intact — which
# rules out escaping, so the terminators are removed instead. \p{Cc} is the
# Unicode control category, covering C0, DEL, and the C1 range including the
# U+009C that bash/zsh have to strip separately.
function Global:__dormouse_633_safe_cwd([string]$value) {
	if ($null -eq $value) { return '' }
	return ($value -replace '\p{Cc}', '')
}

# Wrap PSReadLine's line reader so a submitted command emits E (command line) and
# C (command start) before it runs. Idempotent and a no-op when PSReadLine isn't
# loaded; retried from `prompt` because PSReadLine may import after this script
# dot-sources (it's only guaranteed present once the interactive REPL is reading).
function Global:__dormouse_633_hook_readline {
	if ($Global:__dormouse_633_readline_hooked) { return }
	if (-not (Get-Command -Name PSConsoleHostReadLine -ErrorAction SilentlyContinue)) { return }

	$Global:__dormouse_633_original_readline = $function:PSConsoleHostReadLine
	function Global:PSConsoleHostReadLine {
		$commandLine = $Global:__dormouse_633_original_readline.Invoke()
		# Skip blank submissions (bare Enter, Ctrl+C) — no command runs, so no D.
		if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
			# Through the host, as the prompt's own text goes, never [Console]::Write:
			# on Windows that encodes in the console's output code page (OEM), which
			# turns most of Unicode into '?'.
			$Host.UI.Write((__dormouse_633_osc "E;$(__dormouse_633_escape $commandLine)") + (__dormouse_633_osc 'C'))
			$Global:__dormouse_633_command_running = $true
		}
		return $commandLine
	}
	$Global:__dormouse_633_readline_hooked = $true
}

# Best effort at dot-source time; `prompt` retries until it takes.
__dormouse_633_hook_readline

function Global:prompt() {
	# Capture exit status FIRST, before any command below clobbers $? / $LASTEXITCODE.
	$succeeded = $?
	$nativeExit = $global:LASTEXITCODE

	# $? only distinguishes success from failure, so a failure reports a generic 1
	# unless $LASTEXITCODE is the command's own: it changed since the last prompt,
	# or it is non-zero and the command recorded no PowerShell error (a native
	# command that exits the same code again). A cmdlet that fails after a native
	# command leaves that command's stale code there and an error in $Error.
	$exitCode = 0
	if (-not $succeeded) {
		$exitCode = 1
		$exitChanged = -not [object]::Equals($nativeExit, $Global:__dormouse_633_exit_before)
		$newError = $Global:Error.Count -gt 0 -and -not [object]::ReferenceEquals($Global:Error[0], $Global:__dormouse_633_error_before)
		if ($null -ne $nativeExit -and $nativeExit -ne 0 -and ($exitChanged -or -not $newError)) {
			$exitCode = $nativeExit
		}
	}

	__dormouse_633_hook_readline
	$result = ''

	if ($Global:__dormouse_633_readline_hooked) {
		# E and C were emitted by the readline wrapper before the command ran;
		# here we just finish the command that was running.
		if ($Global:__dormouse_633_command_running) {
			$result += __dormouse_633_osc "D;$exitCode"
			$Global:__dormouse_633_command_running = $false
			__dormouse_633_clear_dehydrate
		}
	} else {
		# No PSReadLine: report the whole previous command (E/C/D) from history,
		# unless this is the first prompt or no new command ran since the last one.
		$lastHistory = Get-History -Count 1
		if ($Global:__dormouse_633_last_history_id -ne -1 -and
			$null -ne $lastHistory -and
			$lastHistory.Id -ne $Global:__dormouse_633_last_history_id) {
			$result += __dormouse_633_osc "E;$(__dormouse_633_escape $lastHistory.CommandLine)"
			$result += __dormouse_633_osc 'C'
			$result += __dormouse_633_osc "D;$exitCode"
			__dormouse_633_clear_dehydrate
		}
		# Clear the -1 sentinel on every render (history ids start at 1, so 0 never
		# matches a real command) so the first real command is reported next prompt.
		$Global:__dormouse_633_last_history_id = if ($null -ne $lastHistory) { $lastHistory.Id } else { 0 }
	}

	# Prompt start (A) and cwd (P). ProviderPath is the real filesystem path even
	# when the current location is on a PSDrive. Only a FileSystem location is a
	# directory a new pane can start in: a registry or Env: location reports none.
	# Unescaped is not unfiltered — see __dormouse_633_safe_cwd above for why Cwd=
	# is reduced rather than escaped.
	$location = Get-Location
	$cwd = $null
	if ($location.Provider.Name -eq 'FileSystem') {
		$cwd = __dormouse_633_safe_cwd $location.ProviderPath
	}
	$result += __dormouse_633_osc 'A'
	if ($cwd) {
		$result += __dormouse_633_osc "P;Cwd=$cwd"
	}

	# The user's prompt text, then prompt-end / input-start (B). Get-* and the
	# assignments above set $? to $True, and prompts such as starship and
	# oh-my-posh read $? before $LASTEXITCODE to show a failed command, so put a
	# failure back first: Write-Error with -ErrorAction Ignore sets $? to $False
	# without printing anything or adding to $Error. Nothing here reassigns
	# $LASTEXITCODE.
	if (-not $succeeded) {
		Write-Error 'failure' -ErrorAction Ignore
	}
	$result += $Global:__dormouse_633_original_prompt.Invoke()
	$result += __dormouse_633_osc 'B'
	# After the user's prompt, which may run a native command of its own.
	__dormouse_633_note_status
	return $result
}
