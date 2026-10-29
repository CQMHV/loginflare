# Local scale benchmark

Run: 2026-10-28T19-37-38.062Z-22fe12

Local Miniflare/SQLite results only; not a Cloudflare latency SLA or billed-read estimate.

Deterministic round-robin mixed workload; operation requests/s are contributions within the mixed stage, not isolated maximum throughputs.

Node: v24.22.1; CPU: AMD Ryzen 5 5600 6-Core Processor              ; logical CPUs: 12; RAM: 31.9 GiB.

| Users | Operation | Concurrency | Mixed requests/s | p50 ms | p95 ms | p99 ms | Errors | SQL/request |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 10 | userFirst | 1 | 5.63 | 18.74 | 25.37 | 30.98 | 0 | 4.00 |
| 10 | userDeepSeek | 1 | 5.63 | 18.91 | 26.30 | 32.12 | 0 | 4.00 |
| 10 | userExactLookup | 1 | 5.63 | 18.45 | 25.79 | 30.92 | 0 | 4.00 |
| 10 | sessionValidation | 1 | 5.63 | 23.11 | 31.07 | 36.04 | 0 | 5.00 |
| 10 | sessionList | 1 | 5.63 | 22.10 | 28.52 | 33.58 | 0 | 5.00 |
| 10 | applicationList | 1 | 5.63 | 18.53 | 24.59 | 30.79 | 0 | 4.00 |
| 10 | applicationOrigin | 1 | 5.63 | 4.75 | 7.06 | 8.92 | 0 | 1.00 |
| 10 | atomicRateLimit | 1 | 5.63 | 5.26 | 7.10 | 11.26 | 0 | 1.00 |
| 10 | refreshProtocol | 1 | 5.63 | 41.60 | 52.50 | 58.30 | 0 | 10.00 |
| 10 | userFirst | 10 | 5.52 | 180.37 | 250.43 | 275.03 | 0 | 4.00 |
| 10 | userDeepSeek | 10 | 5.52 | 203.84 | 302.22 | 318.50 | 0 | 4.00 |
| 10 | userExactLookup | 10 | 5.56 | 198.10 | 254.19 | 287.39 | 0 | 4.00 |
| 10 | sessionValidation | 10 | 5.52 | 192.03 | 287.47 | 311.90 | 0 | 5.00 |
| 10 | sessionList | 10 | 5.52 | 198.38 | 269.73 | 309.03 | 0 | 5.00 |
| 10 | applicationList | 10 | 5.56 | 200.81 | 279.40 | 308.88 | 0 | 4.00 |
| 10 | applicationOrigin | 10 | 5.49 | 190.95 | 270.77 | 307.14 | 0 | 1.00 |
| 10 | atomicRateLimit | 10 | 5.52 | 182.39 | 254.38 | 280.52 | 0 | 1.00 |
| 10 | refreshProtocol | 10 | 5.49 | 216.75 | 301.53 | 342.54 | 0 | 10.00 |
| 10 | userFirst | 50 | 5.75 | 943.98 | 1169.13 | 1238.12 | 0 | 4.00 |
| 10 | userDeepSeek | 50 | 5.78 | 960.66 | 1207.71 | 1238.23 | 0 | 4.00 |
| 10 | userExactLookup | 50 | 5.81 | 957.00 | 1200.22 | 1238.33 | 0 | 4.00 |
| 10 | sessionValidation | 50 | 5.85 | 941.16 | 1201.76 | 1261.53 | 0 | 5.00 |
| 10 | sessionList | 50 | 5.88 | 955.75 | 1195.70 | 1240.27 | 0 | 5.00 |
| 10 | applicationList | 50 | 5.88 | 937.82 | 1195.86 | 1239.24 | 0 | 4.00 |
| 10 | applicationOrigin | 50 | 5.81 | 898.23 | 1079.94 | 1220.70 | 0 | 1.00 |
| 10 | atomicRateLimit | 50 | 5.81 | 937.87 | 1194.86 | 1235.55 | 0 | 1.00 |
| 10 | refreshProtocol | 50 | 5.75 | 963.76 | 1164.05 | 1234.34 | 0 | 10.00 |
| 100000 | userFirst | 1 | 5.87 | 17.85 | 24.67 | 29.88 | 0 | 4.00 |
| 100000 | userDeepSeek | 1 | 5.87 | 17.84 | 22.58 | 30.17 | 0 | 4.00 |
| 100000 | userExactLookup | 1 | 5.83 | 17.58 | 26.41 | 31.26 | 0 | 4.00 |
| 100000 | sessionValidation | 1 | 5.83 | 21.99 | 29.51 | 42.29 | 0 | 5.00 |
| 100000 | sessionList | 1 | 5.83 | 20.43 | 29.30 | 41.66 | 0 | 5.00 |
| 100000 | applicationList | 1 | 5.83 | 18.04 | 25.85 | 33.23 | 0 | 4.00 |
| 100000 | applicationOrigin | 1 | 5.83 | 4.57 | 6.21 | 6.78 | 0 | 1.00 |
| 100000 | atomicRateLimit | 1 | 5.83 | 5.16 | 7.35 | 11.58 | 0 | 1.00 |
| 100000 | refreshProtocol | 1 | 5.83 | 41.05 | 53.69 | 62.34 | 0 | 10.00 |
| 100000 | userFirst | 10 | 6.27 | 174.58 | 214.58 | 270.43 | 0 | 4.00 |
| 100000 | userDeepSeek | 10 | 6.27 | 175.57 | 220.31 | 268.37 | 0 | 4.00 |
| 100000 | userExactLookup | 10 | 6.27 | 172.28 | 219.64 | 270.12 | 0 | 4.00 |
| 100000 | sessionValidation | 10 | 6.27 | 168.75 | 221.60 | 270.29 | 0 | 5.00 |
| 100000 | sessionList | 10 | 6.27 | 173.06 | 223.33 | 268.32 | 0 | 5.00 |
| 100000 | applicationList | 10 | 6.24 | 172.15 | 218.40 | 268.41 | 0 | 4.00 |
| 100000 | applicationOrigin | 10 | 6.24 | 169.25 | 215.62 | 264.60 | 0 | 1.00 |
| 100000 | atomicRateLimit | 10 | 6.24 | 176.01 | 224.16 | 273.06 | 0 | 1.00 |
| 100000 | refreshProtocol | 10 | 6.24 | 177.43 | 219.99 | 271.30 | 0 | 10.00 |
| 100000 | userFirst | 50 | 6.72 | 812.13 | 920.46 | 938.55 | 0 | 4.00 |
| 100000 | userDeepSeek | 50 | 6.82 | 815.26 | 906.00 | 931.95 | 0 | 4.00 |
| 100000 | userExactLookup | 50 | 6.95 | 835.16 | 917.45 | 933.21 | 0 | 4.00 |
| 100000 | sessionValidation | 50 | 6.72 | 837.35 | 1050.27 | 1120.91 | 0 | 5.00 |
| 100000 | sessionList | 50 | 6.72 | 845.70 | 1075.57 | 1120.94 | 0 | 5.00 |
| 100000 | applicationList | 50 | 6.69 | 837.92 | 1045.62 | 1112.54 | 0 | 4.00 |
| 100000 | applicationOrigin | 50 | 6.66 | 768.23 | 878.70 | 892.74 | 0 | 1.00 |
| 100000 | atomicRateLimit | 50 | 6.69 | 812.32 | 937.87 | 1073.12 | 0 | 1.00 |
| 100000 | refreshProtocol | 50 | 6.69 | 846.32 | 1051.90 | 1117.32 | 0 | 10.00 |
| 1000000 | userFirst | 1 | 4.93 | 18.61 | 61.50 | 71.15 | 0 | 4.00 |
| 1000000 | userDeepSeek | 1 | 4.93 | 19.05 | 52.39 | 68.94 | 0 | 4.00 |
| 1000000 | userExactLookup | 1 | 4.93 | 17.94 | 57.38 | 68.36 | 0 | 4.00 |
| 1000000 | sessionValidation | 1 | 4.93 | 22.07 | 69.30 | 76.07 | 0 | 5.00 |
| 1000000 | sessionList | 1 | 4.93 | 21.53 | 66.76 | 74.54 | 0 | 5.00 |
| 1000000 | applicationList | 1 | 4.93 | 17.49 | 48.30 | 64.68 | 0 | 4.00 |
| 1000000 | applicationOrigin | 1 | 4.90 | 4.53 | 6.80 | 8.15 | 0 | 1.00 |
| 1000000 | atomicRateLimit | 1 | 4.90 | 4.92 | 7.57 | 43.81 | 0 | 1.00 |
| 1000000 | refreshProtocol | 1 | 4.90 | 43.17 | 89.39 | 102.81 | 0 | 10.00 |
| 1000000 | userFirst | 10 | 5.59 | 189.19 | 282.68 | 302.64 | 0 | 4.00 |
| 1000000 | userDeepSeek | 10 | 5.59 | 192.92 | 274.40 | 312.83 | 0 | 4.00 |
| 1000000 | userExactLookup | 10 | 5.59 | 182.35 | 273.46 | 295.88 | 0 | 4.00 |
| 1000000 | sessionValidation | 10 | 5.59 | 194.85 | 294.64 | 400.33 | 0 | 5.00 |
| 1000000 | sessionList | 10 | 5.59 | 189.29 | 286.24 | 312.71 | 0 | 5.00 |
| 1000000 | applicationList | 10 | 5.56 | 192.34 | 276.19 | 345.56 | 0 | 4.00 |
| 1000000 | applicationOrigin | 10 | 5.56 | 174.62 | 266.71 | 298.64 | 0 | 1.00 |
| 1000000 | atomicRateLimit | 10 | 5.59 | 184.77 | 276.50 | 303.24 | 0 | 1.00 |
| 1000000 | refreshProtocol | 10 | 5.59 | 200.23 | 296.04 | 342.79 | 0 | 10.00 |
| 1000000 | userFirst | 50 | 6.54 | 860.59 | 984.33 | 1057.16 | 0 | 4.00 |
| 1000000 | userDeepSeek | 50 | 6.51 | 853.89 | 976.58 | 1049.92 | 0 | 4.00 |
| 1000000 | userExactLookup | 50 | 6.51 | 851.75 | 984.16 | 1045.66 | 0 | 4.00 |
| 1000000 | sessionValidation | 50 | 6.51 | 857.98 | 982.63 | 1051.09 | 0 | 5.00 |
| 1000000 | sessionList | 50 | 6.51 | 858.84 | 980.47 | 1049.89 | 0 | 5.00 |
| 1000000 | applicationList | 50 | 6.51 | 848.34 | 979.74 | 1043.58 | 0 | 4.00 |
| 1000000 | applicationOrigin | 50 | 6.51 | 804.74 | 916.93 | 1023.22 | 0 | 1.00 |
| 1000000 | atomicRateLimit | 50 | 6.51 | 852.21 | 976.67 | 1109.17 | 0 | 1.00 |
| 1000000 | refreshProtocol | 50 | 6.51 | 857.93 | 1005.82 | 1046.87 | 0 | 10.00 |

See [local-scale.json](local-scale.json) for fixture counts, query plans, database sizes, maintenance, snapshot restoration and methodology.

D1 billed rows_read: **unavailable**. Outbound requests blocked: 0.