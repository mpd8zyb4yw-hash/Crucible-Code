#!/bin/sh
cd /Users/justin/crucible-local
exec /Users/justin/crucible-local/node_modules/.bin/vite --port "${PORT:-5173}"
