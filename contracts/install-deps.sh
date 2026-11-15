#!/usr/bin/env bash
# Installs pinned contract dependencies into contracts/lib (not committed). Run from contracts/ in Git Bash, WSL or Linux.
set -euo pipefail
pin() { # repo commit dir
  rm -rf "lib/$3" && git clone --quiet "https://github.com/$1" "lib/$3" && git -C "lib/$3" checkout --quiet "$2" && rm -rf "lib/$3/.git"
}
mkdir -p lib
pin foundry-rs/forge-std 15b2df92a05d4d2f76a06653872fefb287e0e01c forge-std
pin morpho-org/morpho-blue 339a885801972740eb27f51da110a4675b839d42 morpho-blue
pin Reactive-Network/reactive-lib-omni 3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8 reactive-lib-omni
pin OpenZeppelin/openzeppelin-contracts 7df9390d5989ea2cb7a70ad93f96245d8a82574e openzeppelin-contracts
echo "Dependencies installed."
