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
	return $value
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
			[Console]::Write((__dormouse_633_osc "E;$(__dormouse_633_escape $commandLine)"))
			[Console]::Write((__dormouse_633_osc 'C'))
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

	# $? only distinguishes success from failure; fall back to a native exit code
	# when a failing external command set one, else a generic 1.
	if ($succeeded) {
		$exitCode = 0
	} elseif ($null -ne $nativeExit -and $nativeExit -ne 0) {
		$exitCode = $nativeExit
	} else {
		$exitCode = 1
	}

	__dormouse_633_hook_readline
	$result = ''

	if ($Global:__dormouse_633_readline_hooked) {
		# E and C were emitted by the readline wrapper before the command ran;
		# here we just finish the command that was running.
		if ($Global:__dormouse_633_command_running) {
			$result += __dormouse_633_osc "D;$exitCode"
			$Global:__dormouse_633_command_running = $false
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
		}
		# Clear the -1 sentinel on every render (history ids start at 1, so 0 never
		# matches a real command) so the first real command is reported next prompt.
		$Global:__dormouse_633_last_history_id = if ($null -ne $lastHistory) { $lastHistory.Id } else { 0 }
	}

	# Prompt start (A) and cwd (P). ProviderPath is the real filesystem path even
	# when the current location is on a PSDrive. The cwd is sent raw — like the
	# bash/zsh emitters' $PWD — because the parser reads Cwd= verbatim (no \xNN
	# decoding); a Windows path's backslashes must reach it unescaped.
	$cwd = (Get-Location).ProviderPath
	$result += __dormouse_633_osc 'A'
	if ($cwd) {
		$result += __dormouse_633_osc "P;Cwd=$cwd"
	}

	# The user's prompt text, then prompt-end / input-start (B). Note: $? is always
	# $True here because Get-* and the assignments above clobbered it, so a prompt
	# that colors itself off $? sees success regardless. $LASTEXITCODE survives
	# (nothing reassigns it), so starship-style prompts are unaffected.
	$result += $Global:__dormouse_633_original_prompt.Invoke()
	$result += __dormouse_633_osc 'B'
	return $result
}
