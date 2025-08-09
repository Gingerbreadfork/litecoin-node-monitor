# Litecoin Node Monitor

A lightweight, single-file terminal dashboard for your local `litecoind` Litecoin node.
No dependencies. No external APIs. Just Node.js and JSON-RPC.

## Features

* **Auto-detects** datadir and RPC settings
* **Authenticates** with cookie or credentials from `litecoin.conf`
* **Shows** live sync progress with ETA
* **Displays** blockchain, mempool, network, and bandwidth stats
* **Calculates** halving countdown and supply estimates
* **Lists** top peers by ping
* **Summarizes** session stats on exit
* Works entirely **offline**

## Requirements

* Node.js **16+**
* Running `litecoind` with RPC enabled (`server=1`)

## Usage
Slap it in your node's root directory and then:
```bash
node litecoin-node-monitor.js
```

## How it connects

The monitor looks for a datadir in:

* `~/.litecoin`
* `./data`
* `../data`
* `../../data`

It uses a `.cookie` file when present, or `rpcuser` and `rpcpassword` from `litecoin.conf`.
Supports **mainnet**, **testnet4**, and **regtest**.

## Why this exists

To see clear, real-time Litecoin node stats without installing extra software or sharing data with third parties.
