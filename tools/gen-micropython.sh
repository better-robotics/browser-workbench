#!/usr/bin/env bash
# Vendor MicroPython's embed port into the firmware as an ESP-IDF component.
#
# The generated tree — components/micropython_embed/{py,extmod,shared,genhdr,
# port} — is gitignored and reproducible from here; only our mpconfigport.h and
# CMakeLists.txt are committed. Pinned so the baked qstr tables and VM core
# can't drift under the firmware. Our mpconfigport.h drives the generation, so
# the qstr tables match exactly what the firmware compiles against.
#
# Run before building any board that embeds the Python VM (s3_cam). build.sh
# does this automatically; for a local `make compile` on an S3 target, run this
# once first.
set -euo pipefail

MPY_VERSION="${MPY_VERSION:-v1.26.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT="$HERE/firmware/esp32_robot_idf/components/micropython_embed"
CACHE="${MPY_CACHE:-$HOME/.cache/br-micropython}"
CLONE="$CACHE/micropython-$MPY_VERSION"

if [ ! -d "$CLONE/.git" ]; then
  mkdir -p "$CACHE"
  echo "cloning micropython ${MPY_VERSION}..."
  git clone --depth 1 --branch "$MPY_VERSION" https://github.com/micropython/micropython.git "$CLONE"
fi

# Our config drives qstr collection — copy it in before generating so the baked
# qstr tables match what the firmware links against.
cp "$COMPONENT/mpconfigport.h" "$CLONE/examples/embedding/mpconfigport.h"

make -C "$CLONE/examples/embedding" -f micropython_embed.mk clean >/dev/null 2>&1 || true
make -C "$CLONE/examples/embedding" -f micropython_embed.mk

# Refresh generated sources into the component; keep our committed files.
GEN="$CLONE/examples/embedding/micropython_embed"
rm -rf "$COMPONENT/py" "$COMPONENT/extmod" "$COMPONENT/shared" "$COMPONENT/genhdr" "$COMPONENT/port"
cp -R "$GEN/py" "$GEN/extmod" "$GEN/shared" "$GEN/genhdr" "$GEN/port" "$COMPONENT/"
echo "micropython_embed: generated from ${MPY_VERSION} -> components/micropython_embed/"
