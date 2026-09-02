#!/bin/bash
# Builds VegasPrint.exe from macOS or Linux.
#
# Node's single-executable support lets us inject the agent into an official
# node.exe, which is why this can cross-compile at all — pkg and nexe both need
# a Windows machine.
set -e
cd "$(dirname "$0")"
NODE_VER="v20.20.2"   # must match the node that generates the blob

echo "1/5 bundling"
npx --yes esbuild agent.cjs --bundle --platform=node --target=node20 --outfile=build/bundle.cjs

echo "2/5 preparing the blob"
(cd build && node --experimental-sea-config sea-config.json)

echo "3/5 fetching node.exe $NODE_VER"
[ -f "build/node-$NODE_VER-win-x64/node.exe" ] || (
  cd build
  curl -sL -o node-win.zip "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
  unzip -o -q node-win.zip "node-$NODE_VER-win-x64/node.exe"
)
cp "build/node-$NODE_VER-win-x64/node.exe" dist/VegasPrint.exe

echo "4/5 removing node's signature"
node build/strip-signature.mjs dist/VegasPrint.exe

echo "5/5 injecting the agent"
npx --yes postject dist/VegasPrint.exe NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo "dist/VegasPrint.exe  $(du -h dist/VegasPrint.exe | cut -f1)"
