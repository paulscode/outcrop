#!/bin/bash
# make-snapshot.sh DEST  - build the COLDCARD firmware checkout as a developer had it on 2023-11-13.
#
# Like `git clone --recursive https://github.com/Coldcard/firmware.git` (the README's instructions at that commit), but
# only up to firmware commit ced5f068 (2023-11-13). Every repository, the firmware and each submodule, nested ones
# included, is fetched by the commit it was at. A fetch by commit hash brings that commit and its ancestors, and nothing
# newer. So the real history, authors and messages are all there, and the fix (2026) and anything after the snapshot
# date are not.
#
# Then: master and origin/master at the snapshot commit, the tags that existed then, and every leftover ref, reflog
# and unreachable object removed. File times are left as a fresh clone leaves them (now): set to 2023 against the
# container's 2026 clock, `ls -l` would print the year and mark the files as old. The script checks that no commit in any
# repository is newer than 2023-11-13, and fails if one is.
set -euo pipefail
DEST=$1
TOP_URL=https://github.com/Coldcard/firmware.git
TOP_SHA=ced5f068b1d100792c6a7082d47af1654835e4b5
CUTOFF=2023-11-14T00:00:00Z          # nothing committed on or after this
[ -e "$DEST" ] && { echo "$DEST exists" >&2; exit 2; }

fetch_at() {  # dir url sha: a repository holding sha and its ancestors only, checked out detached (as submodules are)
  git init -q "$1"
  git -C "$1" remote add origin "$2"
  git -C "$1" fetch -q --no-tags origin "$3"
  git -C "$1" -c advice.detachedHead=false checkout -q --detach "$3"
}

clean() {  # dir: drop FETCH_HEAD, reflogs and anything unreachable
  rm -f "$1/.git/FETCH_HEAD" 2>/dev/null || true
  git -C "$1" reflog expire --expire=now --all
  git -C "$1" gc -q --prune=now
}

submodules() {  # dir: fetch each submodule at its pinned commit, then the submodule's own submodules
  local dir=$1 path sha url name
  [ -f "$dir/.gitmodules" ] || return 0
  git -C "$dir" submodule init -q
  git -C "$dir" submodule status | while read -r sha path _; do
    sha=${sha#[-+U]}
    # the config is keyed by the submodule's name, which need not be its path (pico-sdk: "tinyusb" at lib/tinyusb)
    name=$(git -C "$dir" config -f .gitmodules --get-regexp '^submodule\..*\.path$' |
           awk -v p="$path" '$2 == p { sub(/^submodule\./, "", $1); sub(/\.path$/, "", $1); print $1 }')
    url=$(git -C "$dir" config "submodule.$name.url")
    echo "  $dir/$path @ ${sha:0:10}  ($url)"
    fetch_at "$dir/$path" "$url" "$sha"
    clean "$dir/$path"
    submodules "$dir/$path"
  done
  git -C "$dir" submodule absorbgitdirs >/dev/null 2>&1     # .git directories into .git/modules, as `clone --recursive` leaves them
}

echo "firmware @ ${TOP_SHA:0:10}"
fetch_at "$DEST" "$TOP_URL" "$TOP_SHA"
# the tags a clone made that day would have had: those pointing at commits we already hold
# (ls-remote lists each annotated tag twice: the tag object, then "^{}" with the commit it points to)
git -C "$DEST" ls-remote --tags origin | python3 -c '
import sys
tags = {}
for line in sys.stdin:
    sha, ref = line.split()
    if ref.endswith("^{}"): tags[ref[:-3]] = sha
    else: tags.setdefault(ref, sha)
for ref, sha in sorted(tags.items()): print(sha, ref)' | while read -r sha ref; do
  if git -C "$DEST" merge-base --is-ancestor "$sha" "$TOP_SHA" 2>/dev/null; then
    git -C "$DEST" fetch -q --no-tags origin "+$ref:$ref"
  fi
done
git -C "$DEST" checkout -q -B master "$TOP_SHA"
git -C "$DEST" update-ref refs/remotes/origin/master "$TOP_SHA"
git -C "$DEST" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master
git -C "$DEST" branch -q -u origin/master master
clean "$DEST"
submodules "$DEST"

# check every repository: nothing newer than the cutoff, a clean tree
fail=0
while read -r g; do
  repo=$(dirname "$g")
  newest=$(git -C "$repo" log --all --format=%cI | sort | tail -1)
  n=$(git -C "$repo" rev-list --all | wc -l)
  printf '  %-60s %6s commits, newest %s\n' "${repo#$DEST}" "$n" "$newest"
  [[ $(date -ud "$newest" +%s) -lt $(date -ud "$CUTOFF" +%s) ]] || { echo "  !! newer than $CUTOFF" >&2; fail=1; }
done < <(find "$DEST" -name .git -not -path '*/.git/*')
git -C "$DEST" status --porcelain --ignore-submodules=none | head -5
[ "$fail" = 0 ] && echo "ok: $(du -sh "$DEST" | cut -f1)"
exit $fail
