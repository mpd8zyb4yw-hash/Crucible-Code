#!/bin/zsh
# cont.89: can a SMALL model copy z.ipv4() out of clean evidence? Bonsai does (3/3) but costs
# ~150s/repair. If a 1.5-3B does it, repair gets ~8x cheaper. Same fixture as cont.88.
cd ~/crucible-local/crucible-local/.crucible/prismml-bin
EV=$(python3 -c "print(open('$HOME/crucible-local/crucible-local/audit-traces/p4/t9.evidence.txt').read())")
for M in qwen2.5-1.5b-instruct-q4_k_m phi-3.5-mini-instruct-q4_k_m gemma-2-2b-it-q4_k_m; do
  pkill -f "llama-server -m" 2>/dev/null; sleep 2
  nohup ./llama-server -m "../models/${M}.gguf" --jinja -ngl 0 -c 4096 -t 4 --host 127.0.0.1 --port 8080 > /tmp/sm.log 2>&1 &
  ok=0; t=0
  until curl -s -m 2 http://127.0.0.1:8080/health 2>/dev/null | grep -q '"status":"ok"'; do sleep 2; t=$((t+2)); [[ $t -gt 60 ]] && break; done
  if ! curl -s -m 2 http://127.0.0.1:8080/health 2>/dev/null | grep -q '"status":"ok"'; then echo "${M}  LOAD-FAIL"; continue; fi
  for i in 1 2 3; do
    python3 -c "
import json,sys
ev=open('$HOME/crucible-local/crucible-local/audit-traces/p4/t9.evidence.txt').read()
sys='You are a precise coding assistant. Use ONLY APIs that appear in the EVIDENCE. Answer with one short code block and at most one sentence.'
print(json.dumps({'model':'m','messages':[{'role':'system','content':sys},{'role':'user','content':'Question: Write a Zod schema that validates an IPv4 address\n\n## EVIDENCE\n'+ev}],'max_tokens':300,'temperature':0.2,'seed':1000+$i,'chat_template_kwargs':{'enable_thinking':False}}))" > /tmp/sm_req.json
    R=$(curl -s -m 300 -X POST http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d @/tmp/sm_req.json | python3 -c "import sys,json;d=json.load(sys.stdin);print((d['choices'][0]['message'].get('content') or '').replace(chr(10),'\\\\n'))" 2>/dev/null)
    echo "$R" > "$HOME/crucible-local/crucible-local/audit-traces/p8/small-${M}-${i}.txt"
    echo "$R" | grep -qE '\.\s*ipv4\s*\(' && ok=$((ok+1))
  done
  SPD=$(grep -oE "[0-9.]+ tokens per second" /tmp/sm.log | tail -1)
  echo "${M}  copies_ipv4=${ok}/3  ${SPD}"
done
pkill -f "llama-server -m" 2>/dev/null
