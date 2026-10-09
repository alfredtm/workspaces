export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
ZSH_DISABLE_COMPFIX=true
plugins=(git golang npm)
[ -f "$ZSH/oh-my-zsh.sh" ] && source "$ZSH/oh-my-zsh.sh"

export GOPATH="$HOME/go"
export PATH="$GOPATH/bin:/usr/local/go/bin:$PATH"

alias g="git"
alias c="env -u BROWSER -u DISPLAY claude"
alias ll="ls -la"

# Welcome message
echo ""
echo "  \033[1;36m⬡ Workspaces\033[0m"
echo ""
printf "  \033[1m%-14s\033[0m %s\n" "claude"        "start Claude Code  (alias: c)"
printf "  \033[1m%-14s\033[0m %s\n" "opencode"      "start OpenCode"
printf "  \033[1m%-14s\033[0m %s\n" "gh auth login" "connect GitHub"
printf "  \033[1m%-14s\033[0m %s\n" "postgres"      "postgres://dev:dev@localhost:5432/dev"
echo ""
