#!/bin/sh
set -eu
here=$(dirname -- "$0")
exec /usr/bin/python3 -I "$here/../studio-patches/run-studio.py" test "$@"
