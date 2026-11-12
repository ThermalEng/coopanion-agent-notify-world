#!/bin/sh
# Runtime probes leave the hook's stdin intact and never start desktop executables.
runner=$1
agent=$2
hint=${3-}
unset ELECTRON_RUN_AS_NODE
NODE_OPTIONS=''
export NODE_OPTIONS
marker='__COOPANION_RUNTIME_OK__'
probe="if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22 || typeof fetch !== 'function') process.exit(1); console.log('$marker')"
date_bin=$(command -v date || :)
[ -n "$date_bin" ] || date_bin=/bin/date
sleep_bin=$(command -v sleep || :)
[ -n "$sleep_bin" ] || sleep_bin=/bin/sleep
deadline=$(( $("$date_bin" +%s) + 2 ))

probe_node() {
  "$1" -e "$probe" </dev/null &
  child=$!
  ( "$sleep_bin" 0.5; kill -KILL "$child" 2>/dev/null ) >/dev/null 2>&1 &
  timer=$!
  wait "$child"
  result=$?
  kill "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
  return "$result"
}

seen='
'
try_node() {
  case "${1##*/}" in node|nodejs|node.exe|nodejs.exe) ;; *) return 1 ;; esac
  [ -n "$1" ] && [ -x "$1" ] && [ -f "$1" ] || return 1
  case "$seen" in *"
$1
"*) return 1 ;; esac
  seen="$seen$1
"
  if [ "$("$date_bin" +%s)" -ge "$deadline" ]; then
    printf '%s\n' "Coopanion $agent hook: runtime discovery timed out; no compatible Node.js 22+ found." >&2
    exit 127
  fi
  # Coopanion's Electron wrapper belongs to the app process, not external hooks.
  if command -v grep >/dev/null 2>&1 && grep -q 'CORTICO_NODE_EXE' "$1" 2>/dev/null; then return 1; fi
  output=$(probe_node "$1" 2>/dev/null) || return 1
  [ "$output" = "$marker" ] || return 1
  exec "$1" "$runner" "$agent"
}

for candidate in "${COOPANION_HOOK_NODE-}" "${CODEBUDDY_NODE_BIN-}" "${CODEBUDDY_CODE_NODE_PATH-}" "${NODE_BINARY-}" "${npm_node_execpath-}"; do
  try_node "$candidate"
done

# WorkBuddy publishes a managed-runtime layout; the shared resolver owns its adapter.
if [ "$agent" = workbuddy ]; then
  config=${WORKBUDDY_CONFIG_DIR:-${CODEBUDDY_CONFIG_DIR:-$HOME/.workbuddy}}
  versions="$config/binaries/node/versions"
  current=''
  if [ -r "$versions/current" ]; then IFS= read -r current < "$versions/current" || :; fi
  case "$current" in ''|*[!0-9.]*) current='' ;; esac
  [ -z "$current" ] || try_node "$versions/$current/bin/node"
  for candidate in "$versions"/*/bin/node; do
    case "$candidate" in *.installing.*|*.__extract_temp__*) continue ;; esac
    try_node "$candidate"
  done
  [ -z "${WORKBUDDY_RESOURCES_PATH-}" ] || try_node "$WORKBUDDY_RESOURCES_PATH/runtime/node/bin/node"
fi

# Node-based CLI parents can expose a runtime even when PATH is filtered.
parent=$PPID
for hop in 1 2 3 4; do
  case "$parent" in ''|*[!0-9]*|0|1) break ;; esac
  if command -v readlink >/dev/null 2>&1 && [ -e "/proc/$parent/exe" ]; then
    executable=$(readlink "/proc/$parent/exe" 2>/dev/null)
    case "${executable##*/}" in node|nodejs) try_node "$executable" ;; esac
  elif command -v ps >/dev/null 2>&1; then
    executable=$(ps -p "$parent" -o comm= 2>/dev/null)
    case "${executable##*/}" in node|nodejs) try_node "$executable" ;; esac
  fi
  command -v ps >/dev/null 2>&1 || break
  parent=$(ps -p "$parent" -o ppid= 2>/dev/null | tr -d ' ')
done

# Check nearby standalone runtimes without executing the desktop app or native CLI.
agent_path=$(command -v "$agent" 2>/dev/null || :)
case "$agent_path" in
  /*)
    resolved=$(readlink -f "$agent_path" 2>/dev/null || :)
    [ -z "$resolved" ] || agent_path=$resolved
    bin=${agent_path%/*}
    for root in "$bin" "$bin/.." "$bin/../.."; do
      for candidate in "$root/node" "$root/bin/node" "$root/resources/node" "$root/resources/node/bin/node" "$root/resources/runtime/node/bin/node" "$root/Resources/runtime/node/bin/node"; do
        try_node "$candidate"
      done
    done ;;
esac

remaining=${PATH-}
while :; do
  case "$remaining" in *:*) dir=${remaining%%:*}; remaining=${remaining#*:} ;; *) dir=$remaining; remaining='' ;; esac
  case "$dir" in /*) try_node "$dir/node" ;; esac
  [ -n "$remaining" ] || break
done
for candidate in "${NVM_BIN:+$NVM_BIN/node}" "${FNM_MULTISHELL_PATH:+$FNM_MULTISHELL_PATH/bin/node}" "${VOLTA_HOME:+$VOLTA_HOME/bin/node}" "$HOME/.volta/bin/node" "$HOME/.nvm/versions/node"/*/bin/node "$hint"; do
  try_node "$candidate"
done
printf '%s\n' "Coopanion $agent hook: no compatible Node.js 22+ found in the agent environment, bundled runtime, PATH or installation hint." >&2
exit 127
