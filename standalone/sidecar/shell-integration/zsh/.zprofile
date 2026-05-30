# Dormouse zsh shell integration — login profile (.zprofile).
# Only read for login shells; chain to the user's and re-pin ZDOTDIR to ours so
# our .zshrc still loads.
: ${USER_ZDOTDIR:=$HOME}
if [[ -f ${USER_ZDOTDIR}/.zprofile ]]; then
  builtin source ${USER_ZDOTDIR}/.zprofile
fi
ZDOTDIR=${DORMOUSE_ZDOTDIR}
