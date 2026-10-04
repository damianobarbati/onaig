#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir=${BESU_NETWORK_DIR:-"$repo_dir/.besu-network"}
image=${BESU_IMAGE:-hyperledger/besu:26.8.1}

mkdir -p "$output_dir"
rm -rf "$output_dir/networkFiles"

generator_log=$(mktemp)
if ! docker run --rm \
    -v "$repo_dir/k8s:/config:ro" \
    -v "$output_dir:/out" \
    "$image" \
    operator generate-blockchain-config \
    --config-file=/config/besu-network-config.json \
    --to=/out/networkFiles \
    --private-key-file-name=key >"$generator_log" 2>&1; then
  if [[ ! -f "$output_dir/networkFiles/genesis.json" ]]; then
    cat "$generator_log" >&2
    rm -f "$generator_log"
    exit 1
  fi
fi
rm -f "$generator_log"

key_dir=$(find "$output_dir/networkFiles/keys" -mindepth 1 -maxdepth 1 -type d -print -quit)
if [[ -z "$key_dir" ]]; then
  echo "Besu did not generate a validator key" >&2
  exit 1
fi

cp "$output_dir/networkFiles/genesis.json" "$output_dir/genesis.json"

cp "$key_dir/key" "$output_dir/node.key"
cp "$key_dir/key.pub" "$output_dir/node.key.pub"

echo "Generated Besu network in $output_dir"
echo "Validator address: $(basename "$key_dir")"
echo
echo "Create/update Kubernetes resources with:"
echo "  kubectl -n onaig create configmap besu-genesis --from-file=genesis.json=$output_dir/genesis.json --dry-run=client -o yaml | kubectl apply -f -"
echo "  kubectl -n onaig create secret generic besu-validator-key --from-file=node.key=$output_dir/node.key --dry-run=client -o yaml | kubectl apply -f -"
echo "Then apply k8s/5-blockchain.yml."
