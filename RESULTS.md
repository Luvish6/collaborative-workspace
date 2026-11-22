# Reproducible results

Run `npm ci && npm run build`, `npm test`, and `npm run bench` from the repository root.

## Local edit delivery

Windows x64, AMD Ryzen 7 7840HS, Node.js v22.15.0. One server using file-backed SQLite and WebSocket clients over loopback in the same Node process. Each scenario sent 20 waves at 100 ms intervals. Every client contributed one distinct text edit per wave, waited for the durable server acknowledgement and verified its edit arrived at every other client. Each scenario finished with all documents exactly equal. Latency includes durable storage and fan-out. Throughput is the delivered edit rate at the offered load. These measurements do not estimate production latency or maximum capacity.

| Concurrent clients | Edits delivered | Edits/s | p50 | p95 |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 40 | 20.0 | 5.19 ms | 8.05 ms |
| 8 | 160 | 79.6 | 25.35 ms | 39.44 ms |
| 16 | 320 | 159.8 | 65.05 ms | 85.92 ms |

The browser bundle measured 83.5 KiB uncompressed in the esbuild report. All six integration tests passed for origin enforcement, room isolation, concurrent edits, presence, offline merge, database restart recovery, and invalid or oversized updates.
