export NODE="${NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
  echo 'Install Node.js 22 or newer, or set NODE.' >&2
  return 1
fi
