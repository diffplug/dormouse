# Dormouse PowerShell shell integration (OSC 633).
#
# Delivered via `pwsh -NoExit -Command ". '<this>'"` (also `powershell.exe` for
# Windows PowerShell). Dormouse omits `-NoProfile`, so the user's profile loads
# first and defines their `prompt`; we then dot-source this file, which captures
# that prompt and wraps it so every render emits the OSC 633 prompt/command
# boundaries. `-NoExit` keeps the session interactive afterwards.
#
# PowerShell has no `preexec` hook, so — like VS Code's PowerShell integration —
# we report a command's line (E), output-start (C) and exit (D) from the *next*
# prompt render, reading the command from history and the status from `$?` /
# `$LASTEXITCODE`. Boundaries and exit codes are exact; the C/D markers land at
# the following prompt rather than bracketing the output in real time.

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

# History id of the most recently reported command, so the next prompt knows
# whether a new command actually ran. -1 means "no command reported yet" — the
# first prompt must not emit a D for a command that never happened.
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

	# Get-History resets $?, which is why the status was captured above.
	$lastHistory = Get-History -Count 1
	$result = ''

	# Report the previous command, unless this is the first prompt (id -1) or no
	# new command ran since the last prompt (e.g. an empty line or Ctrl+C).
	if ($Global:__dormouse_633_last_history_id -ne -1 -and
		$null -ne $lastHistory -and
		$lastHistory.Id -ne $Global:__dormouse_633_last_history_id) {
		$result += __dormouse_633_osc "E;$(__dormouse_633_escape $lastHistory.CommandLine)"
		$result += __dormouse_633_osc 'C'
		$result += __dormouse_633_osc "D;$exitCode"
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

	# The user's prompt text, then prompt-end / input-start (B).
	$result += $Global:__dormouse_633_original_prompt.Invoke()
	$result += __dormouse_633_osc 'B'

	if ($null -ne $lastHistory) {
		$Global:__dormouse_633_last_history_id = $lastHistory.Id
	}
	return $result
}
