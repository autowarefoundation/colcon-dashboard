#!/usr/bin/env bash
# Build and upload signed source packages to the PPA, one per Ubuntu series.
#
# Run from the repository root, after a release tag. Signing prompts for the
# GPG passphrase, so this script runs on the maintainer's machine, not in CI.
#
#   scripts/ppa-release.sh                  # noble, ppa:xmfcx/colcon-dashboard
#   SERIES="noble=24.04 jammy=22.04" scripts/ppa-release.sh
#   PPA=ppa:someone/else scripts/ppa-release.sh
#
# SERIES entries are <codename>=<release number>; the number becomes the
# ~ubuntuNN.NN.1 version suffix (numbers sort reliably across series,
# codenames wrap around the alphabet).

set -euo pipefail

PPA=${PPA:-ppa:xmfcx/colcon-dashboard}
SERIES=${SERIES:-noble=24.04}

version=$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' colcon_dashboard/__init__.py)

restore() { git checkout --quiet debian/changelog; }
trap restore EXIT

for entry in $SERIES; do
    series="${entry%%=*}"
    release="${entry#*=}"
    if [ "$series" = "$release" ]; then
        echo "SERIES entries must be <codename>=<release>, got '$entry'" >&2
        exit 1
    fi
    deb_version="${version}ppa1~ubuntu${release}.1"
    cat > debian/changelog <<EOF
colcon-dashboard (${deb_version}) ${series}; urgency=medium

  * New upstream release.

 -- Mete Fatih Cırıt <mfc@autoware.org>  $(date -R)
EOF
    debuild -S -sa
    dput "$PPA" "../colcon-dashboard_${deb_version}_source.changes"
done
