#!/bin/zsh
TOKEN=$(cat "$(dirname $0)/.token")
NAME=$1; MSG=$2
OUT="$(dirname $0)/${NAME}.sse"
START=$(python3 -c 'import time; print(time.time())')
curl -sN -m 900 -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' -b "crucible_session=$TOKEN" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "mode": "code", "device": "desktop", "history": []}))' "$MSG")" \
  > "$OUT" 2>&1
END=$(python3 -c 'import time; print(time.time())')
echo "$NAME wall=$(python3 -c "print(f'{$END-$START:.1f}s')") events=$(grep -c '^data:' $OUT)"
